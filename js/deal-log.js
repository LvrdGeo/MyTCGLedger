/* ════════════════════════════════════════════════════════════════════════════
   MyTCG Ledger V6 - deal-log.js
   ────────────────────────────────────────────────────────────────────────────
   DOMAIN MODULE (deal creation / editing UI). The FIRST Deals slice, chosen to
   be deliberately conservative: it collects deal inputs, shows cards and cash,
   computes the previews and lets the user pick portfolio cards - while every
   line that MUTATES deals[] or collection stays outside.

   Batch 24 decomposed Deals Core into five sub-domains. This module is exactly
   two of them; the other three are untouched:
       MOVED     deal-log modal + deal card picker
       STAYED    persistence/apply, deal search, deal rendering

   OWNS - modal:
     setDealType, openDealLogModal, dlRenderCards, dlUpdatePnL,
     dlTogglePortfolio, dlRenderApplyToggle, dlAddCash, dlRemoveCash,
     dlUpdateCashDisplay, dlAddCard, dlUpdateNegPreview
   OWNS - picker (verified PRIVATE - zero external JS callers):
     showCollectionInPicker, onDLPickerSearch, dlPickerSelectCard,
     dlPickerUpdateMktDiff, dlPickerConfirm
   OWNS - form state:
     _dealType, _editingDealLogId, _dlPickerSide, _dlPickerCard, _dlPickerTimer,
     _dlCardsOut, _dlCardsIn, _dlApplyPortfolio, window._dlpCards

   PERSISTENCE BOUNDARY - the whole point of this batch. This file contains ZERO
   calls to saveDealLog / applyDealToPortfolio / save() / dbWrite, and ZERO
   mutation of collection, deals, sealed, wishlist, soldHistory, pcache,
   liqCache, AppState or the deletion ledger. It only ever mutates its own form
   state above. The user's Save button reaches inline saveDealLog(), which then
   READS this module's form state at call time. Writer here, reader there.

   DOES NOT OWN: deal persistence/apply, deleteDeal/markDealClosed, deal search,
   deal rendering (renderDeals / renderDealGalleryAndLeaderboard /
   renderLegacyDeals / renderDealNegotiation), deal evaluation, card detail, cards
   CRUD, pricing, valuation, portfolio, storage, analytics, nav.

   RENAMED (maintainability batch): renderPortfolioToggle -> dlRenderApplyToggle.
   It renders the deal modal's apply-to-collection toggle (label + sub-text per
   deal type); it never rendered anything portfolio-owned. 7 references updated,
   no inline handlers, no aliases retained.

   INBOUND (all Class C - remaining inline Deals/nav, all call-time):
     openDealLogModal <- fabAction, renderDeals, markDealClosed
     dlRenderCards    <- dealPickCard
     dlUpdatePnL      <- dealPickCard
   Plus Class A inline HTML handlers on the modal and picker controls.
   No extracted module calls in, and this file calls no extracted module out -
   no cycle in either direction.

   NETWORK: one catalogue request, in onDLPickerSearch, for the incoming side of
   a trade. It is the THIRD direct pokemontcg.io consumer in the project after
   search.js and wishlist.js - recorded as debt, not consolidated here.

   VALUATION: reads market value through cardValue() only. No pcache access, no
   hand-built cache key, no valuation formula.

   LOAD-TIME EXECUTION: none. Eight declarations; no modal opens, no render, no
   fetch, no persistence, no analytics.

   CALL-TIME DEPENDENCIES:
     core       esc, money, moneyFull, openModal, closeModal, toast
     valuation  cardValue
     pricing    loadPricesForCards - dlPickerSelectCard is ASYNC and awaits a
                price lookup when the chosen card has no cached market value
     inline     collection, deals, keys, saveDealLog (via the Save button), and
                the #deal-log-modal / #dl-card-picker DOM
     external   api.pokemontcg.io (picker search)
   ════════════════════════════════════════════════════════════════════════════ */

let _dealType = 'sale';
let _editingDealLogId = null;
let _dlPickerSide = 'out'; // 'in' or 'out'
let _dlPickerCard = null;
let _dlPickerTimer = null;
let _dlCardsOut = []; // cards going out
let _dlCardsIn  = []; // cards coming in (trade mode)
let _dlApplyPortfolio = true; // whether saving this deal updates the collection

function setDealType(type, el) {
  _dealType = type;
  document.querySelectorAll('#deal-log-modal .type-pill').forEach(b => b.classList.remove('active'));
  if (el) el.classList.add('active');
  document.getElementById('dl-purchase-section').style.display = type === 'purchase' ? '' : 'none';
  document.getElementById('dl-sale-section').style.display     = type === 'sale'     ? '' : 'none';
  document.getElementById('dl-trade-section').style.display    = type === 'trade'    ? '' : 'none';
  dlRenderCards();
  dlUpdatePnL();
  dlRenderApplyToggle();
}

function openDealLogModal(id) {
  _editingDealLogId = id || null;
  const d = id ? deals.find(x => x.id === id) : null;
  document.getElementById('deal-log-title').textContent = id ? 'Edit Deal' : 'Log Deal';

  // Reset
  _dlCardsOut = d ? (d.cardsOut || []) : [];
  _dlCardsIn  = d ? (d.cardsIn  || []) : [];
  _dealType   = d ? (d.dealType || 'purchase') : 'purchase';

  document.getElementById('dl-date').value     = d ? d.date||'' : new Date().toISOString().slice(0,10);
  document.getElementById('dl-platform').value = d ? d.platform||'' : '';
  document.getElementById('dl-notes').value    = d ? d.notes||'' : '';
  document.getElementById('dl-cash-in').value  = d ? d.cashIn||'' : '';
  document.getElementById('dl-cash-out').value = d ? d.cashOut||'' : '';
  document.getElementById('dl-cash-in-trade').value = d ? d.cashInTrade||'' : '';
  const cashPaidEl = document.getElementById('dl-cash-paid'); if (cashPaidEl) cashPaidEl.value = d ? (d.cashPaid||'') : '';
  // Show/hide cash rows based on whether values exist
  const showCashOut = d && parseFloat(d.cashOut||0) > 0;
  const showCashIn  = d && parseFloat(d.cashInTrade||0) > 0;
  const cashOutDisp = document.getElementById('dl-cash-out-display');
  const cashInDisp  = document.getElementById('dl-cash-in-display');
  if (cashOutDisp) cashOutDisp.style.display = showCashOut ? '' : 'none';
  if (cashInDisp)  cashInDisp.style.display  = showCashIn  ? '' : 'none';
  document.getElementById('dl-seller-ask').value  = d ? d.sellerAsk||'' : '';
  document.getElementById('dl-my-offer').value    = d ? d.myOffer||'' : '';
  document.getElementById('dl-final-price').value = d ? d.finalPrice||'' : '';
  document.getElementById('dl-neg-preview').style.display = 'none';

  // Set type
  document.querySelectorAll('#deal-log-modal .type-pill').forEach(b => b.classList.remove('active'));
  document.getElementById('dl-type-' + _dealType)?.classList.add('active');
  document.getElementById('dl-purchase-section').style.display = _dealType === 'purchase' ? '' : 'none';
  document.getElementById('dl-sale-section').style.display     = _dealType === 'sale'     ? '' : 'none';
  document.getElementById('dl-trade-section').style.display    = _dealType === 'trade'    ? '' : 'none';

  dlRenderCards();
  dlUpdatePnL();
  // Default: apply to portfolio for NEW deals; for edits of already-applied deals, default OFF to avoid double-applying.
  _dlApplyPortfolio = d ? !d.portfolioApplied : true;
  dlRenderApplyToggle();
  openModal('deal-log-modal');
}

function dlRenderCards() {
  // Purchase mode — cards being bought (stored in _dlCardsIn)
  const buyEl  = document.getElementById('dl-buy-list');
  const buyEmp = document.getElementById('dl-buy-empty');
  if (buyEl) {
    if (!_dlCardsIn.length) { buyEl.innerHTML=''; if(buyEmp) buyEmp.style.display=''; }
    else {
      if(buyEmp) buyEmp.style.display='none';
      buyEl.innerHTML = _dlCardsIn.map((c,i) => `
        <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border);">
          ${c.img?`<img src="${esc(c.img)}" style="width:28px;height:39px;object-fit:contain;border-radius:3px;flex-shrink:0;">`:'<div style="width:28px;height:39px;background:var(--bg2);border-radius:3px;display:flex;align-items:center;justify-content:center;font-size:10px;flex-shrink:0;">⟡</div>'}
          <div style="flex:1;min-width:0;"><div style="font-size:11px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(c.name)}</div><div style="font-size:9px;color:var(--muted);font-family:var(--mono);">${esc(c.set||'')}</div></div>
          <input type="number" step="0.01" min="0" value="${c.value||''}" placeholder="$0.00" style="width:80px;background:var(--bg2);border:1px solid var(--border);border-radius:6px;color:var(--text);font-family:var(--mono);font-size:12px;padding:4px 6px;text-align:right;" oninput="_dlCardsIn[${i}].value=parseFloat(this.value)||0;dlUpdatePnL()">
          <button onclick="_dlCardsIn.splice(${i},1);dlRenderCards();dlUpdatePnL();" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:14px;padding:0 4px;">✕</button>
        </div>`).join('');
    }
  }

  // Sale mode — cards out
  const outEl  = document.getElementById('dl-out-list');
  const outEmp = document.getElementById('dl-out-empty');
  if (outEl) {
    if (!_dlCardsOut.length) { outEl.innerHTML=''; outEmp.style.display=''; }
    else {
      outEmp.style.display='none';
      outEl.innerHTML = _dlCardsOut.map((c,i) => `
        <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border);">
          ${c.img?`<img src="${esc(c.img)}" style="width:28px;height:39px;object-fit:contain;border-radius:3px;flex-shrink:0;">`:'<div style="width:28px;height:39px;background:var(--bg2);border-radius:3px;display:flex;align-items:center;justify-content:center;font-size:10px;flex-shrink:0;">⟡</div>'}
          <div style="flex:1;min-width:0;"><div style="font-size:11px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(c.name)}</div><div style="font-size:9px;color:var(--muted);font-family:var(--mono);">${esc(c.set||'')}</div></div>
          <input type="number" step="0.01" min="0" value="${c.value||''}" placeholder="$0.00" style="width:80px;background:var(--bg2);border:1px solid var(--border);border-radius:6px;color:var(--text);font-family:var(--mono);font-size:12px;padding:4px 6px;text-align:right;" oninput="_dlCardsOut[${i}].value=parseFloat(this.value)||0;dlUpdatePnL()">
          <button onclick="_dlCardsOut.splice(${i},1);dlRenderCards();dlUpdatePnL();" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:14px;padding:0 4px;">✕</button>
        </div>`).join('');
    }
  }

  // Trade mode — cards out
  const tradeOutEl = document.getElementById('dl-trade-out-list');
  if (tradeOutEl) {
    tradeOutEl.innerHTML = _dlCardsOut.map((c,i) => `
      <div style="display:flex;align-items:center;gap:6px;padding:4px 0;border-bottom:1px solid var(--border);">
        ${c.img?`<img src="${esc(c.img)}" style="width:24px;height:33px;object-fit:contain;border-radius:2px;flex-shrink:0;">`:'<div style="width:24px;height:33px;background:var(--bg2);border-radius:2px;flex-shrink:0;"></div>'}
        <div style="flex:1;min-width:0;font-size:10px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(c.name)}</div>
        <input type="number" step="0.01" min="0" value="${c.value||''}" placeholder="$0" style="width:64px;background:var(--bg2);border:1px solid var(--border);border-radius:4px;color:var(--text);font-family:var(--mono);font-size:11px;padding:3px 5px;text-align:right;" oninput="_dlCardsOut[${i}].value=parseFloat(this.value)||0;dlUpdatePnL()">
        <button onclick="_dlCardsOut.splice(${i},1);dlRenderCards();dlUpdatePnL();" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:12px;padding:0 2px;">✕</button>
      </div>`).join('') || '<div style="font-size:10px;color:var(--muted);padding:4px 0;">None added</div>';
    const cashOut = parseFloat(document.getElementById('dl-cash-out')?.value||0);
    const tot = _dlCardsOut.reduce((s,c)=>s+(c.value||0),0) + cashOut;
    document.getElementById('dl-trade-out-total').textContent = '$'+tot.toFixed(2);
  }

  // Trade mode — cards in
  const tradeInEl = document.getElementById('dl-trade-in-list');
  if (tradeInEl) {
    tradeInEl.innerHTML = _dlCardsIn.map((c,i) => `
      <div style="display:flex;align-items:center;gap:6px;padding:4px 0;border-bottom:1px solid var(--border);">
        ${c.img?`<img src="${esc(c.img)}" style="width:24px;height:33px;object-fit:contain;border-radius:2px;flex-shrink:0;">`:'<div style="width:24px;height:33px;background:var(--bg2);border-radius:2px;flex-shrink:0;"></div>'}
        <div style="flex:1;min-width:0;font-size:10px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(c.name)}</div>
        <input type="number" step="0.01" min="0" value="${c.value||''}" placeholder="$0" style="width:64px;background:var(--bg2);border:1px solid var(--border);border-radius:4px;color:var(--text);font-family:var(--mono);font-size:11px;padding:3px 5px;text-align:right;" oninput="_dlCardsIn[${i}].value=parseFloat(this.value)||0;dlUpdatePnL()">
        <button onclick="_dlCardsIn.splice(${i},1);dlRenderCards();dlUpdatePnL();" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:12px;padding:0 2px;">✕</button>
      </div>`).join('') || '<div style="font-size:10px;color:var(--muted);padding:4px 0;">None added</div>';
    const cashIn = parseFloat(document.getElementById('dl-cash-in-trade')?.value||0);
    const tot = _dlCardsIn.reduce((s,c)=>s+(c.value||0),0) + cashIn;
    document.getElementById('dl-trade-in-total').textContent = '$'+tot.toFixed(2);
  }
}

function dlUpdatePnL() {
  const lblOut = document.getElementById('dl-pnl-out-label');
  const lblIn  = document.getElementById('dl-pnl-in-label');
  const lblPro = document.getElementById('dl-pnl-profit-label');

  if (_dealType === 'purchase') {
    // Purchase: you pay cash (out), you get cards worth market value (in).
    const cashPaid  = parseFloat(document.getElementById('dl-cash-paid')?.value||0);
    const mktValue  = _dlCardsIn.reduce((s,c)=>s+(c.value||0),0);
    const instant   = mktValue - cashPaid; // instant equity vs what you paid
    const col       = instant >= 0 ? 'var(--green)' : 'var(--red)';
    if (lblOut) lblOut.textContent = 'You Pay';
    if (lblIn)  lblIn.textContent  = 'Market Value';
    if (lblPro) lblPro.textContent = 'Instant Equity';
    document.getElementById('dl-pnl-out').textContent    = '$'+cashPaid.toFixed(2);
    document.getElementById('dl-pnl-in').textContent     = '$'+mktValue.toFixed(2);
    document.getElementById('dl-pnl-profit').textContent = (cashPaid>0||mktValue>0)?(instant>=0?'+':'')+'$'+Math.abs(instant).toFixed(2):'—';
    document.getElementById('dl-pnl-profit').style.color = col;
    const roi = cashPaid>0 ? ((instant/cashPaid)*100).toFixed(1) : null;
    document.getElementById('dl-pnl-roi').textContent = roi ? (roi>=0?'+':'')+roi+'%' : '—';
    document.getElementById('dl-pnl-roi').style.color = col;
    return;
  }

  let outTotal = _dlCardsOut.reduce((s,c)=>s+(c.value||0),0);
  let inTotal  = _dlCardsIn.reduce((s,c)=>s+(c.value||0),0);

  if (_dealType === 'sale') {
    inTotal = parseFloat(document.getElementById('dl-cash-in')?.value||0);
    if (lblOut) lblOut.textContent = 'Cost (Cards)';
    if (lblIn)  lblIn.textContent  = 'You Receive';
    if (lblPro) lblPro.textContent = 'Profit';
  } else {
    outTotal += parseFloat(document.getElementById('dl-cash-out')?.value||0);
    inTotal  += parseFloat(document.getElementById('dl-cash-in-trade')?.value||0);
    if (lblOut) lblOut.textContent = 'You Give';
    if (lblIn)  lblIn.textContent  = 'You Get';
    if (lblPro) lblPro.textContent = 'Net Gain';
  }

  const profit = inTotal - outTotal;
  const roi    = outTotal > 0 ? ((profit/outTotal)*100).toFixed(1) : null;
  const col    = profit >= 0 ? 'var(--green)' : 'var(--red)';

  document.getElementById('dl-pnl-out').textContent    = '$'+outTotal.toFixed(2);
  document.getElementById('dl-pnl-in').textContent     = '$'+inTotal.toFixed(2);
  document.getElementById('dl-pnl-profit').textContent = outTotal > 0 || inTotal > 0 ? (profit>=0?'+':'')+'$'+Math.abs(profit).toFixed(2) : '—';
  document.getElementById('dl-pnl-profit').style.color = col;
  document.getElementById('dl-pnl-roi').textContent    = roi ? (roi>=0?'+':'')+roi+'%' : '—';
  document.getElementById('dl-pnl-roi').style.color    = col;
}


function dlTogglePortfolio() {
  _dlApplyPortfolio = !_dlApplyPortfolio;
  dlRenderApplyToggle();
}

function dlRenderApplyToggle() {
  const check = document.getElementById('dl-portfolio-check');
  const label = document.getElementById('dl-portfolio-label');
  const sub   = document.getElementById('dl-portfolio-sub');
  const box   = document.getElementById('dl-portfolio-toggle');
  if (!check || !label) return;
  // Update label per deal type
  const map = {
    purchase: { l:'Add to my collection',        s:'Cards you buy will be added to your portfolio with this cost basis' },
    sale:     { l:'Remove from my collection',   s:'Cards you sell will be removed and logged to Sold History' },
    trade:    { l:'Update my collection',        s:'Cards you give are removed; cards you get are added (cost basis carries over)' }
  };
  const m = map[_dealType] || map.purchase;
  label.textContent = m.l;
  sub.textContent = m.s;
  // Visual on/off
  if (_dlApplyPortfolio) {
    check.style.background = 'var(--gold)';
    check.style.border = 'none';
    check.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="#08090e" stroke-width="3" style="width:14px;height:14px;"><polyline points="20 6 9 17 4 12"/></svg>';
    if (box) { box.style.background='rgba(245,200,66,0.06)'; box.style.borderColor='rgba(245,200,66,0.2)'; }
  } else {
    check.style.background = 'transparent';
    check.style.border = '2px solid var(--muted2)';
    check.innerHTML = '';
    if (box) { box.style.background='transparent'; box.style.borderColor='var(--border)'; }
  }
}

function dlAddCash(side) {
  const displayId = side === 'out' ? 'dl-cash-out-display' : 'dl-cash-in-display';
  const inputId   = side === 'out' ? 'dl-cash-out' : 'dl-cash-in-trade';
  document.getElementById(displayId).style.display = '';
  setTimeout(() => document.getElementById(inputId)?.focus(), 50);
}

function dlRemoveCash(side) {
  const displayId = side === 'out' ? 'dl-cash-out-display' : 'dl-cash-in-display';
  const inputId   = side === 'out' ? 'dl-cash-out' : 'dl-cash-in-trade';
  document.getElementById(displayId).style.display = 'none';
  const inp = document.getElementById(inputId);
  if (inp) inp.value = '';
  dlUpdatePnL();
  dlUpdateCashDisplay(side);
}

function dlUpdateCashDisplay(side) {
  // Update the total for this side
  if (side === 'out') {
    const cashOut = parseFloat(document.getElementById('dl-cash-out')?.value||0);
    const cardsOut = _dlCardsOut.reduce((s,c)=>s+(c.value||0),0);
    const totEl = document.getElementById('dl-trade-out-total');
    if (totEl) totEl.textContent = '$'+(cardsOut+cashOut).toFixed(2);
  } else {
    const cashIn = parseFloat(document.getElementById('dl-cash-in-trade')?.value||0);
    const cardsIn = _dlCardsIn.reduce((s,c)=>s+(c.value||0),0);
    const totEl = document.getElementById('dl-trade-in-total');
    if (totEl) totEl.textContent = '$'+(cardsIn+cashIn).toFixed(2);
  }
}

function dlAddCard(side) {
  _dlPickerSide = side;
  _dlPickerCard = null;
  let pickerTitle;
  if (side === 'out') pickerTitle = _dealType === 'sale' ? 'Add Card — You Are Selling' : 'Add Card — You Give';
  else pickerTitle = _dealType === 'purchase' ? 'Add Card — You Are Buying' : 'Add Card — You Receive';
  document.getElementById('dl-picker-title').textContent = pickerTitle;
  document.getElementById('dl-picker-search').value = '';
  document.getElementById('dl-picker-results').innerHTML = '';
  document.getElementById('dl-picker-name').textContent = 'Select a card';
  document.getElementById('dl-picker-meta').textContent = '';
  document.getElementById('dl-picker-img').textContent = '⟡';
  document.getElementById('dl-picker-value').value = '';
  document.getElementById('dl-picker-mkt').textContent = '';
  // For the give/sell side, show the user's collection immediately (before they type).
  if (side === 'out') showCollectionInPicker('');
  openModal('dl-card-picker');
  setTimeout(()=>document.getElementById('dl-picker-search')?.focus(),100);
}

// Render the user's owned cards into the picker results (optionally filtered by query).
function showCollectionInPicker(query) {
  const res = document.getElementById('dl-picker-results');
  if (!res) return;
  const q = (query||'').trim().toLowerCase();
  const owned = q
    ? collection.filter(c => (c.name||'').toLowerCase().includes(q) || (c.num||'').toLowerCase()===q)
    : collection.slice();
  if (!owned.length) {
    res.innerHTML = q
      ? '<div style="padding:8px;font-size:11px;color:var(--muted);">No matching cards in your collection. Type to search all cards.</div>'
      : '<div style="padding:8px;font-size:11px;color:var(--muted);">Your collection is empty. Type to search all cards.</div>';
    return;
  }
  window._dlpCards = window._dlpCards || {};
  res.innerHTML = '<div style="padding:6px 10px 4px;font-family:var(--mono);font-size:9px;color:var(--gold);text-transform:uppercase;letter-spacing:1px;">Your Collection</div>' +
    owned.slice(0,30).map(c => {
      const key='dlpc_'+c.id;
      const mkt = cardValue(c) || null;
      window._dlpCards[key] = {id:c.cardId||c.id, name:c.name, set:c.set||'', num:c.num||'', img:c.img||'', mkt, ownedId:c.id, grade:c.grade||'', cond:c.cond||'', paid:c.paid||0};
      return `<div onclick="dlPickerSelectCard(window._dlpCards['${key}'])" style="display:flex;align-items:center;gap:8px;padding:7px 10px;cursor:pointer;border-radius:6px;background:rgba(245,200,66,0.04);" onmouseover="this.style.background='var(--bg3)'" onmouseout="this.style.background='rgba(245,200,66,0.04)'">
        ${c.img?`<img src="${esc(c.img)}" style="width:28px;height:39px;object-fit:contain;border-radius:3px;flex-shrink:0;">`:'<div style="width:28px;height:39px;background:var(--bg3);border-radius:3px;flex-shrink:0;"></div>'}
        <div style="flex:1;min-width:0;"><div style="font-size:12px;font-weight:600;">${esc(c.name)} ${c.grade?`<span style="color:var(--gold);font-size:9px;">${esc(c.grade)}</span>`:''}</div><div style="font-size:10px;color:var(--muted);">${esc(c.set||'')} · #${esc(c.num||'?')} · owned</div></div>
        ${mkt?`<div style="font-family:var(--mono);font-size:11px;color:var(--green);flex-shrink:0;">$${mkt.toFixed(2)}</div>`:''}
      </div>`;
    }).join('');
}

function onDLPickerSearch(val) {
  clearTimeout(_dlPickerTimer);
  const res = document.getElementById('dl-picker-results');
  if (!val.trim()) {
    // Empty input: on give/sell side show the full collection; otherwise clear.
    if (_dlPickerSide === 'out') showCollectionInPicker('');
    else res.innerHTML='';
    return;
  }
  const isNum = /^\d+$/.test(val.trim());
  // Numbers only need 1-3 chars, names need 4+
  const minLen = isNum ? 1 : 4;
  if (val.trim().length < minLen) {
    res.innerHTML = `<div style="padding:8px;font-size:11px;color:var(--muted);">${isNum ? 'Searching by card number…' : 'Keep typing… ('+(minLen - val.trim().length)+' more characters)'}</div>`;
    return;
  }
  // Show matching cards from YOUR collection first (most relevant when selling/trading away)
  let collectionHtml = '';
  if (_dlPickerSide === 'out') {
    const q = val.trim().toLowerCase();
    const owned = collection.filter(c => (c.name||'').toLowerCase().includes(q) || (c.num||'').toLowerCase()===q);
    if (owned.length) {
      window._dlpCards = window._dlpCards || {};
      collectionHtml = '<div style="padding:6px 10px 4px;font-family:var(--mono);font-size:9px;color:var(--gold);text-transform:uppercase;letter-spacing:1px;">Your Collection</div>' +
        owned.slice(0,8).map(c => {
          const key='dlpc_'+c.id;
          const mkt = cardValue(c) || null;
          window._dlpCards[key] = {id:c.cardId||c.id, name:c.name, set:c.set||'', num:c.num||'', img:c.img||'', mkt, ownedId:c.id, grade:c.grade||'', cond:c.cond||'', paid:c.paid||0};
          return `<div onclick="dlPickerSelectCard(window._dlpCards['${key}'])" style="display:flex;align-items:center;gap:8px;padding:7px 10px;cursor:pointer;border-radius:6px;background:rgba(245,200,66,0.04);" onmouseover="this.style.background='var(--bg3)'" onmouseout="this.style.background='rgba(245,200,66,0.04)'">
            ${c.img?`<img src="${esc(c.img)}" style="width:28px;height:39px;object-fit:contain;border-radius:3px;flex-shrink:0;">`:'<div style="width:28px;height:39px;background:var(--bg3);border-radius:3px;flex-shrink:0;"></div>'}
            <div style="flex:1;min-width:0;"><div style="font-size:12px;font-weight:600;">${esc(c.name)} ${c.grade?`<span style="color:var(--gold);font-size:9px;">${esc(c.grade)}</span>`:''}</div><div style="font-size:10px;color:var(--muted);">${esc(c.set||'')} · #${esc(c.num||'?')} · owned</div></div>
            ${mkt?`<div style="font-family:var(--mono);font-size:11px;color:var(--green);flex-shrink:0;">$${mkt.toFixed(2)}</div>`:''}
          </div>`;
        }).join('') +
        '<div style="padding:6px 10px 4px;font-family:var(--mono);font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;border-top:1px solid var(--border);margin-top:4px;">All Cards</div>';
    }
  }

  _dlPickerTimer = setTimeout(async ()=>{
    res.innerHTML = collectionHtml + '<div style="padding:8px;font-size:11px;color:var(--muted);">Searching…</div>';
    try {
      const dexNum = getPokemonDexNumber(val);
      const isNumber = /^\d+$/.test(val.trim()); // user typed a card number like "234"
      let qStr;
      if (dexNum) {
        qStr = buildDexNameQuery(val, dexNum);
      } else if (isNumber) {
        qStr = `number:${val.trim()}`; // search by card number
      } else {
        qStr = buildNameQuery(val);
      }
      const r = await ptcgFetchOk(`/cards?q=${encodeURIComponent(qStr)}&orderBy=-set.releaseDate&pageSize=60`);
      const j = await r.json();
      if (!j.data?.length){res.innerHTML=collectionHtml||'<div style="padding:8px;font-size:11px;color:var(--muted);">No results.</div>';return;}
      res.innerHTML = collectionHtml + searchCountLine(j, q, {compact:true}) + j.data.map(card=>{
        const tier=card.tcgplayer?.prices?Object.values(card.tcgplayer.prices)[0]:null;
        const mkt=tier?.market||null;
        const key='dlp_'+card.id.replace(/[^a-z0-9]/gi,'_');
        window._dlpCards=window._dlpCards||{};
        window._dlpCards[key]={id:card.id,name:card.name,set:card.set?.name||'',num:card.number||'',img:card.images?.small||'',mkt};
        return `<div onclick="dlPickerSelectCard(window._dlpCards['${key}'])" style="display:flex;align-items:center;gap:8px;padding:7px 10px;cursor:pointer;border-radius:6px;transition:background .1s;" onmouseover="this.style.background='var(--bg3)'" onmouseout="this.style.background=''">
          ${card.images?.small?`<img src="${esc(card.images.small)}" style="width:28px;height:39px;object-fit:contain;border-radius:3px;flex-shrink:0;">`:'<div style="width:28px;height:39px;background:var(--bg3);border-radius:3px;flex-shrink:0;"></div>'}
          <div style="flex:1;min-width:0;"><div style="font-size:12px;font-weight:600;">${esc(card.name)}</div><div style="font-size:10px;color:var(--muted);">${esc(card.set?.name||'')} · #${esc(card.number||'?')}</div></div>
          ${mkt?`<div style="font-family:var(--mono);font-size:11px;color:var(--green);flex-shrink:0;">$${mkt.toFixed(2)}</div>`:''}
        </div>`;
      }).join('');
    } catch(e){res.innerHTML=collectionHtml+'<div style="padding:8px;font-size:11px;color:var(--muted);">Search failed.</div>';}
  },400);
}

async function dlPickerSelectCard(card) {
  _dlPickerCard = card;
  document.getElementById('dl-picker-name').textContent = card.name;
  document.getElementById('dl-picker-meta').textContent = [card.set, card.num?'#'+card.num:''].filter(Boolean).join(' \u00b7 ');
  const imgEl = document.getElementById('dl-picker-img');
  imgEl.innerHTML = card.img ? `<img src="${esc(card.img)}" style="width:100%;height:100%;object-fit:contain;">` : '';
  const valEl = document.getElementById('dl-picker-value');
  const mktEl = document.getElementById('dl-picker-mkt');
  if (card.mkt) {
    valEl.value = card.mkt.toFixed(2);
    mktEl.textContent = 'Market: $'+card.mkt.toFixed(2);
  } else {
    mktEl.textContent = 'Fetching market value\u2026';
    try {
      const probe = { id: card.ownedId || card.id, cardId: card.id, name: card.name, set: card.set, num: card.num, type: card.grade ? 'graded' : 'standard', grade: card.grade || '', cond: card.cond || 'NM' };
      await loadPricesForCards([probe]);
      const mkt = cardValue(probe) || null;
      if (mkt) {
        card.mkt = mkt;
        valEl.value = mkt.toFixed(2);
        mktEl.textContent = 'Market: $'+mkt.toFixed(2);
      } else {
        mktEl.textContent = 'No market price found \u2014 enter manually';
      }
    } catch (e) {
      mktEl.textContent = 'Could not fetch price \u2014 enter manually';
    }
  }
  document.getElementById('dl-picker-results').innerHTML = '';
  document.getElementById('dl-picker-search').value = '';
  valEl.focus();
}

function dlPickerUpdateMktDiff() {
  if (!_dlPickerCard?.mkt) return;
  const val = parseFloat(document.getElementById('dl-picker-value').value||0);
  const diff = val - _dlPickerCard.mkt;
  const mktEl = document.getElementById('dl-picker-mkt');
  mktEl.textContent = `TCGPlayer market: $${_dlPickerCard.mkt.toFixed(2)}  ·  ${diff>=0?'+':''}$${diff.toFixed(2)} vs market`;
  mktEl.style.color = diff >= 0 ? 'var(--green)' : 'var(--red)';
}

function dlPickerConfirm() {
  const val = parseFloat(document.getElementById('dl-picker-value').value||0);
  if (!_dlPickerCard) { toast('Select a card first','red'); return; }
  if (!val || val <= 0) { toast('Enter an agreed value','red'); return; }
  const entry = { ..._dlPickerCard, value: val };
  if (_dlPickerSide === 'out') _dlCardsOut.push(entry);
  else _dlCardsIn.push(entry);
  closeModal('dl-card-picker');
  dlRenderCards();
  dlUpdatePnL();
}


function dlUpdateNegPreview() {
  const ask   = parseFloat(document.getElementById('dl-seller-ask')?.value||0);
  const offer = parseFloat(document.getElementById('dl-my-offer')?.value||0);
  const final = parseFloat(document.getElementById('dl-final-price')?.value||0);
  const prev  = document.getElementById('dl-neg-preview');

  if (!ask || !final) { if(prev) prev.style.display='none'; return; }
  if (prev) prev.style.display = 'grid';

  const saved   = ask - final;
  const pct     = ((saved / ask) * 100).toFixed(1);
  const gap     = offer > 0 ? final - offer : null;

  const savedEl = document.getElementById('dl-neg-saved');
  const pctEl   = document.getElementById('dl-neg-pct');
  const gapEl   = document.getElementById('dl-neg-gap');

  if (savedEl) { savedEl.textContent = (saved>=0?'+':'')+'-$'+Math.abs(saved).toFixed(0); savedEl.style.color = saved>=0?'var(--green)':'var(--red)'; }
  if (pctEl)   { pctEl.textContent   = (saved>=0?'-':'+') + Math.abs(pct)+'%'; pctEl.style.color = saved>=0?'var(--green)':'var(--red)'; }
  if (gapEl)   { gapEl.textContent   = gap!=null ? (gap<=0?'✓ Accepted':'↕ $'+Math.abs(gap).toFixed(0)+' gap') : '—'; gapEl.style.color = gap!=null&&gap<=0?'var(--green)':'var(--gold)'; }
}
