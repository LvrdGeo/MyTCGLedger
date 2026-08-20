/* ════════════════════════════════════════════════════════════════════════════
   MyTCG Ledger V6 - card-detail.js
   ────────────────────────────────────────────────────────────────────────────
   DOMAIN MODULE (card inspection). The whole "═══ DETAIL VIEW ═══" section, one
   contiguous run. It sits at the intersection of pricing, evidence, inventory,
   CRUD and external listings - and CONSUMES all of them rather than owning them.

   OWNS:
     - detail modal     openDetail
     - evidence         evxFilter, buildEvidenceExplorer, buildPricingEvidence
     - active listings  loadActiveListings  (Worker /active, graded filter)
     - trend            buildCardTrendBlock, _cardTrendChart,
                        renderCardTrendChart, renderSparklineSVG
     - reprice action   repriceCard
     - dormant          simulateEbaySales

   DOES NOT OWN:
     - ebayCardQuery / jpSearchTerms: query builders living in the search region;
       jpSearchTerms also feeds jpEnSetName. Shared - left inline so that
       search never depends on card-detail.
     - cards-crud (editCard / delCard are call-time handoffs), cost-editor
       (startEditCost), wishlist (moveWishToVault), pricing (fetchLivePrices,
       analyzePriceRouted / the UVE), valuation, storage, sync, identity,
       sealed, portfolio, dashboard, collection-views, scanner, deals.

   BATCH 11 CONTRACT: loadActiveListings keeps the repaired grader regex
   /\bpsa\b|\bbgs\b|\bcgc\b|\bsgc\b/i byte-for-byte. The U+0008 corruption
   must never reappear here.

   NESTING NOTE: loadActiveListings is a SIBLING of openDetail in this section,
   not nested inside it, so extraction required no scope change whatsoever.

   DEPENDENCY DIRECTION - clean, and verified: FOUR extracted modules call
   openDetail (portfolio, collection-views, dashboard, wishlist), plus inline
   openInventoryPanel / openDealCardDetail and generated templates. This file
   calls back into ZERO extracted modules, so there is no cycle in either
   direction.

   STATE: read/presentation only. It mutates no collection, sealed, wishlist,
   soldHistory, deals, liqCache, AppState or deletion-ledger state. repriceCard
   deletes one price-cache entry (pre-existing) before reopening the modal.

   LOAD-TIME DEPENDENCIES: none. One declaration (_cardTrendChart).

   CALL-TIME DEPENDENCIES:
     core       esc, money, moneyFull, toast, openModal, closeModal
     valuation  cardValue, cacheKey, cardPriceData, bestPrice, editionBadge
     storage    idbDelete
     inline     collection, pcache, EBAY_WORKER, analyzePriceRouted, fmtPrice,
                ebayCardQuery, jpSearchTerms, dealPickCard, editCard, delCard,
                startEditCost, moveWishToVault, Chart (CDN), #detail-modal markup
   ════════════════════════════════════════════════════════════════════════════ */

// ═══ DETAIL VIEW ═══

async function repriceCard(id){
  const card = collection.find(c=>c.id===id);
  if(card){ try{ delete pcache[cacheKey(card)]; idbDelete(cacheKey(card)); }catch(e){} }
  closeModal('detail-modal');
  setTimeout(()=>openDetail(id), 60);
}
// ── Evidence Explorer · UI-only (2026-07) ──
// Renders beneath the Pricing Evidence card from EXISTING data only:
// accepted = p.ebay_sales (comps used in pricing, incl. title/date/url),
// rejected = p.rejected (v16 Worker evidence ledger, {title,price,reason}).
// Grade detection and reason color-coding are display-only parses. No pricing
// read-modifies, no fetches, no writes. Rollback: delete this function, the
// evxFilter helper, the .evx-* CSS block, and its term in the openDetail call site.
function evxFilter(btn){
  const sec = btn.closest('.evx-sec'); if(!sec) return;
  sec.querySelectorAll('.evx-chip').forEach(c=>c.classList.toggle('evx-chip-on', c===btn));
  const k = btn.dataset.k, v = btn.dataset.v;
  sec.querySelectorAll('.evx-item').forEach(el=>{ el.style.display = (v==='all' || el.dataset[k]===v) ? '' : 'none'; });
}
function buildEvidenceExplorer(card, p){
  const accepted = (p.ebay_sales||[]).filter(s=>s && s.price>0);
  const rejected = Array.isArray(p.rejected) ? p.rejected : [];
  if(!accepted.length && !rejected.length) return '';
  const eb = ebaySrcLabel(p);
  const srcLbl = eb.ask ? 'eBay Asks (active)' : 'eBay Solds';
  const gradeOf = t => { const m = String(t||'').match(/\b(psa|bgs|cgc|sgc|ace)\s*(10|[0-9](?:\.5)?)\b/i); return m ? (m[1].toUpperCase()+' '+m[2]) : null; };
  const reasonClass = r => {
    const x = String(r||'').toLowerCase();
    if(/wrong_set|wrong_number|wrong_or_missing_grade|no_grade_token|wrong_rarity_tier|wrong_type|wrong_lang/.test(x)) return 'evx-c-gold';
    if(/outlier|high_skew|stale/.test(x)) return 'evx-c-purple';
    if(/no_title|no_or_invalid|filtered|unknown/.test(x)) return 'evx-c-muted';
    return 'evx-c-red';
  };
  const reasonLbl = r => String(r||'unspecified').replace(/_/g,' ');
  const money = v => '$'+Math.round(+v).toLocaleString('en-US');
  const itemCard = (title, price, date, reason, cls, url, grade) => `
    <div class="evx-item" data-reason="${evxEsc(reason)}" data-grade="${evxEsc(grade||'')}">
      <div class="evx-title">${evxEsc(title)||'(no title)'}</div>
      <div class="evx-row">
        ${price!=null?`<span class="evx-price">${money(price)}</span>`:''}
        ${date?`<span class="evx-meta">${evxEsc(date)}</span>`:''}
        ${grade?`<span class="evx-pill evx-c-green" style="color:var(--text);background:var(--bg3);border-color:var(--border);">${evxEsc(grade)}</span>`:''}
        <span class="evx-pill ${cls}">${evxEsc(reasonLbl(reason))}</span>
        <span class="evx-meta">${srcLbl}</span>
        ${url?`<a class="evx-link" href="${evxEsc(url)}" target="_blank" rel="noopener">View \u2197</a>`:''}
      </div>
    </div>`;
  // Accepted section — grade chips when >1 distinct detected grade
  const accRows = accepted.map(s=>{
    const g = gradeOf(s.title) || (card.grade||null);
    return itemCard(s.title||'(title unavailable \u2014 older cache entry)', s.price, s.date, 'used_in_pricing', 'evx-c-green', s.url, g);
  }).join('');
  const accGrades = [...new Set(accepted.map(s=>gradeOf(s.title)||(card.grade||'')).filter(Boolean))];
  const accChips = accGrades.length>1
    ? `<div class="evx-chips"><button class="evx-chip evx-chip-on" data-k="grade" data-v="all" onclick="evxFilter(this)">All</button>${accGrades.map(g=>`<button class="evx-chip" data-k="grade" data-v="${evxEsc(g)}" onclick="evxFilter(this)">${evxEsc(g)}</button>`).join('')}</div>` : '';
  // Rejected section — reason chips
  const rejRows = rejected.map(r=>itemCard(r.title, r.price, r.date, r.reason||'unspecified', reasonClass(r.reason), r.url, gradeOf(r.title))).join('');
  const rejReasons = [...new Set(rejected.map(r=>r.reason||'unspecified'))];
  const rejChips = rejReasons.length>1
    ? `<div class="evx-chips"><button class="evx-chip evx-chip-on" data-k="reason" data-v="all" onclick="evxFilter(this)">All</button>${rejReasons.map(r=>`<button class="evx-chip" data-k="reason" data-v="${evxEsc(r)}" onclick="evxFilter(this)">${evxEsc(reasonLbl(r))}</button>`).join('')}</div>` : '';
  const rejNote = (p.counts && p.counts.rejected > rejected.length)
    ? `<div class="evx-empty">showing ${rejected.length} of ${p.counts.rejected} rejections (Worker caps the ledger at 10)</div>` : '';
  return `
    <details class="evx-sec"${accepted.length?'':' style="display:none;"'}>
      <summary><span class="evx-st">Accepted Evidence</span><span class="evx-count">${accepted.length} comp${accepted.length===1?'':'s'}</span></summary>
      <div class="evx-body">${accChips}<div class="evx-list">${accRows}</div></div>
    </details>
    <details class="evx-sec"${rejected.length?'':' style="display:none;"'}>
      <summary><span class="evx-st">Rejected Evidence</span><span class="evx-count">${rejected.length}${(p.counts&&p.counts.rejected>rejected.length)?' of '+p.counts.rejected:''}</span></summary>
      <div class="evx-body">${rejChips}${rejNote}<div class="evx-list">${rejRows}</div></div>
    </details>`;
}
// ── Pricing Evidence card · v2 (UI-only · 2026-07) ──
// Displays EXISTING data only: card.type/grade/cardId, p.tcg/ebay/ppt/psa/ebayN/
// ebay_sales/ebaySource/unverified/_diag, the pcache timestamp (read-only), the
// synced lastPriced* stamps, and the same analyzePriceRouted() read openDetail
// already performs one line later (pure function, verified — no state touched).
// No pricing value is computed or altered here; no fetches; no writes.
// Rollback: restore v1 of this function (index.html.bak2 / git history).
function buildPricingEvidence(card, p){
  const money = v => (v!=null && isFinite(v) && v>0) ? '$'+(+v).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}) : null;
  const typeLbl = card.type==='graded' ? 'Graded' : card.type==='sealed' ? 'Sealed' : 'Raw';
  const eb = ebaySrcLabel(p);
  const diagRaw = p._diag || '';
  const isGraded = card.type==='graded';
  // Same pure read openDetail makes for the confidence banner — display only.
  let pa = null; try { pa = analyzePriceRouted(p, isGraded); } catch(_){}
  // Cache freshness — pure read of the existing cache entry / synced stamp.
  let pricedAt = null, pricedVia = '';
  try {
    const e = cardPriceEntry(card);
    if (e && e.ts) { pricedAt = e.ts; pricedVia = 'live cache'; }
    else if (card.lastPricedAt) { pricedAt = card.lastPricedAt; pricedVia = 'synced stamp'; }
  } catch(_){}
  const ageStr = ts => {
    const m = Math.max(0, Math.round((Date.now()-ts)/60000));
    return m < 1 ? 'just now' : m < 60 ? m+'m ago' : m < 1440 ? Math.round(m/60)+'h ago' : Math.round(m/1440)+'d ago';
  };
  // Display-only parse of the fetch log (log itself rendered verbatim in Advanced Debug)
  const gm = diagRaw.match(/\/graded:(\$[\d.,]+|empty)/);
  const sm = diagRaw.match(/\/sold:\d+i(=\$[\d.,]+)?/);
  const endpoint = gm ? '/graded' : (sm ? '/sold' : null);
  const returned = gm && gm[1] !== 'empty' ? gm[1] : (sm && sm[1] ? sm[1].slice(1) : null);
  const srcVals = [p.tcg, p.ebay, p.psa, p.ppt];
  const have = srcVals.filter(v => v>0).length;
  const status = !diagRaw ? { t:'cached',  c:'var(--muted2)' }
    : have===0             ? { t:'empty',   c:'var(--red)' }
    : have<srcVals.length  ? { t:'partial', c:'var(--gold)' }
    :                        { t:'success', c:'var(--green)' };
  const srcRow = (lbl, v) => {
    const m = money(v);
    return `<div class="ev-src"><div class="ev-lbl">${lbl}</div><div class="ev-val${m?'':' ev-none'}">${m||'unavailable'}</div></div>`;
  };
  const hasEbay = p.ebay>0 || p.psa>0 || (p.ebay_sales&&p.ebay_sales.length);
  const srcChip = hasEbay ? `<span class="ev-chip ${eb.ask?'ev-chip-ask':'ev-chip-sold'}">${eb.ask?'ASKS':'SOLDS'}</span>` : '';
  const compsBlock = (p.ebay_sales && p.ebay_sales.length)
    ? `<div><div class="ev-lbl">Comps used · ${p.ebayN||p.ebay_sales.length} ${eb.ask?'active asks':'sold comps'}</div><div class="ev-pills">${p.ebay_sales.map(s=>{
        const inner = `$${Math.round(s.price).toLocaleString('en-US')}${s.date?`<span class="ev-pill-date"> · ${s.date}</span>`:''}`;
        return s.url ? `<a class="ev-pill ev-pill-link" href="${esc(s.url)}" target="_blank" rel="noopener">${inner} \u2197</a>`
                     : `<span class="ev-pill">${inner}</span>`;
      }).join('')}</div></div>`
    : '';
  const unverifiedRow = p.unverified
    ? `<div class="ev-warn">\u26a0 Identity unverified \u2014 the resolved card number did not match this card during the last fetch. Prices may belong to a different printing.</div>`
    : '';
  const basisRow = (pa && pa.reason)
    ? `<div class="ev-src" style="grid-column:1/-1;"><div class="ev-lbl">Valuation basis \u00b7 ${pa.confidence||''} confidence</div><div class="ev-val" style="font-weight:400;font-size:11px;color:var(--muted2);">${pa.reason}</div></div>`
    : '';
  // Per-comp title lines — titles are now retained by the ebay_sales mapping.
  // Older cache entries (pre-title) simply have no title field and render nothing.
  const compTitleRows = (p.ebay_sales||[])
    .filter(s => s.title)
    .map(s => `<div>comp \u00b7 $${Math.round(s.price).toLocaleString('en-US')}${s.date?(' \u00b7 '+s.date):''} \u00b7 ${esc(String(s.title).slice(0,80))}${String(s.title).length>80?'\u2026':''}</div>`)
    .join('');
  // DORMANT: rejected-comp evidence ledger for singles/graded. The Worker does not
  // send p.rejected yet (spec: worker-changes-spec.md). Renders nothing until it does.
  const rejectedRows = (Array.isArray(p.rejected) && p.rejected.length)
    ? p.rejected.slice(0,10).map(r => `<div style="color:var(--red);">rejected \u00b7 ${r.price!=null?('$'+Math.round(r.price).toLocaleString('en-US')+' \u00b7 '):''}${esc(r.reason||'unspecified')}${r.title?(' \u00b7 '+esc(String(r.title).slice(0,60))):''}</div>`).join('')
    : '';
  const advRows = [
    diagRaw ? null : '(cached \u2014 tap Re-fetch for a live fetch log)',
    diagRaw || null,
    p.ebaySource ? 'ebay source: '+p.ebaySource : null,
    p.premiumVintage ? 'premium vintage edition: eBay-led pricing' : null,
    (p.trend7!=null) ? 'trend7: '+p.trend7+'%' : null,
    card.lastPriceSource ? 'synced stamp: '+(card.lastMarketValue!=null?('$'+card.lastMarketValue+' \u00b7 '):'')+card.lastPriceSource+(card.lastPriceConfidence?(' \u00b7 '+card.lastPriceConfidence):'') : null,
  ].filter(Boolean).map(r=>`<div>${r}</div>`).join('') + compTitleRows + rejectedRows;
  return `<div class="ev-card">
    <div class="ev-hd"><span class="ev-title">Pricing Evidence${srcChip}</span><button class="ev-refetch" onclick="repriceCard('${card.id}')">\u21bb Re-fetch</button></div>
    ${unverifiedRow}
    <div class="ev-meta">
      <div class="ev-src"><div class="ev-lbl">Valuation type</div><div class="ev-val">${typeLbl}</div></div>
      <div class="ev-src"><div class="ev-lbl">Item identity</div><div class="ev-val ev-mono">${card.cardId||'unresolved'}</div></div>
      ${card.grade?`<div class="ev-src"><div class="ev-lbl">Grade</div><div class="ev-val">${esc(card.grade)}</div></div>`:''}
      <div class="ev-src"><div class="ev-lbl">Evidence</div><div class="ev-val${(p.ebayN||0)?'':' ev-none'}">${(p.counts&&p.counts.fetched)?(p.counts.accepted+' of '+p.counts.fetched+' listings used'):((p.ebayN||0)?(p.ebayN+' comp'+(p.ebayN>1?'s':'')+' used'):'no comps')}</div></div>
    </div>
    <div class="ev-meta">
      ${srcRow('TCGPlayer', p.tcg)}
      ${srcRow(eb.label, p.ebay)}
      ${srcRow('PSA Market', p.psa)}
      ${srcRow('PokePrice', p.ppt)}
    </div>
    <div class="ev-meta">
      <div class="ev-src"><div class="ev-lbl">Fetch status</div><div class="ev-val" style="color:${status.c};">${status.t}</div></div>
      ${endpoint?`<div class="ev-src"><div class="ev-lbl">Endpoint</div><div class="ev-val ev-mono">${endpoint}${returned?' \u2192 '+returned:''}</div></div>`:''}
      ${pricedAt?`<div class="ev-src"><div class="ev-lbl">Freshness</div><div class="ev-val">${ageStr(pricedAt)}<span class="ev-pill-date"> \u00b7 ${pricedVia}</span></div></div>`:''}
      ${basisRow}
    </div>
    ${compsBlock}
    <details class="ev-adv"><summary>Advanced Debug</summary><div class="ev-log">${advRows}</div></details>
  </div>`;
}

async function openDetail(id){
  const card=collection.find(c=>c.id===id)||((window._detailTransient&&window._detailTransient.id===id)?window._detailTransient:null);if(!card)return;
  const p=cardPriceData(card)||await getPrices(card);
  const best=bestPrice(p,card.type==='graded'),worst=worstPrice(p);
  const priceAnalysis=analyzePriceRouted(p,card.type==='graded');
  const roi=card.paid?(best-parseFloat(card.paid)):null;
  const roiPct=card.paid&&best>0?((best/parseFloat(card.paid)-1)*100).toFixed(1):null;
  // Sparkline
  const histSeries=getCardHistory(card,30);const trendBlock=buildCardTrendBlock(card,histSeries,best);
  // Build precise search strings including set name + number for each platform
  const nameNum  = [card.name, card.num].filter(Boolean).join(' ');
  const nameSet  = [card.name, card.set].filter(Boolean).join(' ');
  const _isJP    = card.lang === 'JP';
  // JP cards: the Japanese set name breaks English-market search, so swap in the
  // English equivalent + "Japanese" (which is how these are actually listed).
  const full     = _isJP ? jpSearchTerms(card)
                         : [card.name, card.num, card.set].filter(Boolean).join(' ');
  const fullGrade= _isJP ? [jpSearchTerms(card), card.grade].filter(Boolean).join(' ')
                         : [card.name, editionSearchTerm(card), card.num, card.set, card.grade].filter(Boolean).join(' ');
  const tcgQ  = encodeURIComponent(full);
  const pcQ   = encodeURIComponent(full);
  const ebayQ = encodeURIComponent(ebayCardQuery(card));
  const ebayGradeQ = encodeURIComponent(ebayCardQuery(card, card.grade || 'PSA 10'));
  // Real sold comps ONLY. This previously fell back to simulateEbaySales(best),
  // which invented five comps with random dates and prices and rendered them in the
  // "eBay Recent Sold" list marked "~est" — fabricated market evidence in a section
  // the user reads as fact. No comps now renders an honest empty state instead.
  // (Display only: these rows never fed the pricing engine, so no price changes.)
  const rawSales = p.ebay_sales?.length ? p.ebay_sales : [];
  const eSales = !rawSales.length
    ? `<div style="font-size:12px;color:var(--muted);padding:8px 0;line-height:1.6;">No recent sold comps found for this card.<br><span style="font-size:11px;color:var(--muted2);">Check the eBay Sold link below for the live market.</span></div>`
    : rawSales.map(s => {
    const isReal = !!s.url;
    const dateStr = s.date || 'Recent';
    const condStr = s.condition || s.cond || card.cond;
    const priceStr = fmtPrice(s.price || s.amount);
    return `<div class="ebay-sale">
      <span style="color:var(--muted2);font-family:var(--mono);font-size:11px;">${esc(dateStr)}</span>
      <span style="color:var(--muted2);">${esc(condStr)}</span>
      <span style="font-family:var(--mono);font-weight:500;${isReal?'color:var(--green);':''}">${priceStr}</span>
      ${isReal ? `<a href="${esc(s.url)}" target="_blank" style="font-size:10px;color:var(--blue);text-decoration:none;">↗</a>` : '<span style="font-size:9px;color:var(--muted);font-family:var(--mono);">~est</span>'}
    </div>`;
  }).join('');
  document.getElementById('detail-inner').innerHTML=`
    <div class="modal-hd"><h2>${esc(card.name)}</h2><button class="modal-close" onclick="closeModal('detail-modal')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></div>
    <div class="modal-body">
      <div style="display:flex;gap:16px;margin-bottom:18px;align-items:flex-start;">
        <div style="width:110px;flex-shrink:0;border-radius:10px;overflow:hidden;background:var(--bg3);">${(p.img||card.img)?`<img src="${esc(p.img||card.img)}" alt="${esc(card.name)}" style="width:100%;display:block;">`:'<div style="aspect-ratio:3/4;display:flex;align-items:center;justify-content:center;font-size:28px;color:var(--muted);">⟡</div>'}</div>
        <div style="flex:1;min-width:0;">
          <div style="display:flex;gap:5px;flex-wrap:wrap;margin-bottom:7px;"><span class="ct-badge type-${esc(card.type)}">${esc(card.type)}</span><span class="ct-badge cond-${esc(card.cond)}">${esc(card.cond)}</span>${card.grade?`<span class="ct-badge type-graded">${esc(card.grade)}</span>`:''}${editionBadge(card)}</div>
          <div style="font-family:var(--disp);font-size:20px;font-weight:800;margin-bottom:2px;">${esc(card.name)}</div>
          <div style="font-size:12px;color:var(--muted2);margin-bottom:12px;">
            ${card.set?`<span style="background:var(--bg3);border:1px solid var(--border);padding:2px 8px;border-radius:5px;font-size:11px;font-family:var(--mono);">${esc(card.set)}</span> `:''}
            ${card.num?`<span style="color:var(--muted2);">#${esc(card.num)}</span> `:''}
            ${card.qty>1?`<span style="color:var(--muted2);">× ${card.qty}</span>`:''}
          </div>
          <div class="mini-stats">
            <div class="mini-stat"><div class="mini-stat-lbl">Best Price</div><div class="mini-stat-val" style="color:var(--green)">${fmtPrice(best)}</div></div>
            <div class="mini-stat" style="position:relative;${card._transient?'':'cursor:pointer;'}" ${card._transient?'':`onclick="startEditCost('${card.id}')" title="Click to edit cost basis"`}>
              <div class="mini-stat-lbl" style="display:flex;align-items:center;justify-content:space-between;">
                COST BASIS
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:10px;height:10px;color:var(--muted);opacity:.6;"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
              </div>
              <div id="cost-display-${card.id}" class="mini-stat-val" style="color:var(--gold);">
                ${card.paid ? '$'+parseFloat(card.paid).toFixed(2) : '<span style="color:var(--muted);font-size:12px;">+ Add</span>'}
              </div>
            </div>
            <div class="mini-stat"><div class="mini-stat-lbl">GAIN / LOSS</div><div class="mini-stat-val" style="color:${roi!=null?(roi>=0?'var(--green)':'var(--red)'):'var(--muted)'};">${roi!=null?(roi>=0?'+':'')+'$'+roi.toFixed(2)+' ('+roiPct+'%)':'—'}</div></div>
            <div class="mini-stat"><div class="mini-stat-lbl">Spread</div><div class="mini-stat-val">${isFinite(worst)&&worst>0?'$'+(worst-best).toFixed(2):'—'}</div></div>
          </div>
        </div>
      </div>
      ${trendBlock}
      ${/* Pricing Evidence (UI-only revamp of raw diag · 2026-07). Rollback: restore the original inline diag template here (see git history / index.html.bak). */''}${(card.grade||card.type==='graded')?(buildPricingEvidence(card,p)+buildEvidenceExplorer(card,p)):''}
      ${priceAnalysis.confidence&&priceAnalysis.confidence!=='none'?`<div style="margin-bottom:14px;padding:10px 12px;border-radius:var(--r);background:${priceAnalysis.confidence==='high'?'rgba(46,204,128,0.08)':priceAnalysis.confidence==='medium'?'rgba(245,200,66,0.08)':'rgba(255,77,109,0.08)'};border:1px solid ${priceAnalysis.confidence==='high'?'rgba(46,204,128,0.25)':priceAnalysis.confidence==='medium'?'rgba(245,200,66,0.25)':'rgba(255,77,109,0.25)'};"><div style="display:flex;align-items:center;gap:7px;"><span style="font-size:13px;">${priceAnalysis.confidence==='high'?'✓':priceAnalysis.confidence==='medium'?'⚠️':'⚠️'}</span><div><div style="font-size:11px;font-weight:700;color:${priceAnalysis.confidence==='high'?'var(--green)':priceAnalysis.confidence==='medium'?'var(--gold)':'var(--red)'};text-transform:uppercase;letter-spacing:.5px;font-family:var(--mono);">${priceAnalysis.confidence} confidence</div><div style="font-size:11px;color:var(--muted);margin-top:1px;">${priceAnalysis.reason}</div></div></div></div>`:''}${(()=>{const r=nrvForCard(card,best);if(r.realizable==null)return '';const b=r.breakdown;const discAmt=b.market-b.gross;const taxRow=b.tax>0?`<div style="display:flex;justify-content:space-between;"><span>Tax on gain</span><span>−${moneyFull(b.tax)}</span></div>`:'';return `<div style="margin-bottom:18px;"><details><summary style="list-style:none;cursor:pointer;display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-radius:var(--r);background:rgba(46,204,128,0.06);border:1px solid rgba(46,204,128,0.18);"><span style="font-size:11px;font-weight:700;color:var(--green);text-transform:uppercase;letter-spacing:.5px;font-family:var(--mono);">Realizable Value</span><span style="font-family:var(--mono);font-weight:700;color:${r.sellable?'var(--green)':'var(--muted)'};">${r.sellable?moneyFull(r.realizable):'Below sale cost'}</span></summary><div style="padding:10px 12px 2px;font-size:12px;color:var(--muted);display:flex;flex-direction:column;gap:4px;"><div style="display:flex;justify-content:space-between;"><span>Market</span><span>${moneyFull(b.market)}</span></div><div style="display:flex;justify-content:space-between;"><span>Expected-sale discount (${Math.round(b.disc*100)}%)</span><span>−${moneyFull(discAmt)}</span></div><div style="display:flex;justify-content:space-between;"><span>eBay fees</span><span>−${moneyFull(b.fees)}</span></div><div style="display:flex;justify-content:space-between;"><span>Shipping</span><span>−${moneyFull(b.shipping)}</span></div>${taxRow}<div style="display:flex;justify-content:space-between;border-top:1px solid var(--border);padding-top:5px;margin-top:2px;color:var(--text);font-weight:600;"><span>Realizable</span><span>${moneyFull(r.realizable)}</span></div><div style="font-size:10px;color:var(--muted2);margin-top:5px;">Net after discount, eBay fees & shipping · tune in Settings → Realizable Value</div></div></details></div>`;})()}<div style="margin-bottom:18px;"><div class="sec-title-sm">Live Price Comparison</div>${SOURCES.every(s=>!p[s.k])&&!card.grade?`<div style="padding:14px;border:1px solid var(--border);border-radius:var(--r);background:var(--bg2);font-size:12px;color:var(--muted);line-height:1.6;">No price data returned for this card yet.<br><span style="font-size:11px;color:var(--muted2);">This usually means the price lookup failed or hasn't run. Card catalogue outages resolve on their own.</span><br><button class="ev-refetch" style="margin-top:9px;" onclick="repriceCard('${card.id}')">\u21bb Re-fetch prices</button></div>`:''}<div class="price-sources-grid">${SOURCES.map(s=>{const v=p[s.k];if(!v)return'';const isBest=v===best;return `<div class="psrc"><div class="psrc-name"><span class="ps-bullet" style="background:${s.color};width:6px;height:6px;border-radius:50%;display:inline-block"></span>${s.k==='ebay'?ebaySrcLabel(p).label:s.label}${isBest?' ✓':''}</div><div class="psrc-price ${isBest?'best-src':''}">${fmtPrice(v)}</div><div class="psrc-sub">${s.k==='tcg'?(card.lang==='JP'?'English-card market · reference only':'Market price · most accurate'):s.k==='ebay'?ebaySrcLabel(p).sub:s.k==='ppt'?(card.grade?'Raw ungraded \u00b7 not this grade':'Raw ungraded market'):s.k==='psa'?card.grade||'Graded':''}</div></div>`;}).join('')}${card.grade?`<div class="psrc" style="border:1px solid rgba(245,200,66,.25);background:rgba(245,200,66,.05);"><div class="psrc-name"><span class="ps-bullet" style="background:var(--gold);width:6px;height:6px;border-radius:50%;display:inline-block"></span>${card.grade}</div><div class="psrc-price" style="color:var(--gold);">${fmtPrice(p.psa)}</div><div class="psrc-sub">${ebaySrcLabel(p).ask?'eBay active asks \u2014 no solds found':'eBay graded comps'}</div><a href="https://www.ebay.com/sch/i.html?_nkw=${ebayGradeQ}&LH_Sold=1&LH_Complete=1" target="_blank" style="display:inline-block;margin-top:7px;font-size:11px;color:var(--gold);text-decoration:none;">View sold →</a></div>`:''}</div></div>
      ${card.grade?`<div style="margin-bottom:18px;"><div class="sec-title-sm">PSA Population Report</div><div style="background:var(--bg3);border-radius:var(--r);padding:12px 14px;"><div class="psa-row">${[7,8,9,9.5,10].map(g=>`<div class="psa-cell${card.grade&&parseFloat((card.grade.match(/[\d.]+/)||['0'])[0])===g?' hl':''}"><div class="psa-gnum">${g}</div><div class="psa-gprice">—</div></div>`).join('')}</div><div style="font-size:11px;color:var(--muted);margin-top:8px;">Pop data when eBay API connected. <a href="https://www.psacard.com/pop" target="_blank" style="color:var(--blue);">PSA Pop →</a></div></div></div>`:''}
      ${card.type==='graded'&&card.grade?`<div style="margin-bottom:18px;"><div class="sec-title-sm" style="display:flex;align-items:center;justify-content:space-between;">eBay Active Listings<span style="font-size:10px;color:var(--muted);font-family:var(--mono);font-weight:400;">${card.grade} · Live</span></div><div class="active-listings-panel" id="al-panel-${card.id}"><div class="al-loading"><div class="spinner" style="width:10px;height:10px;border-width:1.5px;"></div>Fetching active listings…</div></div></div>`:''}
      ${(()=>{const bars=SOURCES.map(s=>({label:(s.k==='ebay'?ebaySrcLabel(p).label:s.label),color:s.color,v:p[s.k]})).filter(b=>b.v>0);if(bars.length<2)return '';const mx=Math.max(...bars.map(b=>b.v));return `<div style="margin-bottom:18px;"><div class="sec-title-sm">Price Bar Chart</div><div style="display:flex;flex-direction:column;gap:9px;">${bars.map(b=>`<div style="display:flex;align-items:center;gap:10px;"><div style="width:96px;flex-shrink:0;font-size:12px;color:var(--muted2);display:flex;align-items:center;gap:6px;"><span style="width:7px;height:7px;border-radius:50%;background:${b.color};display:inline-block;flex-shrink:0;"></span>${b.label}</div><div style="flex:1;height:9px;background:var(--bg3);border-radius:5px;overflow:hidden;"><div style="width:${Math.max(4,Math.round(b.v/mx*100))}%;height:100%;background:${b.color};border-radius:5px;"></div></div><div style="width:74px;flex-shrink:0;text-align:right;font-family:var(--mono);font-size:12px;font-weight:700;color:${b.v===best?'var(--green)':(b.v===worst&&worst>best?'var(--red)':'var(--text)')};">${fmtPrice(b.v)}</div></div>`).join('')}</div></div>`;})()}
      <div style="margin-bottom:18px;"><div class="sec-title-sm">eBay Recent Sold</div><div>${eSales}</div></div>
      ${card.type!=='graded'&&best>0?`<div style="margin-bottom:18px;"><div class="sec-title-sm" style="display:flex;align-items:center;justify-content:space-between;">PSA Grading Value Estimates<span style="font-size:10px;color:var(--muted);font-family:var(--mono);font-weight:400;">Estimated from market price</span></div><div class="psa-row">${[6,7,8,9,10].map(g=>{const mult={6:.45,7:.7,8:1.25,9:1.75,10:3.0}[g];const est=(best*mult).toFixed(0);const hl=g===10?' hl':'';const realPsa10=g===10&&p.psa&&p.psa>0;const dispPrice=realPsa10?p.psa.toFixed(0):est;const isReal=realPsa10;return `<div class="psa-cell${hl}"><div class="psa-gnum">${g}</div><div class="psa-gprice" style="${g===10?'color:var(--gold);font-weight:700;':''}">${dispPrice>0?'$'+dispPrice:'—'}</div>${isReal?'<div style="font-size:8px;color:var(--green);font-family:var(--mono);margin-top:1px;">live</div>':''}</div>`;}).join('')}</div><div style="font-size:10px;color:var(--muted);margin-top:6px;">PSA 10 typically 3× market · <a href="https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(ebayCardQuery(card,'PSA 10'))}&LH_Sold=1" target="_blank" style="color:var(--blue);">Check real PSA 10 sold →</a></div></div>`:''}
      ${card.source?`<div style="display:inline-flex;align-items:center;gap:5px;background:var(--bg3);border:1px solid var(--border);border-radius:20px;padding:3px 10px;font-family:var(--mono);font-size:10px;color:var(--muted2);margin-bottom:10px;"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" style=\"width:10px;height:10px;\"><path d=\"M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z\"/><circle cx=\"12\" cy=\"10\" r=\"3\"/></svg>Purchased from ${esc(card.source)}</div>`:''}
      ${card.notes?`<div style="background:var(--bg3);border-radius:var(--r);padding:10px 12px;font-size:12px;color:var(--muted2);margin-bottom:14px;">${esc(card.notes)}</div>`:''}
      <div style="display:flex;gap:8px;flex-wrap:wrap;border-top:1px solid var(--border);padding-top:14px;">
        <a href="https://www.tcgplayer.com/search/pokemon/product?q=${tcgQ}&view=grid" target="_blank" class="btn btn-ghost btn-xs" title="${full}">TCGPlayer →</a>
        <a href="https://www.pricecharting.com/search-products?q=${pcQ}&type=prices&broad-category=trading-cards" target="_blank" class="btn btn-ghost btn-xs" title="${full}">PriceCharting →</a>
        <a href="https://www.ebay.com/sch/i.html?_nkw=${ebayQ}&LH_Sold=1&LH_Complete=1&LH_ItemCondition=3000" target="_blank" class="btn btn-ghost btn-xs" title="${full}">eBay Sold →</a>
        ${card.grade?`<a href="https://www.ebay.com/sch/i.html?_nkw=${ebayGradeQ}&LH_Sold=1&LH_Complete=1" target="_blank" class="btn btn-primary btn-xs" title="${fullGrade}">${card.grade} Sold →</a>`:''}
        ${card.cert?`<a href="https://www.psacard.com/cert/verify?certNumber=${card.cert}" target="_blank" class="btn btn-ghost btn-xs">PSA Cert →</a>`:''}
      </div>
    </div>
    <div class="modal-ft" style="gap:8px;">${card._transient?(card._wishId?`<button class="btn btn-ghost btn-sm" onclick="closeModal('detail-modal')" style="margin-right:auto;">Close</button><button class="btn btn-primary btn-sm" onclick="closeModal('detail-modal');moveWishToVault('${card._wishId}')">+ Add to Portfolio</button>`:`<button class="btn btn-ghost btn-sm" onclick="closeModal('detail-modal')" style="margin-right:auto;">Close</button><button class="btn btn-primary btn-sm" onclick="closeModal('detail-modal');dealPickCard(window._detailTransient)">＄ Log a Deal</button>`):`<button class="btn btn-danger btn-sm" onclick="closeModal('detail-modal');delCard('${card.id}');" style="margin-right:auto;">🗑 Delete</button><button class="btn btn-ghost btn-sm" onclick="closeModal('detail-modal')">Close</button><button class="btn btn-primary btn-sm" onclick="closeModal('detail-modal');editCard('${card.id}')">✏️ Edit</button>`}</div>`;
  openModal('detail-modal');
  setTimeout(()=>renderCardTrendChart(card, histSeries), 80);
  if(card.type==='graded') setTimeout(()=>loadActiveListings(card), 100);
}

// Live eBay active-listing panel for the graded-card detail modal. Previously
// declared INSIDE openDetail(); it is parameterised on `card` and uses no closure
// state, so it now sits at top level where its scope is obvious. Sole caller is
// the setTimeout above — unchanged, and hoisting kept the call order identical.
async function loadActiveListings(card) {
  const panel = document.getElementById('al-panel-' + card.id);
  if (!panel || card.type !== 'graded' || !card.grade) return;
  try {
    const grader   = card.grade.split(' ')[0] || 'PSA';
    const gradeNum = card.grade.split(' ').slice(1).join(' ') || '10';
    const numClean = (card.num || '').split('/')[0];
    const isVintage = card.set && /base set|jungle|fossil|team rocket|gym heroes|gym challenge|neo genesis|neo discovery|neo destiny|neo revelation|e-card|skyridge|aquapolis|expedition|wizards|wotc|legend/i.test(card.set);
    const q = isVintage
      ? [card.name, numClean, card.set, grader, gradeNum].filter(Boolean).join(' ')
      : [card.name, numClean ? '#'+numClean : '', grader, gradeNum, 'pokemon'].filter(Boolean).join(' ');

    const r = await fetch(`${EBAY_WORKER}/active?q=${encodeURIComponent(q)}&limit=20`);
    if (!r.ok) throw new Error('Worker error ' + r.status);
    const data = await r.json();

    const items = (data.items || []).filter(i => /\bpsa\b|\bbgs\b|\bcgc\b|\bsgc\b/i.test(i.title || ''));
    if (!items.length) {
      panel.innerHTML = '<div style="font-size:12px;color:var(--muted);padding:4px 0;">No active ' + grader + ' ' + gradeNum + ' listings found right now.</div>';
      return;
    }

    const prices  = items.map(i => i.price).sort((a,b) => a-b);
    const lowest  = prices[0];
    const highest = prices[prices.length-1];
    const median  = prices[Math.floor(prices.length/2)];
    const count   = items.length;

    const supplyLabel = count <= 3 ? 'LOW' : count <= 8 ? 'MEDIUM' : 'HIGH';
    const supplyColor = count <= 3 ? 'var(--green)' : count <= 8 ? 'var(--gold)' : 'var(--red)';
    const supplyPct   = Math.min(100, (count / 20) * 100);
    const ebayUrl = 'https://www.ebay.com/sch/i.html?_nkw=' + encodeURIComponent(q) + '&_sop=15';

    panel.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">' +
        '<div style="display:flex;align-items:center;gap:8px;">' +
          '<span style="font-family:var(--mono);font-size:22px;font-weight:700;color:var(--text);">' + count + '</span>' +
          '<span style="font-size:11px;color:var(--muted);">active listings</span>' +
        '</div>' +
        '<div style="display:flex;align-items:center;gap:8px;">' +
          '<span style="font-family:var(--mono);font-size:10px;font-weight:700;color:' + supplyColor + ';">' + supplyLabel + ' SUPPLY</span>' +
          '<a href="' + ebayUrl + '" target="_blank" style="font-family:var(--mono);font-size:10px;color:var(--blue);">View all →</a>' +
        '</div>' +
      '</div>' +
      '<div style="height:4px;border-radius:2px;background:var(--bg2);margin-bottom:12px;overflow:hidden;">' +
        '<div style="height:100%;border-radius:2px;width:' + supplyPct + '%;background:' + supplyColor + ';transition:width .4s;"></div>' +
      '</div>' +
      '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:12px;">' +
        '<div style="background:var(--bg2);border-radius:var(--r);padding:10px 12px;text-align:center;border:1px solid var(--border);">' +
          '<div style="font-family:var(--mono);font-size:16px;font-weight:700;color:var(--green);">$' + lowest.toFixed(2) + '</div>' +
          '<div style="font-family:var(--mono);font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-top:2px;">Lowest Ask</div>' +
        '</div>' +
        '<div style="background:var(--bg2);border-radius:var(--r);padding:10px 12px;text-align:center;border:1px solid var(--border);">' +
          '<div style="font-family:var(--mono);font-size:16px;font-weight:700;color:var(--text);">$' + median.toFixed(2) + '</div>' +
          '<div style="font-family:var(--mono);font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-top:2px;">Median Ask</div>' +
        '</div>' +
        '<div style="background:var(--bg2);border-radius:var(--r);padding:10px 12px;text-align:center;border:1px solid var(--border);">' +
          '<div style="font-family:var(--mono);font-size:16px;font-weight:700;color:var(--muted2);">$' + highest.toFixed(2) + '</div>' +
          '<div style="font-family:var(--mono);font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-top:2px;">Highest Ask</div>' +
        '</div>' +
      '</div>' +
      items.slice(0,3).map(i =>
        '<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;border-bottom:1px solid var(--border);gap:8px;">' +
          '<span style="font-size:10px;color:var(--muted2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(i.title) + '</span>' +
          '<span style="font-family:var(--mono);font-size:10px;color:var(--green);flex-shrink:0;">$' + i.price.toFixed(2) + '</span>' +
        '</div>'
      ).join('');

  } catch(e) {
    const p2 = document.getElementById('al-panel-' + card.id);
    if (p2) p2.innerHTML = '<div style="font-size:12px;color:var(--muted);">Could not load active listings.</div>';
  }
}

function buildCardTrendBlock(card, series, currentPrice){
  const enough = series && series.length >= 2;
  let changeLabel = '';
  if (enough) {
    const first = series[0].v, last = series[series.length-1].v;
    if (first > 0) {
      const pct = ((last-first)/first*100);
      const col = pct>=0 ? 'var(--green)' : 'var(--red)';
      changeLabel = `<span style="font-family:var(--mono);font-size:11px;color:${col};">${pct>=0?'▲ +':'▼ '}${Math.abs(pct).toFixed(1)}% · ${series.length}d</span>`;
    }
  }
  const body = enough
    ? `<div style="position:relative;height:120px;"><canvas id="card-trend-canvas" style="width:100%;display:block;"></canvas></div><div id="card-trend-label" style="display:flex;justify-content:space-between;margin-top:8px;font-family:var(--mono);font-size:10px;color:var(--muted);"></div>`
    : `<div style="padding:24px 12px;text-align:center;"><div style="font-size:13px;color:var(--muted);margin-bottom:4px;">📈 Building price history…</div><div style="font-size:11px;color:var(--muted2);">Recorded ${series?series.length:0} day${(series&&series.length===1)?'':'s'} so far. Your real trend chart appears once there are 2+ days of data.</div></div>`;
  return `<div class="trend-area"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;"><span class="sec-title-sm">Price History</span>${changeLabel}</div>${body}</div>`;
}
let _cardTrendChart = null;
function renderCardTrendChart(card, series){
  if (!series || series.length < 2) return;
  const canvas = document.getElementById('card-trend-canvas');
  if (!canvas) return;
  if (typeof Chart === 'undefined') {
    const s=document.createElement('script');
    s.src='https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js';
    s.onload=()=>setTimeout(()=>renderCardTrendChart(card,series),60);
    document.head.appendChild(s); return;
  }
  if (_cardTrendChart){ _cardTrendChart.destroy(); _cardTrendChart=null; }
  const labels=series.map(p=>p.d), values=series.map(p=>p.v);
  const up=values[values.length-1]>=values[0], col=up?'#2ecc80':'#ff4d6d';
  _cardTrendChart=new Chart(canvas,{type:'line',data:{labels,datasets:[{data:values,borderColor:col,borderWidth:2.5,pointRadius:0,pointHoverRadius:7,pointHoverBackgroundColor:'#fff',pointHoverBorderColor:col,pointHoverBorderWidth:2.5,tension:0.4,fill:true,backgroundColor:ctx=>{const g=ctx.chart.ctx.createLinearGradient(0,0,0,ctx.chart.height);g.addColorStop(0,up?'rgba(46,204,128,0.22)':'rgba(255,77,109,0.22)');g.addColorStop(0.65,up?'rgba(46,204,128,0.05)':'rgba(255,77,109,0.05)');g.addColorStop(1,'rgba(0,0,0,0)');return g;}}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{mode:'index',intersect:false,backgroundColor:'rgba(10,10,18,0.97)',borderColor:col,borderWidth:1,titleColor:'rgba(255,255,255,0.45)',bodyColor:'#fff',bodyFont:{family:'monospace',size:14,weight:'700'},titleFont:{family:'monospace',size:10},padding:12,displayColors:false,cornerRadius:10,callbacks:{label:ctx=>'$'+ctx.parsed.y.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}}},scales:{x:{grid:{color:'rgba(255,255,255,0.03)',drawBorder:false},ticks:{color:'rgba(255,255,255,0.25)',font:{family:'monospace',size:9},maxTicksLimit:5,maxRotation:0},border:{display:false}},y:{grid:{color:'rgba(255,255,255,0.03)',drawBorder:false},ticks:{color:'rgba(255,255,255,0.25)',font:{family:'monospace',size:9},maxTicksLimit:4,callback:v=>v>=1000?'$'+(v/1000).toFixed(1)+'k':'$'+Math.round(v)},border:{display:false}}},interaction:{mode:'index',intersect:false}}});
  const lbl=document.getElementById('card-trend-label');
  if(lbl){const mn=Math.min(...values),mx=Math.max(...values);lbl.innerHTML=`<span>Low $${mn.toFixed(2)}</span><span>${series.length} days tracked</span><span>High $${mx.toFixed(2)}</span>`;}
}
function renderSparklineSVG(pts){const w=520,h=54,pad=4;const min=Math.min(...pts),max=Math.max(...pts);const range=max-min||1;const toX=i=>(i/(pts.length-1))*(w-pad*2)+pad;const toY=v=>h-pad-(v-min)/range*(h-pad*2);const d='M'+pts.map((v,i)=>toX(i)+','+toY(v)).join('L');const fill=d+`L${toX(pts.length-1)},${h}L${pad},${h}Z`;const up=pts[pts.length-1]>=pts[0];const col=up?'#2ecc80':'#ff4d6d';return `<div class="sparkline-wrap"><svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="sg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${col}" stop-opacity=".25"/><stop offset="100%" stop-color="${col}" stop-opacity="0"/></linearGradient></defs><path d="${fill}" fill="url(#sg)"/><path d="${d}" fill="none" stroke="${col}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/><circle cx="${toX(pts.length-1)}" cy="${toY(pts[pts.length-1])}" r="3" fill="${col}"/></svg></div>`;}
// DORMANT / DO NOT WIRE UP. Retained only as a reference implementation; it
// FABRICATES sold comps and must never reach a surface the user reads as market
// evidence. Its former caller (openDetail) now renders an honest empty state.
function simulateEbaySales(anchor){const sales=[];const now=new Date();for(let i=0;i<5;i++){const d=new Date(now);d.setDate(d.getDate()-Math.floor(Math.random()*14));const conds=['NM','LP','NM','LP','MP'];const mult={NM:1,LP:.8,MP:.6}[conds[i]];sales.push({date:d.toLocaleDateString('en-US',{month:'short',day:'numeric'}),cond:conds[i],price:+(anchor*mult*(1+(Math.random()-.5)*.12)).toFixed(2)});}return sales.sort((a,b)=>new Date(b.date)-new Date(a.date));}

// ════════════════════════════════════════════════════════════════════════════
// REHOMED IN FINAL MIGRATION - eBay listing-title query builder.
// Its only caller is openDetail below; it consults jpSearchTerms at call time.
// ════════════════════════════════════════════════════════════════════════════
// Build an eBay search query that MATCHES REAL LISTING TITLES.
// eBay rewards few, distinctive tokens. The old query pasted the raw catalog set name
// on the end, producing e.g. "Umbreon BW93 BW Black Star Promos pokemon card" — the
// "BW" is duplicated (it's already in BW93) and no seller writes the full catalog set
// name, so eBay found nothing and fell back to generic promo results.
function ebayCardQuery(card, grade){
  if (!card) return '';
  if (card.lang === 'JP') return [jpSearchTerms(card), grade].filter(Boolean).join(' ');
  const parts = [];
  const name = String(card.name || '').trim();
  const num  = String(card.num  || '').trim();
  if (name) parts.push(name);
  if (num)  parts.push(num);
  let set = String(card.set || '').trim();
  // Drop a set prefix already implied by the card number ("BW93" + "BW Black Star…")
  const pfx = (num.match(/^([A-Za-z]{1,4})\d/) || [])[1];
  if (pfx && new RegExp('^' + pfx + '\\s', 'i').test(set)) set = set.replace(new RegExp('^' + pfx + '\\s', 'i'), '');
  // Promo sets: sellers write "Black Star Promo" / "promo", not the catalog name
  if (/black\s*star\s*promo/i.test(set))      set = 'Black Star Promo';
  else if (/\bpromos?\b/i.test(set))           set = 'promo';
  if (set) parts.push(set);
  const ed = (typeof editionSearchTerm === 'function') ? editionSearchTerm(card) : '';
  if (ed) parts.push(ed);
  // Printing/variant — WAS MISSING: a Reverse Holo holding produced the same query as
  // the holo ("Gengar 5 Legend Maker PSA 10 pokemon"), so the links returned BOTH
  // printings even though the card was explicitly marked Reverse Holo. These trade at
  // very different prices, so the variant has to reach the query.
  const vt = (typeof variantSearchTerm === 'function') ? variantSearchTerm(card) : '';
  if (vt) parts.push(vt);
  if (grade) parts.push(grade);
  parts.push('pokemon');
  return parts.filter(Boolean).join(' ');
}
