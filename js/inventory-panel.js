/* ════════════════════════════════════════════════════════════════════════════
   MyTCG Ledger V6 - inventory-panel.js
   ────────────────────────────────────────────────────────────────────────────
   DOMAIN MODULE (inventory drilldown). A single 101-line function, deferred for
   five batches purely on size - it is the last completely isolated leaf in the
   monolith. Justified as a one-function module because it is large, owns a
   distinct UI responsibility, and has no JS callers at all.

   OWNS: the inventory summary / drilldown panel - the four dashboard KPI
   drilldowns ('singles', 'psa', 'sealed', 'month'), their row rendering, images,
   quantities, market values, category totals and empty state.

   DOES NOT OWN: card detail, cards CRUD, cost editor, portfolio calculations,
   dashboard, pricing, valuation formulas, sealed lifecycle, storage, sync,
   identity, search, deals, nav/bootstrap.

   ENTRY POINTS: four STATIC inline HTML handlers on the dashboard KPI tiles -
   openInventoryPanel('singles'|'psa'|'sealed'|'month'). ZERO JavaScript callers
   project-wide; the only other mentions are comments in dashboard.js,
   portfolio.js and card-detail.js recording why it stayed inline.

   CARD-DETAIL EDGE IS UI-LEVEL, NOT A RUNTIME CALL: this function never invokes
   openDetail(). It emits the string
       onclick="closeModal('inventory-panel');setTimeout(()=>openDetail('<id>'),150);"
   into row markup, so openDetail runs only when the user clicks, long after every
   module has loaded. The shape is:
       HTML -> inventory-panel,  and  inventory-panel MARKUP -> card-detail on click.

   MARKET-VALUE CONTRACT (Batch 10, preserved verbatim): values come from the
   canonical helpers cardValue / cardLineValue / itemQty / sealedEffectiveValue /
   cardPriceData. No direct pcache read, no hand-built cache key, no raw
   card.value arithmetic for sealed market value.

   STATE: presentation only. Reads `collection` and `sealed`; writes NOTHING -
   no domain array, no pcache/liqCache, no AppState, no deletion ledger.

   LOAD-TIME DEPENDENCIES: none.
   CALL-TIME DEPENDENCIES:
     core       esc, openModal
     valuation  cardValue, cardLineValue, itemQty, sealedEffectiveValue, cardPriceData
     inline     collection, sealed, and the #inv-panel-title / -count / -total /
                -list DOM
   GENERATED-HANDLER TARGETS (interaction time only): closeModal, openDetail

   LOAD-TIME EXECUTION: none. One function declaration and nothing else.
   ════════════════════════════════════════════════════════════════════════════ */

// ── Inventory Panel ──
function openInventoryPanel(type) {
  const titleEl = document.getElementById('inv-panel-title');
  const countEl = document.getElementById('inv-panel-count');
  const totalEl = document.getElementById('inv-panel-total');
  const listEl  = document.getElementById('inv-panel-list');

  let cards = [];
  let title = '';
  let isSealed = false;

  const now = new Date();

  if (type === 'singles') {
    title = 'Singles';
    cards = collection.filter(c => c.type !== 'graded');
  } else if (type === 'psa') {
    title = 'PSA Slabs';
    cards = collection.filter(c => c.type === 'graded');
  } else if (type === 'sealed') {
    title = 'Sealed Products';
    isSealed = true;
    cards = sealed;
  } else if (type === 'month') {
    title = 'Added This Month';
    cards = collection.filter(c => {
      if (!c.added) return false;
      const d = new Date(c.added);
      return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
    });
  }

  titleEl.textContent = title;

  if (!cards.length) {
    countEl.textContent = '0 items';
    totalEl.textContent = '';
    listEl.innerHTML = `<div style="padding:40px;text-align:center;color:var(--muted);font-size:13px;">No ${title.toLowerCase()} yet.</div>`;
    openModal('inventory-panel');
    return;
  }

  // Calculate totals
  // Header total MUST use the same rules as the rows below it. This previously read
  // the raw manual `value` field for sealed while the rows used sealedEffectiveValue(),
  // so any market-priced sealed product made the header disagree with its own list.
  let totalVal = 0;
  cards.forEach(card => {
    totalVal += isSealed
      ? sealedEffectiveValue(card) * itemQty(card)
      : cardLineValue(card);
  });

  countEl.textContent = cards.length + ' item' + (cards.length !== 1 ? 's' : '');
  totalEl.textContent = totalVal > 0 ? '$' + totalVal.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}) : '';

  if (isSealed) {
    listEl.innerHTML = cards.map(s => {
      const val  = sealedEffectiveValue(s);
      const paid = parseFloat(s.paid||0);
      const pnl  = paid > 0 ? val - paid : null;
      return `<div class="inv-row">
        <div class="inv-row-ph">📦</div>
        <div class="inv-row-info">
          <div class="inv-row-name">${esc(s.name)}</div>
          <div class="inv-row-meta">${esc(s.type||'')}${s.qty>1?' · ×'+esc(s.qty):''}</div>
        </div>
        <div>
          <div class="inv-row-price" style="color:var(--green);">${val>0?'$'+val.toFixed(2):'—'}</div>
          ${pnl!=null?`<div class="inv-row-pnl" style="color:${pnl>=0?'var(--green)':'var(--red)'};">${pnl>=0?'+':''}$${pnl.toFixed(2)}</div>`:''}
        </div>
      </div>`;
    }).join('');
  } else {
    // Sort by value desc
    const sorted = [...cards].map(card => {
      const p  = cardPriceData(card);
      const bp = cardValue(card);
      const img = p?.img || card.img || '';
      const paid = parseFloat(card.paid||0);
      const pnl  = paid > 0 && bp > 0 ? bp - paid : null;
      return { card, bp, img, pnl };
    }).sort((a,b) => b.bp - a.bp);

    listEl.innerHTML = sorted.map(({card, bp, img, pnl}) => `
      <div class="inv-row" onclick="closeModal('inventory-panel');setTimeout(()=>openDetail('${card.id}'),150);">
        ${img
          ? `<img class="inv-row-img" src="${esc(img)}" alt="${esc(card.name)}" loading="lazy">`
          : `<div class="inv-row-ph">⟡</div>`}
        <div class="inv-row-info">
          <div class="inv-row-name">${esc(card.name)}</div>
          <div class="inv-row-meta">${esc(card.set||'')}${card.num?' · #'+esc(card.num):''}${card.grade?' · '+esc(card.grade):''}${card.cond?' · '+esc(card.cond):''}</div>
        </div>
        <div>
          <div class="inv-row-price" style="color:${bp>0?'var(--green)':'var(--muted)'};">${bp>0?'$'+bp.toFixed(2):'—'}</div>
          ${pnl!=null?`<div class="inv-row-pnl" style="color:${pnl>=0?'var(--green)':'var(--red)'};">${pnl>=0?'+':''}$${pnl.toFixed(2)}</div>`:''}
        </div>
      </div>`).join('');
  }

  openModal('inventory-panel');
}
