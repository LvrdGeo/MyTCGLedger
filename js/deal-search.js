/* ════════════════════════════════════════════════════════════════════════════
   MyTCG Ledger V6 - deal-search.js
   ────────────────────────────────────────────────────────────────────────────
   DOMAIN MODULE (deal-specific card discovery). The second Deals slice: the
   search bar on the Deals page that finds a card and hands it to either the
   deal-log modal or the card-detail view. Like deal-log.js it touches NO
   persistent inventory state.

   OWNS: _dealTimer (debounce), onDealSearch, closeDealSearch, doDealSearch,
   openDealCardDetail, dealPickCard.

   DOES NOT OWN: generic search (search.js), the JP catalogue, the deal-log
   modal, deal persistence/apply, deal rendering, deal evaluation, card detail,
   cards CRUD, pricing, valuation, storage, nav.

   CORRECTION TO THE EARLIER GRAPH: this domain was reported as 0 outbound /
   0 inbound. Both were scan artifacts - the mapper only sees still-inline
   symbols, so edges into already-extracted modules were invisible. The real
   picture:
     OUT  deal-log      dlRenderCards, dlUpdatePnL, and it WRITES the deal-log
                        form arrays _dlCardsOut / _dlCardsIn (replace, not push)
          card-detail   openDetail
          search        buildDexNameQuery, getPokemonDexNumber
          core          openModal
     IN   wishlist.js   wishLogDeal -> dealPickCard          (module caller)
          inline HTML   onDealSearch, closeDealSearch, openDealCardDetail
          card-detail   dealPickCard, from a generated template handler
   All call-time. deal-search <-> card-detail is mutual UI collaboration, not
   circular ownership; nothing here runs at load, so no reference resolves during
   evaluation.

   DOCUMENTED PRE-EXISTING BEHAVIOUR: dealPickCard REPLACES _dlCardsOut with a
   single-entry array and clears _dlCardsIn - deal-log's form state, not a
   persistent domain array (it seeds a fresh deal). It never
   touches collection, deals, sealed, wishlist, soldHistory or the ledger, and
   never persists. Moved unchanged; the cross-module write is NOT rewired.

   NETWORK: one catalogue request in doDealSearch. That makes FOUR independent
   direct api.pokemontcg.io consumers (search, wishlist, deal-log, deal-search).
   Recorded as debt, deliberately not consolidated.

   LOAD-TIME EXECUTION: none. One declaration (_dealTimer). No search, no fetch,
   no render, no modal, no mutation.
   ════════════════════════════════════════════════════════════════════════════ */

let _dealTimer = null;

// Card search for deal center
function onDealSearch(val) {
  clearTimeout(_dealTimer);
  document.getElementById('deal-search-clear').style.display = val ? '' : 'none';
  if (!val.trim() || val.length < 3) { closeDealSearch(); return; }
  document.getElementById('deal-search-results').style.display = '';
  document.getElementById('deal-search-grid').innerHTML = '<div class="cs-loading"><div class="spinner"></div>Searching…</div>';
  _dealTimer = setTimeout(() => doDealSearch(val), 500);
}

function closeDealSearch() {
  document.getElementById('deal-search-results').style.display = 'none';
  document.getElementById('deal-search-clear').style.display = 'none';
}

async function doDealSearch(q) {
  const grid = document.getElementById('deal-search-grid');
  try {
    // Support "name + number" + multi-word names (wildcard avoids Lucene 400 errors).
    let _work = q.trim().replace(/^(19|20)\d{2}\s+/, '');
    let _cardNum = null;
    const _nm = _work.match(/\s(\d{1,3})(?:\/\d{1,3})?$/);
    if (_nm) { _cardNum = _nm[1].replace(/^0+/, '') || _nm[1]; _work = _work.slice(0, _nm.index).trim(); }
    const dexNum = getPokemonDexNumber(_work);
    let qStr;
    if (_cardNum && _work) {
      const _loose = _work.replace(/[^A-Za-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
      qStr = `name:*${_loose.replace(/ /g,'*')}* number:${_cardNum}`;
    } else if (dexNum) {
      qStr = buildDexNameQuery(_work || q, dexNum);
    } else {
      const _ln = (_work || q).replace(/[^A-Za-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
      qStr = _ln ? `name:*${_ln.replace(/ /g,'*')}*` : `name:*${_work || q}*`;
    }
    const r = await ptcgFetchOk(`/cards?q=${encodeURIComponent(qStr)}&orderBy=-set.releaseDate&pageSize=120`);
    const j = await r.json();
    if (!j.data?.length) { grid.innerHTML = '<div class="cs-empty">No results.</div>'; return; }
    grid.innerHTML = j.data.map(card => {
      const tier = card.tcgplayer?.prices ? Object.values(card.tcgplayer.prices)[0] : null;
      const price = tier?.market || null;
      const key = 'dsc_' + card.id.replace(/[^a-z0-9]/gi,'_');
      window._dscCards = window._dscCards || {};
      window._dscCards[key] = {id:card.id,name:card.name,set:card.set?.name||'',num:card.number||'',img:card.images?.large||card.images?.small||''};
      return `<div class="cs-card" onclick="openDealCardDetail(window._dscCards['${key}'])">
        <div class="cs-img-wrap">${card.images?.small?`<img src="${card.images.small}" loading="lazy">`:'<div class="cs-img-ph">⟡</div>'}</div>
        <div class="cs-body">
          <div class="cs-set-pill">#${card.number||'?'}</div>
          <div class="cs-name">${esc(card.name)}</div>
          <div class="cs-set">${esc(card.set?.name||'')}</div>
          ${price?`<div class="cs-price">$${price.toFixed(2)}</div>`:'<div class="cs-price" style="color:var(--muted);">—</div>'}
        </div>
        <button class="cs-add" onclick="event.stopPropagation();dealPickCard(window._dscCards['${key}'])">+</button>
      </div>`;
    }).join('');
  } catch(e) { grid.innerHTML = '<div class="cs-empty">Search failed.</div>'; }
}

function openDealCardDetail(c) {
  if(!c) return;
  // Build a not-owned (transient) card so openDetail can show full price + links.
  window._detailTransient = {
    id: c.id, cardId: c.id, name: c.name, set: c.set || '', num: c.num || '',
    img: c.img || '', type: 'standard', cond: 'NM', edition: 'unlimited',
    grade: '', cert: '', paid: '', rarity: '', _transient: true
  };
  openDetail(c.id);
}
function dealPickCard(card) {
  closeDealSearch();
  document.getElementById('deal-search-input').value = '';
  // Open modal and pre-select this card as the first card OUT
  _editingDealLogId = null;
  _dlCardsOut = [{ id:card.id, name:card.name, set:card.set, num:card.num, img:card.img, mkt:null, value:0 }];
  _dlCardsIn  = [];
  _dealType   = 'sale';
  document.getElementById('dl-date').value = new Date().toISOString().slice(0,10);
  document.getElementById('dl-platform').value = '';
  document.getElementById('dl-notes').value = '';
  document.getElementById('dl-cash-in').value = '';
  document.querySelectorAll('#deal-log-modal .type-pill').forEach(b=>b.classList.remove('active'));
  document.getElementById('dl-type-sale').classList.add('active');
  document.getElementById('dl-sale-section').style.display  = '';
  document.getElementById('dl-trade-section').style.display = 'none';
  dlRenderCards();
  dlUpdatePnL();
  openModal('deal-log-modal');
}
