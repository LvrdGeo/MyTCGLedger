/* ════════════════════════════════════════════════════════════════════════════
   MyTCG Ledger V6 - cost-editor.js
   ────────────────────────────────────────────────────────────────────────────
   DOMAIN MODULE (acquisition cost / cost basis). One contiguous run, seven
   functions: editing and persisting the `paid` field on existing collection
   records. It edits cost; it never computes market value.

   OWNS:
     - inline row editor  startEditCost, saveCostBasis, cancelEditCost
                          (the per-card edit control inside the detail modal)
     - bulk editor modal  openCostBasisEditor, updateCostRow,
                          updateCostEditorTotal, closeCostEditor

   DOES NOT OWN:
     - market value: reads it through the canonical contract (cardValue) and
       NEVER recomputes it. No pcache access, no pricing engine, no valuation
       formula lives here.
     - card CRUD (saveCard/editCard/deleteCard/openAddModal), the card-detail
       modal (openDetail/repriceCard/buildPricingEvidence/loadActiveListings and
       the Evidence Explorer all stay inline), the inventory panel, PSA/Singles
       rendering, portfolio calculations, storage infrastructure, sync, scanner,
       sealed CRUD.

   STATE: mutates exactly one thing - `card.paid` on a record already in
   `collection`, found by id. It never adds, removes or reorders records, and
   never touches sealed / wishlist / soldHistory / deals / pcache / liqCache /
   AppState / the deletion ledger. Quantity is NOT editable here; qty is read
   only to multiply the displayed line total.

   RERENDER CONTRACT (call-time, order and count preserved verbatim):
     saveCostBasis     -> save(), then in-place DOM updates
     closeCostEditor   -> renderPortfolio(), renderPSA(), renderAnalyzer()
     saveCostBasis/... -> renderAnalyzer() where it already did
   These are dependencies, not ownership. Do not consolidate them.

   LOAD-TIME DEPENDENCIES: none. Zero declarations, zero executable statements -
   this file is seven function declarations and nothing else.

   CALL-TIME DEPENDENCIES:
     core       money, moneyFull, esc, toast, closeModal, openModal
     valuation  cardValue, itemQty
     storage    save
     portfolio  renderPortfolio
     collection-views  renderPSA
     inline     collection, renderAnalyzer, and the #cost-editor-overlay /
                #cost-display-<id> / #cost-input-<id> markup
   ════════════════════════════════════════════════════════════════════════════ */

function startEditCost(cardId) {
  const display = document.getElementById('cost-display-' + cardId);
  if (!display) return;
  const card = collection.find(c => c.id === cardId);
  if (!card) return;
  const current = card.paid ? parseFloat(card.paid).toFixed(2) : '';

  display.innerHTML = `
    <div class="cost-edit-wrap">
      <input class="cost-edit-input" id="cost-input-${cardId}" type="number" step="0.01" min="0"
        value="${current}" placeholder="0.00"
        onkeydown="if(event.key==='Enter')saveCostBasis('${cardId}');if(event.key==='Escape')cancelEditCost('${cardId}');"
        onclick="event.stopPropagation()">
      <div class="cost-edit-actions">
        <button class="cost-save-btn" onclick="event.stopPropagation();saveCostBasis('${cardId}')">Save</button>
        <button class="cost-cancel-btn" onclick="event.stopPropagation();cancelEditCost('${cardId}')">Cancel</button>
      </div>
    </div>`;

  // Focus and select the input
  setTimeout(() => {
    const inp = document.getElementById('cost-input-' + cardId);
    if (inp) { inp.focus(); inp.select(); }
  }, 30);
}

function saveCostBasis(cardId) {
  const inp  = document.getElementById('cost-input-' + cardId);
  if (!inp) return;
  const val  = parseFloat(inp.value);
  const card = collection.find(c => c.id === cardId);
  if (!card) return;

  card.paid = isNaN(val) || val <= 0 ? '' : val.toFixed(2);
  save();

  // Update the display inline without closing the modal
  const display = document.getElementById('cost-display-' + cardId);
  if (display) {
    display.innerHTML = card.paid
      ? '$' + parseFloat(card.paid).toFixed(2)
      : '<span style="color:var(--muted);font-size:12px;">+ Add</span>';
  }

  // Recalculate gain/loss in the mini-stats
  const best = cardValue(card);
  const roi  = card.paid && best > 0 ? best - parseFloat(card.paid) : null;
  const roiPct = roi != null ? ((best / parseFloat(card.paid) - 1) * 100).toFixed(1) : null;
  const glEl = document.querySelector('#detail-inner .mini-stat-val[data-gl]');

  // Re-render the gain/loss cell
  const glCells = document.querySelectorAll('#detail-inner .mini-stat');
  glCells.forEach(cell => {
    if (cell.querySelector('.mini-stat-lbl')?.textContent?.trim() === 'GAIN / LOSS') {
      cell.querySelector('.mini-stat-val').textContent =
        roi != null
          ? (roi >= 0 ? '+' : '') + '$' + roi.toFixed(2) + ' (' + roiPct + '%)'
          : '—';
      cell.querySelector('.mini-stat-val').style.color =
        roi == null ? 'var(--muted)' : roi >= 0 ? 'var(--green)' : 'var(--red)';
    }
  });

  // Update portfolio totals
  renderPortfolio();
  renderPSA();
  renderAnalyzer();
  toast('Cost basis updated', 'green');
}

function cancelEditCost(cardId) {
  const card    = collection.find(c => c.id === cardId);
  const display = document.getElementById('cost-display-' + cardId);
  if (!display || !card) return;
  display.innerHTML = card.paid
    ? '$' + parseFloat(card.paid).toFixed(2)
    : '<span style="color:var(--muted);font-size:12px;">+ Add</span>';
}


function openCostBasisEditor() {
  const list  = document.getElementById('cost-editor-list');
  const total = document.getElementById('cost-editor-total');

  list.innerHTML = collection.map(card => {
    const best = cardValue(card);
    const paid = parseFloat(card.paid || 0);
    const roi  = best > 0 && paid > 0 ? best - paid : null;
    const roiPct = roi != null ? ((roi / paid) * 100).toFixed(1) : null;
    const pnlColor = roi == null ? 'var(--muted)' : roi >= 0 ? 'var(--green)' : 'var(--red)';
    const pnlText  = roi != null ? (roi >= 0 ? '+' : '') + '$' + roi.toFixed(2) + ' (' + roiPct + '%)' : '—';

    return `<div class="cost-row">
      ${card.img
        ? `<img class="cost-row-img" src="${esc(card.img)}" alt="${esc(card.name)}">`
        : `<div class="cost-row-img-ph">⟡</div>`}
      <div class="cost-row-info">
        <div class="cost-row-name">${esc(card.name)}</div>
        <div class="cost-row-meta">${esc(card.set||'')}${card.grade ? ' · ' + esc(card.grade) : ' · ' + esc(card.cond||'NM')}${best > 0 ? ' · Now $' + best.toFixed(2) : ''}</div>
      </div>
      <div class="cost-row-input-wrap">
        <span class="cost-row-prefix">$</span>
        <input class="cost-row-input" type="number" step="0.01" min="0"
          value="${paid > 0 ? paid.toFixed(2) : ''}"
          placeholder="0.00"
          data-card-id="${card.id}"
          onchange="updateCostRow(this)"
          onkeydown="if(event.key==='Enter')this.blur()">
      </div>
      <div class="cost-row-pnl" style="color:${pnlColor};" id="pnl-row-${card.id}">${pnlText}</div>
    </div>`;
  }).join('');

  updateCostEditorTotal();

  openModal('cost-editor-overlay');
}

function updateCostRow(input) {
  const cardId = input.dataset.cardId;
  const card   = collection.find(c => c.id === cardId);
  if (!card) return;

  const val  = parseFloat(input.value);
  card.paid  = isNaN(val) || val <= 0 ? '' : val.toFixed(2);
  save();

  // Update the P&L cell for this row
  const best = cardValue(card);
  const paid = parseFloat(card.paid || 0);
  const roi  = best > 0 && paid > 0 ? best - paid : null;
  const roiPct = roi != null ? ((roi / paid) * 100).toFixed(1) : null;
  const pnlEl = document.getElementById('pnl-row-' + cardId);
  if (pnlEl) {
    pnlEl.textContent = roi != null ? (roi >= 0 ? '+' : '') + '$' + roi.toFixed(2) + ' (' + roiPct + '%)' : '—';
    pnlEl.style.color = roi == null ? 'var(--muted)' : roi >= 0 ? 'var(--green)' : 'var(--red)';
  }

  updateCostEditorTotal();
  renderPortfolio();
}

function updateCostEditorTotal() {
  const totalEl = document.getElementById('cost-editor-total');
  let totalPaid = 0, totalVal = 0;
  collection.forEach(card => {
    const paid = parseFloat(card.paid || 0);
    // was bestPrice(p) with no isGraded flag — graded slabs were valued here with
    // the RAW engine, so this total disagreed with every other screen.
    const best = cardValue(card);
    if (paid > 0) totalPaid += paid * itemQty(card);
    if (best > 0) totalVal  += best * itemQty(card);
  });
  const pnl = totalPaid > 0 ? totalVal - totalPaid : null;
  totalEl.textContent = totalPaid > 0
    ? 'Total cost basis: $' + totalPaid.toFixed(2) + (pnl != null ? '  ·  P&L: ' + (pnl >= 0 ? '+' : '') + '$' + pnl.toFixed(2) : '')
    : 'No cost basis set yet';
}

function closeCostEditor() {
  closeModal('cost-editor-overlay');
  renderPortfolio();
  renderPSA();
  renderAnalyzer();
}
