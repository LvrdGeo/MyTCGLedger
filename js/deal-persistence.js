/* ════════════════════════════════════════════════════════════════════════════
   MyTCG Ledger V6 - deal-persistence.js
   ────────────────────────────────────────────────────────────────────────────
   DOMAIN MODULE (deal persistence + portfolio application). The FINAL Deals
   layer and the highest-risk extraction since cards-crud: unlike every other
   Deals slice, this one genuinely MUTATES inventory.

   Deals is now fully decomposed:
       deal-log         form UI + private picker      (Batch 25)
       deal-search      discovery + handoffs          (Batch 26)
       deal-rendering   presentation / history        (Batch 27)
       deal-evaluation  retrospective verdicts        (Batch 28)
       deal-persistence save / apply / delete         (this batch)

   OWNS:
     saveDealLog               reads the deal-log form, builds the record,
                               PUSHES onto deals[] (or reassigns deals via map
                               when editing), persists, evaluates
     applyDealToPortfolio      the ONLY path that turns a deal into inventory
     makeCardFromDeal          deal card -> collection record shape
     removeCardFromCollection  qty-aware removal of a traded/sold-away card
     deleteDeal                removal + tombstone
     markDealClosed            reopens the modal in closing mode

   MUTATION CONTRACT - the reason this batch is separate. Verified mechanically:
     deals         push (new deal), whole-array reassign via map (edit),
                   filter-reassign (deleteDeal)
     collection    push (cards acquired), splice / qty-decrement (cards given up)
     soldHistory   UNSHIFT (cards sold through a deal - newest first)
   It is the last module outside cards-crud.js that writes `collection`.
   Persistence goes through the high-level save() / saveSoldHistory() APIs and
   retire() for the deletion tombstone - no IndexedDB, no Supabase, no direct
   localStorage. saveTransactionToDatabase() records the analytics row exactly
   as before.

   DOES NOT OWN: the deal-log form state it reads (deal-log.js owns
   _dlCardsOut/_dlCardsIn/_dealType/_editingDealLogId), deal rendering, deal
   search, deal evaluation (saveDealEvaluation is CALLED here, and stays in
   deal-evaluation.js), cards CRUD, identity/the ledger (retire is called, not
   defined), storage, analytics, sync.

   INBOUND - no real module callers:
     saveDealLog     2 inline HTML handlers on the deal-log modal
     deleteDeal      deal-rendering.js, from GENERATED onclick markup only
     markDealClosed  deal-rendering.js, from GENERATED onclick markup only
     the other three are internal to this file
   deal-log.js does NOT call saveDealLog - the three textual hits in that file
   are header prose, re-confirmed this batch.

   OUTBOUND (all call-time): core (newId, toast, closeModal, showConfirm),
   identity (retire), storage (save, saveSoldHistory), analytics
   (saveTransactionToDatabase), deal-evaluation (saveDealEvaluation),
   deal-rendering (renderDeals), deal-log (openDealLogModal), app (renderAll),
   and the deal-log form globals + #dl-* DOM it reads.

   LOAD-TIME EXECUTION: none. Zero declarations, zero statements.
   ════════════════════════════════════════════════════════════════════════════ */

function saveDealLog(dealStatus) {
  const _status = dealStatus || 'closed';
  // For trade mode — either cards OR cash is valid on each side
  const cashOutVal = parseFloat(document.getElementById('dl-cash-out')?.value||0);
  const cashInVal  = parseFloat(document.getElementById('dl-cash-in-trade')?.value||0);
  const cashInSale = parseFloat(document.getElementById('dl-cash-in')?.value||0);

  const cashPaid = parseFloat(document.getElementById('dl-cash-paid')?.value||0);

  // Pending drafts can be incomplete — only require SOMETHING so we don't save a blank.
  if (_status === 'open') {
    const anything = _dlCardsOut.length || _dlCardsIn.length || cashOutVal || cashInVal || cashInSale || cashPaid;
    if (!anything) { toast('Add at least one card or amount to save a pending deal', 'red'); return; }
  } else if (_dealType === 'purchase') {
    if (!_dlCardsIn.length) { toast('Add at least one card you are buying', 'red'); return; }
    if (!cashPaid) { toast('Enter the cash you paid', 'red'); return; }
  } else if (_dealType === 'sale') {
    if (!_dlCardsOut.length) { toast('Add at least one card you are selling', 'red'); return; }
    if (!cashInSale) { toast('Enter the cash you received', 'red'); return; }
  } else {
    // Trade: need something on each side (card or cash)
    const hasOut = _dlCardsOut.length > 0 || cashOutVal > 0;
    const hasIn  = _dlCardsIn.length  > 0 || cashInVal  > 0;
    if (!hasOut) { toast('Add what you are giving — cards or cash', 'red'); return; }
    if (!hasIn)  { toast('Add what you are receiving — cards or cash', 'red'); return; }
  }

  const outTotal = _dealType === 'purchase'
    ? cashPaid
    : _dlCardsOut.reduce((s,c)=>s+(c.value||0),0) + (_dealType==='trade' ? cashOutVal : 0);
  let   inTotal  = _dealType === 'sale'
    ? cashInSale
    : _dealType === 'purchase'
      ? _dlCardsIn.reduce((s,c)=>s+(c.value||0),0)
      : _dlCardsIn.reduce((s,c)=>s+(c.value||0),0) + cashInVal;

  const data = {
    id:         _editingDealLogId || newId('dl'),
    dealType:   _dealType,
    cardsOut:   _dlCardsOut,
    cardsIn:    _dlCardsIn,
    cashIn:     document.getElementById('dl-cash-in')?.value||'',
    cashOut:    document.getElementById('dl-cash-out')?.value||'',
    cashInTrade:document.getElementById('dl-cash-in-trade')?.value||'',
    outTotal,
    inTotal:    _dealType === 'sale' ? parseFloat(document.getElementById('dl-cash-in').value||0) : _dlCardsIn.reduce((s,c)=>s+(c.value||0),0),
    platform:   document.getElementById('dl-platform').value,
    date:       document.getElementById('dl-date').value,
    sellerAsk:  parseFloat(document.getElementById('dl-seller-ask')?.value||0)||null,
    myOffer:    parseFloat(document.getElementById('dl-my-offer')?.value||0)||null,
    finalPrice: parseFloat(document.getElementById('dl-final-price')?.value||0)||null,
    notes:      document.getElementById('dl-notes').value.trim(),
    status:     _status,
    added:      _editingDealLogId ? (deals.find(x=>x.id===_editingDealLogId)||{}).added : new Date().toISOString(),
    // Legacy compat fields for renderDeals stats
    buyPrice:   outTotal,
    sellPrice:  _dealType === 'sale' ? parseFloat(document.getElementById('dl-cash-in').value||0)
              : _dealType === 'purchase' ? 0
              : _dlCardsIn.reduce((s,c)=>s+(c.value||0),0) + parseFloat(document.getElementById('dl-cash-in-trade').value||0),
    cashPaid:   _dealType === 'purchase' ? cashPaid : '',
    sellPlatform: document.getElementById('dl-platform').value,
    buyPlatform:  document.getElementById('dl-platform').value,
    cardName:   _dealType === 'purchase' ? _dlCardsIn.map(c=>c.name).join(', ') : _dlCardsOut.map(c=>c.name).join(', '),
    img:        _dealType === 'purchase' ? (_dlCardsIn[0]?.img||'') : (_dlCardsOut[0]?.img||''),
    portfolioApplied: (_editingDealLogId ? (deals.find(x=>x.id===_editingDealLogId)||{}).portfolioApplied : false) || false,
  };

  // ── PORTFOLIO CONNECTION ──
  // Apply to collection only when: closed deal + toggle ON + not already applied.
  let portfolioMsg = '';
  if (_status === 'closed' && _dlApplyPortfolio && !data.portfolioApplied) {
    portfolioMsg = applyDealToPortfolio(data);
    data.portfolioApplied = true;
  }

  if (_editingDealLogId) deals = deals.map(x=>x.id===_editingDealLogId?data:x);
  else deals.push(data);
  saveDealEvaluation(data);   // retrospective score for closed deals (no-op when pending)
  save();
  closeModal('deal-log-modal');
  renderAll();
  if (_status === 'open') toast('Saved as pending — find it under Open Deals','gold');
  else toast((portfolioMsg || (_editingDealLogId?'Deal updated':'Deal saved ✓')),'green');
}

// Apply a closed deal's effect to the user's collection.
// Returns a short status message for the toast.
function applyDealToPortfolio(deal) {
  try {
    if (deal.dealType === 'purchase') {
      // Add each bought card to the collection with cost basis split from cash paid.
      const cards = deal.cardsIn || [];
      if (!cards.length) return '';
      const totalMkt = cards.reduce((s,c)=>s+(c.value||0),0);
      const cashPaid = parseFloat(deal.cashPaid||deal.buyPrice||0);
      cards.forEach(card => {
        // Cost basis = proportional share of cash paid (by market value); fallback even split.
        let basis;
        if (totalMkt > 0) basis = cashPaid * ((card.value||0)/totalMkt);
        else basis = cashPaid / cards.length;
        collection.push(makeCardFromDeal(card, basis));
      });
      return `Added ${cards.length} card${cards.length>1?'s':''} to your collection`;
    }

    if (deal.dealType === 'sale') {
      // Remove each sold card; log to Sold History with realized P&L.
      const cards = deal.cardsOut || [];
      const proceeds = parseFloat(deal.sellPrice||0);
      const totalMkt = cards.reduce((s,c)=>s+(c.value||0),0);
      let removed = 0;
      cards.forEach(card => {
        // Find the owned card (for true cost basis) before removing.
        let owned = null;
        if (card.ownedId) owned = collection.find(x=>x.id===card.ownedId);
        if (!owned) {
          const nm=(card.name||'').toLowerCase(), num=(card.num||'').toLowerCase();
          owned = collection.find(c => (c.name||'').toLowerCase()===nm && (c.num||'').toLowerCase()===num);
        }
        const paidBasis = owned ? (parseFloat(owned.paid)||0) : 0;
        // Sale proceeds for this card = proportional share of total proceeds by market value.
        let cardProceeds;
        if (totalMkt > 0) cardProceeds = proceeds * ((card.value||0)/totalMkt);
        else cardProceeds = cards.length ? proceeds/cards.length : 0;
        // Log to Sold History
        soldHistory.unshift({
          id: newId('sold'),
          cardId: card.id||'', name: card.name, set: card.set||'', num: card.num||'',
          img: card.img||'', type: card.grade?'graded':'standard', grade: card.grade||'', cond: card.cond||'',
          paid: paidBasis, soldPrice: +cardProceeds.toFixed(2), marketPrice: card.value||0,
          realizedPnL: +(cardProceeds - paidBasis).toFixed(2), qty: 1,
          soldDate: new Date().toISOString(),
          origCard: owned ? {...owned} : null
        });
        saveTransactionToDatabase({
          client_id:    (owned && owned.id) || card.id || null,
          txn_type:     'sell',
          card_name:    card.name || null,
          quantity:     1,
          unit_price:   +cardProceeds.toFixed(2),
          total_amount: +cardProceeds.toFixed(2),
          cost_basis:   paidBasis,
          realized_pnl: +(cardProceeds - paidBasis).toFixed(2),
          source:       deal.platform || null,
          occurred_at:  new Date().toISOString()
        });
        if (removeCardFromCollection(card)) removed++;
      });
      saveSoldHistory();
      return removed ? `Sold ${removed} card${removed>1?'s':''} · logged to Sold History` : '';
    }

    if (deal.dealType === 'trade') {
      // Remove given cards; carry their total paid cost onto the received cards.
      const given = deal.cardsOut || [];
      const got   = deal.cardsIn  || [];
      // Sum the cost basis of the cards we're giving up (their original paid price if owned).
      let carriedCost = 0;
      given.forEach(card => {
        const owned = card.ownedId ? collection.find(x=>x.id===card.ownedId) : null;
        carriedCost += owned ? (parseFloat(owned.paid)||0) : (card.value||0);
        removeCardFromCollection(card);
      });
      // Add cash we paid into the carried cost (cash out is part of our investment).
      carriedCost += parseFloat(deal.cashOut||0);
      // Distribute carried cost across received cards, proportional to market value.
      const totalGotMkt = got.reduce((s,c)=>s+(c.value||0),0);
      got.forEach(card => {
        let basis;
        if (totalGotMkt > 0) basis = carriedCost * ((card.value||0)/totalGotMkt);
        else basis = got.length ? carriedCost/got.length : 0;
        collection.push(makeCardFromDeal(card, basis));
      });
      return `Updated your collection (−${given.length} / +${got.length})`;
    }
  } catch(e) {
    console.error('[Deal] portfolio apply failed', e);
    return '';
  }
  return '';
}

// Build a collection card record from a deal card entry + cost basis.
function makeCardFromDeal(card, basis) {
  return {
    id: newId('c'),
    name: card.name || 'Unknown',
    set: card.set || '',
    num: card.num || '',
    cardId: card.id || '',
    type: card.grade ? 'graded' : 'standard',
    cond: card.cond || 'NM',
    grade: card.grade || '',
    cert: '',
    qty: 1,
    paid: +(basis||0).toFixed(2),
    source: 'deal',
    notes: '',
    img: card.img || '',
    rarity: '',
    added: new Date().toISOString()
  };
}

// Remove a card from the collection. Prefer exact ownedId match; fall back to name+num.
function removeCardFromCollection(card) {
  let idx = -1;
  if (card.ownedId) idx = collection.findIndex(c => c.id === card.ownedId);
  if (idx < 0) {
    const nm = (card.name||'').toLowerCase(), num = (card.num||'').toLowerCase();
    idx = collection.findIndex(c => (c.name||'').toLowerCase()===nm && (c.num||'').toLowerCase()===num);
  }
  if (idx >= 0) { collection.splice(idx, 1); return true; }
  return false;
}

function deleteDeal(id) {
  showConfirm('Remove deal?', 'This cannot be undone.', () => {
    retire('deal', id);
    deals = deals.filter(x => x.id !== id);
    save(); renderDeals(); toast('Removed', 'red');
  });
}

function markDealClosed(id) {
  openDealLogModal(id);
}
