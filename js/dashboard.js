/* ════════════════════════════════════════════════════════════════════════════
   MyTCG Ledger V6 - dashboard.js
   ────────────────────────────────────────────────────────────────────────────
   PRESENTATION / ORCHESTRATION layer. The dashboard presents information owned
   by other domains; it does not absorb them. Several call-time dependencies are
   expected and correct.

   OWNS:
     - chart + range state  _dbChart, _dbRange
     - range control        setDBRange
     - orchestration        renderDashboard  (calls the five widgets, then the
                            chart - order preserved exactly)
     - widgets              renderDBKPIs, renderDBInventory, renderDBConcentration,
                            renderDBTop5, renderDBMovers, renderDBChart
     - cash editor UI       editCashPosition, saveCashPosition

   DOES NOT OWN - each left inline for a specific, traced reason:
     - openInventoryPanel: 101 lines coupled to card detail, the cost editor and
       sealed inventory. Dashboard never calls it; its 4 entry points are inline
       HTML handlers. Ownership outranks physical location - it merely SAT
       between two dashboard blocks.
     - renderDealNegotiation: despite the renderDB name, its only caller is
       renderDeals and it lives 519 lines away. Deal-domain.
     - fmtChartDate: still shared - renderDBChart uses it AND portfolio.js calls
       it twice. Moving it here would create portfolio.js -> dashboard.js.
     - _cashPosition: shared state, not dashboard-private. Written by sync.js
       (applyAppData), importData and clearAll as well as saveCashPosition, and
       it carries a load-time localStorage read. Left with its existing owner;
       the two cash functions below reference it at call time, unchanged.
     - portfolio internals (renderPortfolio/renderTopHoldings/P&L/history/
       timeline all belong to portfolio.js), card CRUD, pricing, valuation,
       storage primitives, scanner, sealed CRUD, collection views, navigation,
       auth, NRV.

   LOAD-TIME DEPENDENCIES: none. Two declarations (_dbChart = null,
   _dbRange = 'all') - no render, no chart, no fetch, no persistence.

   CALL-TIME DEPENDENCIES:
     core       money, moneyFull, esc, toast, openModal
     valuation  cardValue, cardLineValue, cardPriceData, itemQty,
                sealedEffectiveValue, editionBadge
     state      AppState
     storage    portfolioValueSeries, readPortfolioHistory
     inline     collection, sealed, soldHistory, deals, _cashPosition,
                fmtChartDate, fmtPrice, openDetail, Chart (CDN), and the
                #page-dashboard markup
   ════════════════════════════════════════════════════════════════════════════ */

// ══════════════════════════════════════════
// ═══ DASHBOARD ═══
// ══════════════════════════════════════════
let _dbChart = null;
let _dbRange = 'all';

function setDBRange(r, el) {
  _dbRange = r;
  document.querySelectorAll('#page-dashboard .tl-btn').forEach(b => b.classList.remove('active'));
  if (el) el.classList.add('active');
  renderDashboard();
}

function renderDashboard() {
  renderDBKPIs();
  renderDBInventory();
  renderDBConcentration();
  renderDBMovers();
  renderDBTop5();
  // Slight delay for chart so canvas is sized after layout paint
  if (typeof Chart !== 'undefined') {
    renderDBChart();
  } else {
    setTimeout(renderDBChart, 50);
  }
}

function renderDBChart() {
  let pts = portfolioValueSeries().filter(p=>p.v>0);
  if (_dbRange === '3m') pts = pts.slice(-90);
  if (_dbRange === '1m') pts = pts.slice(-30);

  const canvas = document.getElementById('db-chart');
  const labels = document.getElementById('db-chart-labels');
  if (!canvas) return;

  if (typeof Chart === 'undefined') {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js';
    s.onload = () => setTimeout(renderDBChart, 100);
    document.head.appendChild(s);
    return;
  }

  // Make sure canvas has a height before rendering
  if (canvas.parentElement && canvas.parentElement.offsetHeight === 0) {
    setTimeout(renderDBChart, 200);
    return;
  }

  // If only 1 point or no points — seed with a starting point so chart renders
  if (pts.length === 0) {
    // No data yet — show message
    if (_dbChart) { _dbChart.destroy(); _dbChart = null; }
    canvas.style.display = 'none';
    if (labels) labels.innerHTML = '<span style="color:var(--muted);font-size:11px;">Add purchase prices to start tracking your portfolio value over time.</span>';
    return;
  }
  canvas.style.display = '';
  // Always start from $0 — honest baseline
  pts = [{ d: 'Start', v: 0 }, ...pts];

  if (_dbChart) { _dbChart.destroy(); _dbChart = null; }

  if (pts.length < 2) {
    labels.innerHTML = '<span style="color:var(--muted);font-size:11px;">Add purchase prices to build your timeline.</span>';
    return;
  }

  // Baseline for change-% = first REAL (non-zero) snapshot. The old code measured
  // from the forced $0 "Start" point, so pct divided by zero and rendered "(−%)".
  const first = pts.find(p => p.v > 0) || pts[0];
  const last  = pts[pts.length - 1];
  const up = last.v >= first.v;
  const col = up ? '#2ecc80' : '#ff4d6d';
  const colFill = up ? 'rgba(46,204,128,0.16)' : 'rgba(255,77,109,0.16)';
  const colFade = up ? 'rgba(46,204,128,0)' : 'rgba(255,77,109,0)';
  const isNarrow = (window.innerWidth || 800) < 640;

  const readoutEl = document.getElementById('db-chart-readout');
  const changeOf = v => {
    const diff = v - first.v;
    const pct = first.v > 0 ? ` (${diff >= 0 ? '+' : ''}${((diff / first.v) * 100).toFixed(1)}%)` : '';
    return { diff, txt: `${diff >= 0 ? '▲' : '▼'} ${diff >= 0 ? '+' : '−'}$${Math.abs(diff).toLocaleString('en-US', { maximumFractionDigits: 0 })}${pct}` };
  };
  const setReadout = (pt, live) => {
    if (!readoutEl) return;
    const c = changeOf(pt.v);
    readoutEl.innerHTML =
      `<span class="dbr-val">${fmtPrice(pt.v)}</span>` +
      `<span class="dbr-chg" style="color:${c.diff >= 0 ? 'var(--green)' : 'var(--red)'}">${c.txt}</span>` +
      `<span class="dbr-date">${live ? fmtChartDate(pt.d) : fmtChartDate(pt.d) + ' · latest'}</span>`;
  };

  // Crosshair + glow dot drawn on-canvas (replaces the floating tooltip box)
  const crosshairPlugin = {
    id: 'dbCrosshair',
    afterDraw(chart) {
      const act = chart.tooltip && chart.tooltip._active;
      if (!act || !act.length) return;
      const ctx = chart.ctx, el = act[0].element;
      const top = chart.scales.y.top, bottom = chart.scales.y.bottom;
      ctx.save();
      ctx.beginPath(); ctx.moveTo(el.x, top); ctx.lineTo(el.x, bottom);
      ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.setLineDash([4, 4]); ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.arc(el.x, el.y, 9, 0, Math.PI * 2);
      ctx.fillStyle = up ? 'rgba(46,204,128,0.18)' : 'rgba(255,77,109,0.18)'; ctx.fill();
      ctx.beginPath(); ctx.arc(el.x, el.y, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = col; ctx.strokeStyle = '#0b0c11'; ctx.lineWidth = 2; ctx.fill(); ctx.stroke();
      ctx.restore();
    }
  };

  _dbChart = new Chart(canvas, {
    type: 'line',
    plugins: [crosshairPlugin],
    data: {
      labels: pts.map(p => p.d),
      datasets: [{
        data: pts.map(p => p.v),
        borderColor: col, borderWidth: 2.5,
        pointRadius: 0, pointHoverRadius: 0, pointHitRadius: 28,
        tension: 0.35, fill: true,
        backgroundColor: (ctx) => {
          const g = ctx.chart.ctx.createLinearGradient(0, 0, 0, ctx.chart.height);
          g.addColorStop(0, colFill); g.addColorStop(1, colFade); return g;
        }
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      animation: { duration: 300 },
      layout: { padding: { top: 6 } },
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      scales: {
        x: {
          grid: { display: false }, border: { display: false },
          ticks: {
            color: 'rgba(255,255,255,0.28)', font: { family: 'monospace', size: 10 },
            maxTicksLimit: isNarrow ? 4 : 7, maxRotation: 0, autoSkipPadding: 18,
            callback: function (v) { return fmtChartDate(this.getLabelForValue(v)); }
          }
        },
        y: {
          position: 'left',
          grid: { color: 'rgba(255,255,255,0.04)', drawBorder: false }, border: { display: false },
          ticks: {
            color: 'rgba(255,255,255,0.28)', font: { family: 'monospace', size: 10 }, maxTicksLimit: 5,
            callback: v => v === 0 ? '$0' : v >= 1000 ? '$' + (v / 1000).toFixed(v >= 10000 ? 0 : 1) + 'k' : '$' + Math.round(v)
          }
        }
      },
      interaction: { mode: 'index', intersect: false },
      onHover: (e, elements) => {
        if (!elements.length) return;
        const pt = pts[elements[0].index];
        if (pt) setReadout(pt, true);
      }
    }
  });

  // Scrubbing ends → snap the readout back to the latest value (touch AND mouse).
  const resetReadout = () => {
    try { _dbChart.setActiveElements([]); _dbChart.update('none'); } catch (_) {}
    setReadout(last, false);
  };
  canvas.addEventListener('mouseleave', resetReadout);
  canvas.addEventListener('touchend', resetReadout, { passive: true });
  canvas.addEventListener('touchcancel', resetReadout, { passive: true });

  setReadout(last, false);
}

function renderDBKPIs() {
  if (AppState._dirty) AppState.update();
  const totalVal      = AppState.totalValue;
  const totalPaid     = AppState.totalCost;
  const pnl           = AppState.totalPnL;
  const pnlPct        = AppState.totalPnLPct != null ? AppState.totalPnLPct.toFixed(1) : null;
  const cash          = AppState.cashPosition;
  const totalWithCash = totalVal + cash;
  const bestCard      = AppState.bestCard?.card || null;
  const bestGain      = AppState.bestCard?.gain ?? -Infinity;
  const worstCard     = AppState.worstCard?.card || null;
  const worstGain     = AppState.worstCard?.gain ?? Infinity;
  const fmt = v => v >= 1000 ? '$'+v.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}) : fmtPrice(v);

  document.getElementById('db-val').textContent = fmt(totalVal);
  document.getElementById('db-val').style.color = 'var(--green)';
  document.getElementById('db-cost').textContent = totalPaid > 0 ? fmt(totalPaid) : '—';
  
  const pnlEl = document.getElementById('db-pnl');
  const pnlPctEl = document.getElementById('db-pnl-pct');
  if (pnl != null) {
    pnlEl.textContent = (pnl >= 0 ? '+' : '') + fmt(pnl);
    pnlEl.style.color = pnl >= 0 ? 'var(--green)' : 'var(--red)';
    if (pnlPctEl) pnlPctEl.textContent = (pnlPct >= 0 ? '+' : '') + pnlPct + '% ROI';
  } else {
    pnlEl.textContent = '—';
    pnlEl.style.color = 'var(--muted)';
  }

  const cashEl = document.getElementById('db-cash');
  const cashSub = document.getElementById('db-cash-sub');
  cashEl.textContent = cash > 0 ? fmt(cash) : '+ Add';
  cashEl.style.color = cash > 0 ? 'var(--text)' : 'var(--muted)';
  if (cashSub) cashSub.textContent = cash > 0 ? 'Total w/cash: ' + fmt(totalWithCash) : 'click to set';

  const bestNameEl = document.getElementById('db-best-name');
  const bestValEl = document.getElementById('db-best-val');
  if (bestCard && bestGain > -Infinity) {
    bestNameEl.textContent = bestCard.name;
    bestValEl.textContent = '+' + fmt(bestGain);
  } else { bestNameEl.textContent = '—'; }

  const worstNameEl = document.getElementById('db-worst-name');
  const worstValEl = document.getElementById('db-worst-val');
  if (worstCard && worstGain < Infinity) {
    worstNameEl.textContent = worstCard.name;
    worstValEl.textContent = (worstGain >= 0 ? '+' : '') + fmt(worstGain);
    worstValEl.style.color = worstGain >= 0 ? 'var(--green)' : 'var(--red)';
  } else { worstNameEl.textContent = '—'; }
}

function renderDBInventory() {
  if (AppState._dirty) AppState.update();
  document.getElementById('db-cnt-singles').textContent = AppState.singlesCount;
  document.getElementById('db-cnt-psa').textContent     = AppState.slabsCount;
  document.getElementById('db-cnt-sealed').textContent  = AppState.sealedCount;
  document.getElementById('db-cnt-month').textContent   = AppState.addedThisMonth;
}

function renderDBConcentration() {
  const el = document.getElementById('db-concentration');
  if (!el) return;

  const rows = [];
  collection.forEach(card => {
    const val = cardLineValue(card);
    if (val > 0) rows.push({ name: card.name, val });
  });
  sealed.forEach(s => {
    const v = sealedEffectiveValue(s);
    if (v > 0) rows.push({ name: s.name, val: v * itemQty(s) });
  });

  if (!rows.length) { el.innerHTML = '<div style="font-size:12px;color:var(--muted);">No price data yet.</div>'; return; }

  rows.sort((a,b) => b.val - a.val);
  const total = rows.reduce((s,r) => s+r.val, 0);
  const top = rows.slice(0, 5);
  const other = rows.slice(5).reduce((s,r) => s+r.val, 0);
  if (other > 0) top.push({ name: 'Other', val: other });

  const colors = ['#f5c842','#2ecc80','#3b8bff','#ff6b9d','#a78bfa','#888'];
  el.innerHTML = top.map((r, i) => {
    const pct = ((r.val/total)*100).toFixed(1);
    const w = Math.max(2, (r.val/top[0].val)*100);
    return `<div class="db-conc-row">
      <div class="db-conc-name">
        <span style="color:var(--text);font-size:11px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:65%;">${esc(r.name)}</span>
        <span style="font-family:var(--mono);font-size:10px;color:var(--muted);">${pct}% · $${r.val.toLocaleString('en-US',{maximumFractionDigits:0})}</span>
      </div>
      <div class="db-conc-bar">
        <div class="db-conc-fill" style="width:${w}%;background:${colors[i]||'#888'};"></div>
      </div>
    </div>`;
  }).join('');
}


function renderDBTop5() {
  const el = document.getElementById('db-top5');
  if (!el) return;

  const rows = [];
  collection.forEach(card => {
    const p   = cardPriceData(card);
    const bp  = cardValue(card);
    const img = p?.img || card.img || null;
    if (bp > 0) rows.push({ card, bp, img });
  });
  rows.sort((a,b) => b.bp - a.bp);
  const top5 = rows.slice(0, 5);

  if (!top5.length) {
    el.innerHTML = '<div style="grid-column:1/-1;font-size:12px;color:var(--muted);padding:12px 0;">Add cards with prices to see your top holdings.</div>';
    return;
  }

  el.innerHTML = top5.map((r, i) => {
    const card  = r.card;
    const paid  = parseFloat(card.paid || 0);
    const pnl   = paid > 0 ? r.bp - paid : null;
    const pnlPct= paid > 0 ? ((pnl/paid)*100).toFixed(1) : null;
    const pnlCol= pnl == null ? '' : pnl >= 0 ? 'var(--green)' : 'var(--red)';
    const pnlTxt= pnl != null ? (pnl>=0?'+':'')+'$'+Math.abs(pnl).toFixed(0)+' ('+pnlPct+'%)' : '';
    const grade = card.grade || '';

    return `<div class="db-card" onclick="openDetail('${card.id}')">
      <div class="db-card-img">
        ${r.img
          ? `<img src="${esc(r.img)}" alt="${esc(card.name)}" loading="lazy" onerror="this.style.display='none'">`
          : `<div class="db-card-img-ph">⟡</div>`}
      </div>
      <div class="db-card-rank">${i+1}</div>
      ${grade ? `<div class="db-card-grade">${esc(grade.replace('PSA ',''))}</div>` : ''}
      <div class="db-card-body">
        <div class="db-card-name">${esc(card.name)}</div>
        <div class="db-card-set">${esc(card.set||'')}${card.num?' · #'+esc(card.num):''}</div>
        <div class="db-card-price">${fmtPrice(r.bp)}</div>
        ${pnlTxt ? `<div class="db-card-pnl" style="color:${pnlCol};">${pnlTxt}</div>` : ''}
      </div>
    </div>`;
  }).join('');
}

function renderDBMovers() {
  const el = document.getElementById('db-movers');
  if (!el) return;

  const movers = [];
  collection.forEach(card => {
    const bp = cardValue(card);
    const paid = parseFloat(card.paid||0);
    if (bp > 0 && paid > 0) {
      const gain = bp - paid;
      const pct = ((gain/paid)*100).toFixed(1);
      movers.push({ card, bp, gain, pct });
    }
  });

  if (!movers.length) { el.innerHTML = '<div style="font-size:12px;color:var(--muted);">Set cost basis on cards to see movers.</div>'; return; }

  movers.sort((a,b) => Math.abs(b.gain) - Math.abs(a.gain));
  const top = movers.slice(0, 5);

  el.innerHTML = top.map(m => {
    const col = m.gain >= 0 ? 'var(--green)' : 'var(--red)';
    const arrow = m.gain >= 0 ? '▲' : '▼';
    // was pcache[id+'_'+cond] — a pre-edition key format that has not matched
    // cacheKey() since editions were introduced, so this always fell through.
    const img = cardPriceData(m.card)?.img || m.card.img || '';
    return `<div class="db-mover-row" onclick="openDetail('${m.card.id}')" style="cursor:pointer;">
      ${img ? `<img class="db-mover-img" src="${esc(img)}" alt="${esc(m.card.name)}">` : '<div class="db-mover-img" style="background:var(--bg3);display:flex;align-items:center;justify-content:center;font-size:14px;">⟡</div>'}
      <div class="db-mover-info">
        <div class="db-mover-name">${esc(m.card.name)}</div>
        <div class="db-mover-set">${esc(m.card.set||'')}${m.card.grade?' · '+esc(m.card.grade):''}</div>
      </div>
      <div class="db-mover-val" style="color:${col};">${arrow} ${m.gain>=0?'+':''}$${Math.abs(m.gain).toFixed(2)}<div style="font-size:9px;opacity:.7;">${m.gain>=0?'+':''}${m.pct}%</div></div>
    </div>`;
  }).join('');
}

function editCashPosition() {
  const current = _cashPosition > 0 ? _cashPosition.toFixed(2) : '';
  const overlay = document.createElement('div');
  overlay.className = 'cash-edit-modal';
  overlay.id = 'cash-overlay';
  overlay.innerHTML = `
    <div class="cash-edit-inner">
      <div style="font-size:14px;font-weight:600;margin-bottom:4px;">Cash Position</div>
      <div style="font-size:12px;color:var(--muted);margin-bottom:8px;">Money set aside to buy more cards</div>
      <div style="display:flex;align-items:center;gap:8px;">
        <span style="font-family:var(--mono);font-size:16px;color:var(--muted);">$</span>
        <input id="cash-input" class="input" type="number" step="0.01" min="0" value="${current}" placeholder="0.00" style="font-size:16px;font-family:var(--mono);font-weight:600;" autofocus>
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button class="btn btn-ghost btn-sm" onclick="document.getElementById('cash-overlay').remove()">Cancel</button>
        <button class="btn btn-primary btn-sm" onclick="saveCashPosition()">Save</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  setTimeout(() => document.getElementById('cash-input')?.focus(), 50);
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  document.getElementById('cash-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') saveCashPosition();
    if (e.key === 'Escape') overlay.remove();
  });
}

function saveCashPosition() {
  const val = parseFloat(document.getElementById('cash-input')?.value || 0);
  _cashPosition = isNaN(val) || val < 0 ? 0 : val;
  localStorage.setItem(STORAGE_KEYS.cash, _cashPosition.toFixed(2));
  // Cash has no id to merge on, so the only way two devices can agree is a
  // timestamp. Stamp every edit; mergeAppData picks the newer one.
  _cashPositionAt = Date.now();
  localStorage.setItem('pkv2_cash_at', String(_cashPositionAt));
  // cashPosition participates in sync (collectAppData / mergeAppData), but this
  // path never marked the state dirty or queued a push — the edit stayed on one
  // device and could be overwritten by the stale cloud value on the next merge.
  AppState._dirty = true;
  notifyPersisted();
  document.getElementById('cash-overlay')?.remove();
  AppState.update();          // KPIs read AppState.cashPosition, not the raw global
  renderDBKPIs();
  toast('Cash position saved', 'green');
}
