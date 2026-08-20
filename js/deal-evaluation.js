/* ════════════════════════════════════════════════════════════════════════════
   MyTCG Ledger V6 - deal-evaluation.js
   ────────────────────────────────────────────────────────────────────────────
   DOMAIN MODULE (retrospective deal verdicts). The fourth and final Deals
   presentation slice. Deals is now: deal-log (form UI), deal-search
   (discovery), deal-rendering (presentation), deal-evaluation (verdicts) - with
   deal-persistence deliberately left inline as the mutation-heavy layer.

   WHY TWO FUNCTIONS ARE ONE DOMAIN (not an artificial boundary). They never
   call each other, and their consumers differ - which is exactly the trap a
   two-function module can fall into. They pass anyway because they share a DATA
   CONTRACT and a private vocabulary:
       saveDealEvaluation  computes the verdict and STAMPS deal.evalVerdict /
                           deal.evalScore
       dealVerdictBadge    READS that stamp and renders the pill
   The verdict strings good_buy / fair / overpaid / good_sale / sold_under /
   good_trade / bad_trade appear in these two functions and NOWHERE else in the
   project. Splitting them would put the producer and the only consumer of that
   vocabulary in different files.

   OWNS:
     saveDealEvaluation  scoring rules for purchase / sale / trade, the
                         confidence tiers, the evalVerdict/evalScore stamp, the
                         unchanged-skip guard, and the deal_evaluations insert
     dealVerdictBadge    the verdict pill markup

   TWO CORRECTIONS TO THE INHERITED GRAPH - both the "missed module edge" class
   the earlier batches warned about:
     1. Outbound was recorded as ZERO. It is not: saveDealEvaluation calls
        dbWrite(), which lives in analytics.js. The old scan only saw
        still-inline symbols.
     2. Mutation was recorded as NONE. saveDealEvaluation WRITES
        deal.evalVerdict and deal.evalScore onto the passed deal record. It does
        not push/splice deals[] and it does not persist - the surrounding
        save() inside saveDealLog does that. Pre-existing, moved unchanged.

   DOES NOT OWN: deal persistence/apply (saveDealLog stays inline and remains the
   caller), deal rendering, deal-log form state, deal search, intelligence
   (market signals are a separate concern with their own table), the analyzer,
   dbWrite itself, card detail, pricing, valuation, storage, sync.

   DATABASE: one insert into `deal_evaluations`, via analytics.js's dbWrite
   guard, and only when the verdict or score actually changed. Table, row shape,
   skip-if-unchanged behaviour and error handling are untouched.

   SCORING IS FROZEN: thresholds (>=10 / >=-5 for purchase, >=5 / >=-5 for sale
   and trade), the null/negative-tolerant num() coercion, the finalPrice
   fallback chains and the confidence tiers are moved byte-for-byte. No
   normalization, no rounding change, no verdict renaming.

   LOAD-TIME EXECUTION: none. Zero declarations, zero statements.

   CALL-TIME DEPENDENCIES:
     analytics  dbWrite
     inline     saveDealLog calls saveDealEvaluation at save time
     module     deal-rendering.js calls dealVerdictBadge from a render template
   ════════════════════════════════════════════════════════════════════════════ */

// ── Deal evaluation ────────────────────────────────────────────────────────
// Retrospective deal score — runs ONLY for CLOSED deals (saveDealLog status
// 'closed'); pending/open drafts are never scored. Compares what actually
// changed hands against market value, writes a verdict to deal_evaluations,
// and stamps the deal so renderDeals can badge it. Skips the DB write when the
// evaluation is unchanged from last time, so re-saving a deal doesn't duplicate.
function saveDealEvaluation(deal){
  if(!deal || deal.status !== 'closed') return;
  const type = deal.dealType || 'purchase';
  const num  = v => { const n = parseFloat(v); return (isFinite(n) && n >= 0) ? n : null; };

  let market, final, advantage, verdict;
  if(type === 'purchase'){
    market = num(deal.inTotal);                                         // market value of cards bought
    final  = num(deal.finalPrice) ?? num(deal.cashPaid) ?? num(deal.buyPrice);
    advantage = (market > 0 && final != null) ? ((market - final) / market) * 100 : null;
    verdict = advantage == null ? 'unknown' : advantage >= 10 ? 'good_buy' : advantage >= -5 ? 'fair' : 'overpaid';
  } else if(type === 'sale'){
    market = num(deal.outTotal);                                        // market value of cards sold
    final  = num(deal.finalPrice) ?? num(deal.sellPrice) ?? num(deal.inTotal);
    advantage = (market > 0 && final != null) ? ((final - market) / market) * 100 : null;
    verdict = advantage == null ? 'unknown' : advantage >= 5 ? 'good_sale' : advantage >= -5 ? 'fair' : 'sold_under';
  } else { // trade
    market = num(deal.outTotal);                                        // value you gave
    final  = num(deal.inTotal);                                         // value you got
    advantage = (market > 0 && final != null) ? ((final - market) / market) * 100 : null;
    verdict = advantage == null ? 'unknown' : advantage >= 5 ? 'good_trade' : advantage >= -5 ? 'fair' : 'bad_trade';
  }

  const confidence = (market > 0 && final != null) ? 'high' : (market > 0 || final != null) ? 'medium' : 'low';
  const score = (advantage != null && isFinite(advantage)) ? +advantage.toFixed(1) : null;

  // Stamp onto the deal (persisted by the surrounding save()) so renderDeals can
  // badge without recomputing. Skip the DB insert if nothing changed.
  const changed = deal.evalVerdict !== verdict || deal.evalScore !== score;
  deal.evalVerdict = verdict;
  deal.evalScore   = score;
  if(!changed) return;

  return dbWrite(async (db, user) => {
    const row = {
      user_id:      user.id,
      client_id:    deal.id || null,
      deal_type:    type,
      card_name:    deal.cardName || null,
      market_value: market != null ? +market.toFixed(2) : null,
      asking_price: num(deal.sellerAsk),
      my_offer:     num(deal.myOffer),
      final_price:  final != null ? +final.toFixed(2) : null,
      score:        (advantage != null && isFinite(advantage)) ? +advantage.toFixed(2) : null,
      verdict,
      confidence
    };
    const { error } = await db.from('deal_evaluations').insert(row);
    if(error) console.warn('[db] deal_evaluations insert error:', error.message);
  });
}

// Small verdict pill for the Deal Center (reads the stamp left by saveDealEvaluation).
function dealVerdictBadge(d){
  if(!d || !d.evalVerdict || d.evalVerdict === 'unknown') return '';
  const v    = d.evalVerdict;
  const good = /good_/.test(v);
  const bad  = /overpaid|sold_under|bad_trade/.test(v);
  const col  = good ? 'var(--green)' : bad ? 'var(--red)' : 'var(--gold)';
  const bg   = good ? 'rgba(46,204,128,0.12)' : bad ? 'rgba(255,77,109,0.12)' : 'rgba(245,200,66,0.12)';
  const pct  = (d.evalScore != null) ? ` ${d.evalScore>=0?'+':''}${d.evalScore}%` : '';
  return `<span style="display:inline-block;font-family:var(--mono);font-size:8px;font-weight:700;letter-spacing:.5px;color:${col};background:${bg};border:1px solid ${col};border-radius:4px;padding:1px 5px;margin-right:5px;vertical-align:middle;">${v.replace(/_/g,' ').toUpperCase()}${pct}</span>`;
}
