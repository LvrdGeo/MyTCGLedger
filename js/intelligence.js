/* ════════════════════════════════════════════════════════════════════════════
   MyTCG Ledger V6 - intelligence.js
   ────────────────────────────────────────────────────────────────────────────
   DOMAIN MODULE (market intelligence). Two source runs that ARE one domain -
   they were separated only by a physically interposed Deal-evaluation section
   (saveDealEvaluation / dealVerdictBadge), which stays inline for a future
   deals.js.

   OWNS:
     - config      SIGNAL_CFG (thresholds: overheatedPct/Days, liquidHigh/Med, rankCap)
     - scoring     signalConfidence
     - computation calculateMarketSignal - builds the signal set AND persists it
     - page        renderIntelligence

   All display helpers (confDot, toneCol, fmt, ofType) are BLOCK-LOCAL closures,
   not globals; nothing external can reach them.

   DOES NOT OWN: pricing acquisition (pricing.js), UVE routing
   (universal-valuation.js), valuation formulas (valuation.js), the dbWrite
   helper and every other database primitive (analytics.js), card history
   (storage.js), navigation (goPage stays inline), portfolio, dashboard, deals,
   search, CRUD.

   PERSISTENCE - unchanged, and NOT absorbed: calculateMarketSignal calls
   analytics.js's dbWrite() and performs ONE bulk upsert to `market_signals`
   with onConflict 'user_id,client_id,signal_type,signal_date'. Fire-and-forget,
   deduped by client_id|signal_type. Table, payload, conflict key, frequency and
   error handling are all untouched. Intelligence is product behaviour; the
   database helper stays infrastructure.

   KNOWN LAYERING SMELL - PRESERVED DELIBERATELY: pricing.js's loadAllPrices()
   calls calculateMarketSignal() at the end of every bulk refresh. Extraction
   makes that edge cross-module and therefore more visible. It is NOT rewired,
   retimed or removed - it remains exactly as it was.

   LOAD ORDER: placed after analytics.js and universal-valuation.js so its
   dbWrite / analyzePriceRouted dependencies are already defined, and before the
   inline block that defines goPage. pricing.js loads earlier and references
   calculateMarketSignal only at call time, which is safe.

   OUTBOUND (all CALL-time; the earlier "0 outbound" scan was incomplete):
     universal-valuation  analyzePriceRouted
     valuation            bestPrice, cardPriceData
     storage              getCardHistory
     analytics            dbWrite
     core                 esc, money
     inline               collection, and the #page-intelligence DOM

   INBOUND (all CALL-time): pricing.js -> calculateMarketSignal;
   inline goPage -> renderIntelligence. No reverse edges, no cycles.

   LOAD-TIME EXECUTION: none. One declaration (SIGNAL_CFG). No signal is
   computed, no market_signals row is written, nothing renders at load.
   ════════════════════════════════════════════════════════════════════════════ */

// ── Market signals ─────────────────────────────────────────────────────────
// Computes per-card intelligence from data already in memory: live cache price,
// cost basis, eBay comps (analyzePrice), and the LOCAL 7-day price history
// (cardHistory). Returns a categorized structure for the Intelligence page AND
// persists rows to market_signals (bulk, owned-only, one per card/type/day).
// Thresholds are the approved defaults — tune them here in one place.
const SIGNAL_CFG = { overheatedPct: 25, overheatedDays: 7, liquidHigh: 5, liquidMed: 2, rankCap: 50 };

function signalConfidence(priceConf, comps){
  const c = comps || 0;
  if(priceConf === 'high' && c >= SIGNAL_CFG.liquidHigh) return 'high';
  if((priceConf === 'high' || priceConf === 'medium') && c >= SIGNAL_CFG.liquidMed) return 'medium';
  return 'low';
}

function calculateMarketSignal(){
  const today = new Date().toISOString().slice(0,10);
  const rows = [];
  let priceSum = 0, priceN = 0;

  // Pass 1 — live metrics for every owned, priced card (live cache only).
  for(const card of collection){
    const data = cardPriceData(card);   // live cache only — signals need real comps
    if(!data) continue;
    const isG = card.type==='graded';
    const bp  = bestPrice(data, isG);
    if(!(bp > 0)) continue;
    const a       = analyzePriceRouted(data, isG);
    const comps   = parseInt(data.ebayN, 10) || 0;
    const paid    = parseFloat(card.paid);
    const qty     = card.qty || 1;
    const hasPaid = isFinite(paid) && paid > 0;
    const gain    = hasPaid ? (bp - paid) * qty : null;
    const gainPct = hasPaid ? ((bp - paid) / paid) * 100 : null;
    // 7-day baseline from LOCAL history, excluding today's point for fairness.
    const hist = getCardHistory(card, SIGNAL_CFG.overheatedDays).filter(p => p.d !== today && p.v > 0);
    const avg7 = hist.length ? hist.reduce((s,p)=>s+p.v,0)/hist.length : null;
    const overheatedPct = (avg7 && avg7 > 0) ? ((bp - avg7) / avg7) * 100 : null;
    rows.push({ card, bp, comps, paid, qty, hasPaid, gain, gainPct, conf: a.confidence, overheatedPct });
    priceSum += bp; priceN++;
  }

  const marketAverage = priceN ? priceSum / priceN : 0;
  const signals = [];
  const push = (r, signal_type, signal, score, metric_value, rationale) => signals.push({
    client_id: r.card.id, card_name: r.card.name || null,
    signal_type, signal,
    score:        (score!=null && isFinite(score)) ? +score.toFixed(2) : null,
    metric_value: (metric_value!=null && isFinite(metric_value)) ? +metric_value.toFixed(2) : null,
    confidence:   signalConfidence(r.conf, r.comps),
    rationale
  });

  // Pass 2 — derive signals.
  const gainers = [], losers = [], liquids = [], overheateds = [];
  for(const r of rows){
    const overheated = r.overheatedPct != null && r.overheatedPct > SIGNAL_CFG.overheatedPct;
    const inProfit   = r.gain != null && r.gain > 0;
    const liquid     = r.comps >= SIGNAL_CFG.liquidMed;

    let verdict = 'hold';
    if(overheated && inProfit)                            verdict = 'sell';
    else if(overheated && r.comps < SIGNAL_CFG.liquidMed) verdict = 'watch';
    else if(r.gainPct != null && r.gainPct < 0 && liquid) verdict = 'buy';

    const bits = [];
    if(r.gainPct != null) bits.push(`${r.gainPct>=0?'+':''}${r.gainPct.toFixed(1)}% vs cost`);
    bits.push(`${r.comps} comp${r.comps===1?'':'s'}`);
    if(overheated) bits.push(`+${r.overheatedPct.toFixed(0)}% over ${SIGNAL_CFG.overheatedDays}-day avg`);
    push(r, 'verdict', verdict, r.gainPct != null ? Math.abs(r.gainPct) : 0, r.gainPct, bits.join(' · '));

    if(r.hasPaid && r.bp < r.paid)
      push(r, 'below_cost', 'buy', -r.gainPct, r.gainPct, `Below cost: ${r.gainPct.toFixed(1)}%`);
    if(marketAverage > 0 && r.bp > marketAverage)
      push(r, 'above_market_average', 'watch', r.bp/marketAverage, r.bp, `$${r.bp.toFixed(2)} vs $${marketAverage.toFixed(2)} collection avg`);

    if(r.gainPct != null && r.gainPct > 0) gainers.push(r);
    if(r.gainPct != null && r.gainPct < 0) losers.push(r);
    if(r.comps >= SIGNAL_CFG.liquidHigh)   liquids.push(r);
    if(overheated)                         overheateds.push(r);
  }

  // Ranked categories (capped so "biggest/worst/most" stay meaningful).
  gainers.sort((a,b)=>b.gainPct-a.gainPct).slice(0, SIGNAL_CFG.rankCap)
    .forEach(r => push(r,'gainer','hold',r.gainPct,r.gainPct,`Up ${r.gainPct.toFixed(1)}% from cost`));
  losers.sort((a,b)=>a.gainPct-b.gainPct).slice(0, SIGNAL_CFG.rankCap)
    .forEach(r => push(r,'worst_performer','watch',-r.gainPct,r.gainPct,`Down ${Math.abs(r.gainPct).toFixed(1)}% from cost`));
  liquids.sort((a,b)=>b.comps-a.comps).slice(0, SIGNAL_CFG.rankCap)
    .forEach(r => push(r,'liquid','hold',r.comps,r.comps,`${r.comps} sold comps — highly liquid`));
  overheateds.sort((a,b)=>b.overheatedPct-a.overheatedPct).slice(0, SIGNAL_CFG.rankCap)
    .forEach(r => push(r,'overheated',(r.gain!=null&&r.gain>0)?'sell':'watch',r.overheatedPct,r.overheatedPct,`+${r.overheatedPct.toFixed(0)}% over ${SIGNAL_CFG.overheatedDays}-day avg`));

  // Persist — fire-and-forget, deduped by client_id+signal_type (a single upsert
  // can't touch the same conflict key twice). Owned items only (from collection).
  if(signals.length){
    dbWrite(async (db, user) => {
      const seen = new Set(), dbRows = [];
      for(const s of signals){
        const k = s.client_id + '|' + s.signal_type;
        if(seen.has(k)) continue; seen.add(k);
        dbRows.push({ user_id: user.id, signal_date: today, ...s });
      }
      const { error } = await db.from('market_signals').upsert(dbRows, { onConflict: 'user_id,client_id,signal_type,signal_date' });
      if(error) console.warn('[db] market_signals bulk upsert error:', error.message);
    });
  }

  // Categorized structure for the Intelligence page (live; no DB read needed).
  const ofType = t => signals.filter(s => s.signal_type === t);
  return {
    generatedAt: new Date().toISOString(),
    marketAverage,
    signals,
    byType: {
      best_buy:             ofType('verdict').filter(s=>s.signal==='buy').sort((a,b)=>b.score-a.score),
      overheated:           ofType('overheated'),
      liquid:               ofType('liquid'),
      worst_performer:      ofType('worst_performer'),
      gainer:               ofType('gainer'),
      below_cost:           ofType('below_cost').sort((a,b)=>b.score-a.score),
      above_market_average: ofType('above_market_average').sort((a,b)=>b.score-a.score)
    }
  };
}

// ── Intelligence page ──────────────────────────────────────────────────────
// Renders the seven views straight from calculateMarketSignal() (which also
// persists to market_signals). Works off the live price cache; sections with no
// data show a clear empty state rather than a fabricated entry.
function renderIntelligence(){
  const el = document.getElementById('intel-content');
  if(!el) return;
  const r = calculateMarketSignal();
  const fmt = (n) => '$' + (Number(n)||0).toFixed(2);
  const toneCol = (t) => t==='green' ? 'var(--green)' : t==='red' ? 'var(--red)' : 'var(--gold)';
  const confDot = (c) => {
    const col = c==='high' ? 'var(--green)' : c==='medium' ? 'var(--gold)' : 'var(--muted)';
    return `<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${col};flex-shrink:0;" title="${c||'low'} confidence"></span>`;
  };

  const sections = [
    { key:'best_buy',             title:'Best Buys',            sub:'below cost & liquid enough to act', tone:'green', metric:(s)=>`${s.score>=0?'+':''}${s.score}%` },
    { key:'below_cost',           title:'Below Cost',           sub:'market under what you paid',         tone:'red',   metric:(s)=>`${s.metric_value}%` },
    { key:'gainer',               title:'Biggest Gainers',      sub:'largest gain vs cost',               tone:'green', metric:(s)=>`+${s.metric_value}%` },
    { key:'worst_performer',      title:'Worst Performers',     sub:'largest loss vs cost',               tone:'red',   metric:(s)=>`${s.metric_value}%` },
    { key:'overheated',           title:'Overheated',           sub:`price spiking vs ${SIGNAL_CFG.overheatedDays}-day avg`, tone:'gold', metric:(s)=>`+${s.metric_value}%` },
    { key:'liquid',               title:'Most Liquid',          sub:'most sold comps — easiest to move',  tone:'gold',  metric:(s)=>`${s.metric_value} comps` },
    { key:'above_market_average', title:'Above Collection Avg', sub:`vs ${fmt(r.marketAverage)} average`, tone:'gold',  metric:(s)=>fmt(s.metric_value) },
  ];

  if(!r.signals.length){
    el.innerHTML = `<div style="color:var(--muted);font-size:13px;background:var(--bg2);border:1px solid var(--border);border-radius:var(--r2);padding:16px;">No signals yet. Refresh prices on your collection (Dashboard or Portfolio) to generate intelligence.</div>`;
    return;
  }

  let html = '';
  for(const sec of sections){
    const all = r.byType[sec.key] || [];
    const items = all.slice(0, 8);
    html += `<div style="margin-bottom:22px;">
      <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:8px;">
        <div style="font-size:14px;font-weight:700;color:var(--text);">${sec.title}</div>
        <div style="font-size:10px;color:var(--muted);">${sec.sub}</div>
        <div style="margin-left:auto;font-family:var(--mono);font-size:10px;color:var(--muted);">${all.length}</div>
      </div>`;
    if(!items.length){
      const empty = sec.key==='overheated'
        ? `Builds as price history accumulates — needs a few days of snapshots.`
        : `Nothing here right now.`;
      html += `<div style="font-size:11px;color:var(--muted);background:var(--bg2);border:1px solid var(--border);border-radius:var(--r2);padding:12px 14px;">${empty}</div>`;
    } else {
      html += items.map(s => `
        <div style="display:flex;align-items:center;gap:10px;background:var(--bg2);border:1px solid var(--border);border-radius:var(--r2);padding:9px 12px;margin-bottom:6px;">
          <div style="flex:1;min-width:0;">
            <div style="font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${s.card_name||'—'}</div>
            <div style="font-size:10px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${s.rationale||''}</div>
          </div>
          ${confDot(s.confidence)}
          <div style="font-family:var(--mono);font-size:13px;font-weight:700;color:${toneCol(sec.tone)};flex-shrink:0;">${sec.metric(s)}</div>
        </div>`).join('');
    }
    html += `</div>`;
  }
  el.innerHTML = html;
}
