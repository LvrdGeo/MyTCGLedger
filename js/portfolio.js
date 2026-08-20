/* ════════════════════════════════════════════════════════════════════════════
   MyTCG Ledger V6 - portfolio.js
   ────────────────────────────────────────────────────────────────────────────
   DOMAIN MODULE (portfolio presentation). A deliberately NARROW boundary: this
   file renders portfolio-level views from values other layers already computed.
   It is a CONSUMER of the valuation contract, never a pricing engine.

   OWNS:
     - portfolio page      renderPortfolio, renderTopHoldings
     - P&L presentation    pnlRows, setPnlSort, openPnL
     - history views       _phView, _phCharts, setHistoryView,
                           renderPortfolioHistory, renderHistoryCombined,
                           renderHistorySeparate, renderHistoryMonthly,
                           renderHistoryLog, renderHistoryMilestones
     - chart helpers       chartCrosshair, chartScales, chartTooltip,
                           makeGradient (dormant), makeHistoryChart
                           - used ONLY by the history views above
     - timeline            setTLRange, _tlChart, renderTimeline

   DOES NOT OWN - each left inline for a specific reason:
     - renderDashboard + every renderDB* widget: the dashboard is an application
       layer with its own lifecycle (init/goPage/setDBRange/saveCashPosition).
     - openInventoryPanel: a drilldown coupled to card-detail and the cost editor.
     - the liquidity cluster (liqCache/readLiquidity/writeLiquidity/getLiqScore/
       loadLiquidityScore/loadLiquidityForCards): consumed by the singles view, so
       owning it here would make a future cards.js depend on portfolio.
     - PSA/Singles virtualization + tile builders: collection views that call card
       CRUD; they belong with a future cards.js.
     - dlRenderApplyToggle: despite the name, its only callers are deal-log
       functions - it is the deal modal's portfolio picker.
     - renderDealNegotiation: called from renderDeals.
     - fmtChartDate and fmtPrice: shared with dashboard/deals renderers.
     - NRV, history CAPTURE (captureHistorySnapshot lives in storage.js), pricing
       acquisition, sealed pricing, identity, sync, storage primitives.

   LOAD-TIME DEPENDENCIES: none. Three declarations only (_phView, _phCharts,
   _tlChart); nothing renders, fetches or mutates when this file loads.

   CALL-TIME DEPENDENCIES:
     core       money, moneyFull, esc, openModal, fmtDate
     valuation  cardValue, cardLineValue, itemQty, sealedEffectiveValue,
                editionBadge, cardPriceData
     state      AppState
     storage    readPortfolioHistory, portfolioValueSeries
     inline     collection, sealed, soldHistory, deals, tlRange, Chart (CDN),
                portfolioNRV, fmtPrice, fmtChartDate, openDetail, renderTimeline's
                siblings, and the #page-portfolio / #pnl-modal markup.
   ════════════════════════════════════════════════════════════════════════════ */

let _phView = 'combined';
let _phCharts = {};

function setHistoryView(view, el) {
  _phView = view;
  document.querySelectorAll('#port-history-section .tl-btn').forEach(b => b.classList.remove('active'));
  if (el) el.classList.add('active');
  ['combined','separate','monthly','log'].forEach(v => {
    const el = document.getElementById('ph-'+v+'-view');
    if (el) el.style.display = v === view ? '' : 'none';
  });
  renderPortfolioHistory();
}

function renderPortfolioHistory() {
  if (typeof Chart === 'undefined') {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js';
    s.onload = renderPortfolioHistory;
    document.head.appendChild(s);
    return;
  }

  const history = readPortfolioHistory();
  if (!history.length) {
    document.getElementById('port-history-section').style.display = 'none';
    return;
  }
  document.getElementById('port-history-section').style.display = '';

  // Render milestones
  renderHistoryMilestones(history);

  if (_phView === 'combined')  renderHistoryCombined(history);
  if (_phView === 'separate')  renderHistorySeparate(history);
  if (_phView === 'monthly')   renderHistoryMonthly(history);
  if (_phView === 'log')       renderHistoryLog(history);
}

function chartCrosshair(id) {
  return {
    id: 'xhair_'+id,
    afterDraw(chart) {
      if (chart.tooltip._active?.length) {
        const ctx = chart.ctx;
        const x = chart.tooltip._active[0].element.x;
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(x, chart.scales.y.top);
        ctx.lineTo(x, chart.scales.y.bottom);
        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(255,255,255,0.12)';
        ctx.setLineDash([3,4]);
        ctx.stroke();
        ctx.restore();
      }
    }
  };
}

function chartScales(opts={}) {
  return {
    x: {
      grid:{color:'rgba(255,255,255,0.03)',drawBorder:false},
      ticks:{color:'rgba(255,255,255,0.25)',font:{family:'monospace',size:10},maxTicksLimit:opts.xTicks||6,maxRotation:0},
      border:{display:false}
    },
    y: {
      position:'left',
      grid:{color:'rgba(255,255,255,0.03)',drawBorder:false},
      ticks:{color:'rgba(255,255,255,0.25)',font:{family:'monospace',size:10},maxTicksLimit:5,
        callback:v=>v===0?'$0':v>=1000?'$'+(v/1000).toFixed(v>=10000?0:1)+'k':'$'+Math.round(v)},
      border:{display:false}
    }
  };
}

function chartTooltip(opts={}) {
  return {
    mode:'index', intersect:false,
    backgroundColor:'rgba(10,10,18,0.97)',
    borderColor: opts.borderColor||'rgba(255,255,255,0.15)', borderWidth:1,
    titleColor:'rgba(255,255,255,0.45)',
    bodyColor:'#fff',
    bodyFont:{family:'monospace',size:opts.bodySize||14,weight:'700'},
    titleFont:{family:'monospace',size:10},
    padding:12, displayColors:opts.multiLine||false,
    cornerRadius:10,
    callbacks: opts.callbacks || {
      label: ctx => '$'+ctx.parsed.y.toLocaleString('en-US',{minimumFractionDigits:0,maximumFractionDigits:0})
    }
  };
}

function makeGradient(ctx, col, opacity=0.18) {
  const g = ctx.chart.ctx.createLinearGradient(0,0,0,ctx.chart.height);
  g.addColorStop(0, col.replace(')',`,${opacity})`).replace('rgb','rgba'));
  g.addColorStop(0.65, col.replace(')',',0.03)').replace('rgb','rgba'));
  g.addColorStop(1,'rgba(0,0,0,0)');
  return g;
}

function makeHistoryChart(canvasId, datasets, labels) {
  if (_phCharts[canvasId]) { _phCharts[canvasId].destroy(); delete _phCharts[canvasId]; }
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;

  // Apply revamped style to each dataset — matched to the Portfolio Timeline look
  const styledDatasets = datasets.map((ds, i) => ({
    ...ds,
    borderWidth: ds.borderWidth || 2.5,
    pointRadius: 0,
    pointHoverRadius: 7,
    pointHoverBackgroundColor: '#fff',
    pointHoverBorderColor: ds.borderColor,
    pointHoverBorderWidth: 2.5,
    tension: 0.4,
    ...(ds.fill !== false ? {
      fill: true,
      backgroundColor: ctx => {
        const g = ctx.chart.ctx.createLinearGradient(0,0,0,ctx.chart.height);
        const col = ds.borderColor || '#2ecc80';
        // Deep gradient with a mid fade, like the timeline
        g.addColorStop(0, col+'28');
        g.addColorStop(0.65, col+'08');
        g.addColorStop(1, col+'00');
        return g;
      }
    } : {})
  }));

  _phCharts[canvasId] = new Chart(canvas, {
    type: 'line',
    plugins: [chartCrosshair(canvasId)],
    data: { labels, datasets: styledDatasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: datasets.length > 1,
          labels: { color: 'rgba(255,255,255,0.4)', font:{family:'monospace',size:10}, boxWidth:10, padding:12, usePointStyle:true }
        },
        tooltip: chartTooltip({ multiLine: datasets.length > 1,
          callbacks: { label: ctx => {
            const ds = datasets[ctx.datasetIndex];
            if (ds && typeof ds._tooltip === 'function') return ds._tooltip(ctx);
            return (ctx.dataset.label?ctx.dataset.label+': ':'')+'$'+ctx.parsed.y.toLocaleString('en-US',{maximumFractionDigits:0});
          } }
        })
      },
      scales: chartScales({ xTicks: 8 }),
      interaction: { mode:'index', intersect:false }
    }
  });
}

function renderHistoryCombined(history) {
  // Prepend a $0 'Start' baseline so the line rises from zero — like the Portfolio Timeline.
  const labels = ['Start', ...history.map(s => s.date.slice(5))]; // MM-DD
  const valueData      = [0, ...history.map(s => s.totalValue || 0)];
  const costData       = [0, ...history.map(s => s.costBasis || 0)];
  const totalPnLData   = [0, ...history.map(s => (s.unrealizedPnL||0) + (s.realizedPnL||0))];
  const firstVal = history[0]?.totalValue || 0;

  makeHistoryChart('ph-combined-chart', [
    {
      label: 'Portfolio Value',
      data: valueData,
      borderColor: '#2ecc80',
      fill: true,
      // Richer tooltip: value + gain/loss vs first tracked day, with arrow + %
      _tooltip: (ctx) => {
        const v = ctx.parsed.y;
        const diff = v - firstVal;
        const pct = firstVal > 0 ? ((diff/firstVal)*100).toFixed(1) : null;
        const sign = diff>=0?'+':''; const arrow = diff>=0?'▲':'▼';
        return ['Portfolio Value: $'+v.toLocaleString('en-US',{maximumFractionDigits:0}),
          pct ? `${arrow} ${sign}$${Math.abs(diff).toLocaleString('en-US',{maximumFractionDigits:0})} (${sign}${pct}%)` : ''].filter(Boolean);
      }
    },
    {
      label: 'Cost Basis',
      data: costData,
      borderColor: 'rgba(255,255,255,0.2)', borderWidth: 1.5,
      borderDash: [4,4],
      fill: false,
      backgroundColor: 'transparent'
    },
    {
      label: 'Total P&L',
      data: totalPnLData,
      borderColor: '#f5c842', borderWidth: 1.5,
      fill: false,
      backgroundColor: 'transparent'
    }
  ], labels);

  // Summary labels
  const first = history[0];
  const last  = history[history.length-1];
  const gain  = (last.totalValue||0) - (first.totalValue||0);
  const gainPct = first.totalValue > 0 ? ((gain/first.totalValue)*100).toFixed(1) : null;
  const lbl = document.getElementById('ph-combined-labels');
  if (lbl) lbl.innerHTML = `
    <span>${first.date}: <b>$${(first.totalValue||0).toLocaleString('en-US',{maximumFractionDigits:0})}</b></span>
    <span style="color:${gain>=0?'var(--green)':'var(--red)'};font-weight:600;">${gain>=0?'▲ +':'▼ '}$${Math.abs(gain).toLocaleString('en-US',{maximumFractionDigits:0})} (${gainPct||'—'}%)</span>
    <span>${last.date}: <b>$${(last.totalValue||0).toLocaleString('en-US',{maximumFractionDigits:0})}</b></span>`;
}

function renderHistorySeparate(history) {
  const labels         = history.map(s => s.date.slice(5));
  const unrealizedData = history.map(s => s.unrealizedPnL || 0);
  const realizedData   = history.map(s => s.realizedPnL || 0);

  const upCol   = '#2ecc80';
  const dealCol = '#f5c842';

  makeHistoryChart('ph-unrealized-chart', [{
    label: 'Unrealized P&L',
    data: unrealizedData,
    borderColor: upCol, borderWidth: 2,
    pointRadius: 0, pointHoverRadius: 5,
    tension: 0.4, fill: true,
    backgroundColor: ctx => {
      const g = ctx.chart.ctx.createLinearGradient(0,0,0,ctx.chart.height);
      g.addColorStop(0,'rgba(46,204,128,0.2)'); g.addColorStop(1,'rgba(46,204,128,0)'); return g;
    }
  }], labels);

  makeHistoryChart('ph-realized-chart', [{
    label: 'Realized P&L',
    data: realizedData,
    borderColor: dealCol, borderWidth: 2,
    pointRadius: 0, pointHoverRadius: 5,
    tension: 0.4, fill: true,
    backgroundColor: ctx => {
      const g = ctx.chart.ctx.createLinearGradient(0,0,0,ctx.chart.height);
      g.addColorStop(0,'rgba(245,200,66,0.2)'); g.addColorStop(1,'rgba(245,200,66,0)'); return g;
    }
  }], labels);
}

function renderHistoryMonthly(history) {
  const grid = document.getElementById('ph-monthly-grid');
  if (!grid) return;

  // Group by month
  const months = {};
  history.forEach(s => {
    const m = s.date.slice(0, 7); // YYYY-MM
    if (!months[m]) months[m] = [];
    months[m].push(s);
  });

  const monthKeys = Object.keys(months).sort();
  grid.innerHTML = monthKeys.map(m => {
    const snaps    = months[m];
    const first    = snaps[0];
    const last     = snaps[snaps.length-1];
    const change   = (last.totalValue||0) - (first.totalValue||0);
    const pct      = first.totalValue > 0 ? ((change/first.totalValue)*100).toFixed(1) : null;
    const col      = change >= 0 ? 'var(--green)' : 'var(--red)';
    const monthName = new Date(m+'-01').toLocaleDateString('en-US',{month:'short',year:'2-digit'});
    const realizedM = snaps[snaps.length-1].realizedPnL - snaps[0].realizedPnL;

    return `<div style="background:var(--bg2);border:1px solid var(--border);border-radius:var(--r2);padding:12px;${change>=0?'border-top:2px solid var(--green)':'border-top:2px solid var(--red)'}">
      <div style="font-family:var(--mono);font-size:10px;color:var(--muted);margin-bottom:6px;">${monthName}</div>
      <div style="font-family:var(--mono);font-size:16px;font-weight:700;color:${col};">${change>=0?'+':''}$${Math.abs(change).toLocaleString('en-US',{maximumFractionDigits:0})}</div>
      <div style="font-family:var(--mono);font-size:10px;color:${col};margin-bottom:8px;">${pct?`${change>=0?'+':''}${pct}%`:'—'}</div>
      <div style="font-size:10px;color:var(--muted);font-family:var(--mono);">End: $${(last.totalValue||0).toLocaleString('en-US',{maximumFractionDigits:0})}</div>
      <div style="font-size:10px;color:var(--muted);font-family:var(--mono);">${last.cardCount||0} cards</div>
      ${realizedM!==0?`<div style="font-size:10px;font-family:var(--mono);color:var(--gold);margin-top:4px;">Deals: ${realizedM>=0?'+':''}$${Math.abs(realizedM).toFixed(0)}</div>`:''}
    </div>`;
  }).join('');
}

function renderHistoryLog(history) {
  const logEl = document.getElementById('ph-log-list');
  if (!logEl) return;

  const sorted = [...history].reverse();
  logEl.innerHTML = sorted.map((s, i) => {
    const prev   = sorted[i+1];
    const change = prev ? (s.totalValue||0) - (prev.totalValue||0) : null;
    const col    = change == null ? 'var(--muted)' : change >= 0 ? 'var(--green)' : 'var(--red)';

    return `<div style="display:flex;align-items:center;gap:12px;padding:8px 0;border-bottom:1px solid var(--border);">
      <div style="font-family:var(--mono);font-size:11px;color:var(--muted);width:80px;flex-shrink:0;">${s.date}</div>
      <div style="flex:1;">
        <span style="font-family:var(--mono);font-size:12px;font-weight:600;">$${(s.totalValue||0).toLocaleString('en-US',{maximumFractionDigits:0})}</span>
        ${change!=null?`<span style="font-family:var(--mono);font-size:10px;color:${col};margin-left:8px;">${change>=0?'+':''}$${Math.abs(change).toLocaleString('en-US',{maximumFractionDigits:0})}</span>`:''}
      </div>
      <div style="font-family:var(--mono);font-size:10px;color:var(--muted);flex-shrink:0;">${s.cardCount||0} cards · ${s.slabCount||0} slabs</div>
      ${s.unrealizedPnL?`<div style="font-family:var(--mono);font-size:10px;color:${s.unrealizedPnL>=0?'var(--green)':'var(--red)'};flex-shrink:0;">P&L: ${s.unrealizedPnL>=0?'+':''}$${Math.abs(s.unrealizedPnL).toLocaleString('en-US',{maximumFractionDigits:0})}</div>`:''}
    </div>`;
  }).join('');
}

function renderHistoryMilestones(history) {
  const el = document.getElementById('ph-milestones');
  if (!el) return;

  const milestones = [1000,2500,5000,10000,25000,50000,100000];
  const maxVal = Math.max(...history.map(s => s.totalValue||0));
  const achieved = [];

  milestones.forEach(m => {
    if (maxVal >= m) {
      const snap = history.find(s => (s.totalValue||0) >= m);
      if (snap) achieved.push({ amount: m, date: snap.date });
    }
  });

  const next = milestones.find(m => maxVal < m);
  const current = history[history.length-1]?.totalValue || 0;
  const nextPct  = next ? ((current/next)*100).toFixed(0) : null;

  el.innerHTML = achieved.map(a => `
    <div style="display:inline-flex;align-items:center;gap:6px;background:rgba(245,200,66,.1);border:1px solid rgba(245,200,66,.3);border-radius:20px;padding:4px 12px;font-family:var(--mono);font-size:10px;">
      🏆 <span style="color:var(--gold);font-weight:700;">$${a.amount>=1000?(a.amount/1000)+'k':a.amount}</span>
      <span style="color:var(--muted);">${a.date}</span>
    </div>`).join('') +
    (next ? `<div style="display:inline-flex;align-items:center;gap:6px;background:var(--bg3);border:1px solid var(--border);border-radius:20px;padding:4px 12px;font-family:var(--mono);font-size:10px;color:var(--muted);">
      Next: $${next>=1000?(next/1000)+'k':next} · ${nextPct}% there
    </div>` : '');
}

function renderPortfolio(){
  let totalVal=0,totalPaid=0,singlesVal=0,singlesPaid=0,psaVal=0,psaPaid=0,sealedVal=0,sealedPaid=0;
  collection.forEach(card=>{
    const val=cardLineValue(card);const paid=parseFloat(card.paid||0)*itemQty(card);
    totalVal+=val;if(paid>0)totalPaid+=paid;
    if(card.type==='graded'){psaVal+=val;if(paid>0)psaPaid+=paid;}
    else{singlesVal+=val;if(paid>0)singlesPaid+=paid;}
  });
  sealed.forEach(prod=>{
    const q=itemQty(prod);const val=sealedEffectiveValue(prod)*q;const paid=parseFloat(prod.paid||0)*q;
    totalVal+=val;sealedVal+=val;if(paid>0){totalPaid+=paid;sealedPaid+=paid;}
  });
  const pnl=totalPaid>0?totalVal-totalPaid:null;
  const pct=pnl!=null&&totalPaid>0?((pnl/totalPaid)*100).toFixed(1):null;
  document.getElementById('port-total').textContent='$'+totalVal.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
  // NRV header (separate aggregator; does not touch AppState/market value)
  (function(){const row=document.getElementById('nrv-port-row');if(!row)return;const val=document.getElementById('port-realizable');const lbl=document.getElementById('nrv-port-lbl');const tog=document.getElementById('nrv-port-toggle');const on=!!NRV.shown;if(val){val.textContent=on?(totalVal>0?moneyFull(portfolioNRV()):'—'):'';val.style.display=on?'':'none';}if(lbl)lbl.style.opacity=on?'1':'0.5';if(tog){tog.style.background=on?'var(--green)':'transparent';const k=tog.firstElementChild;if(k){k.style.left=on?'17px':'2px';k.style.background=on?'#fff':'var(--muted)';}tog.setAttribute('aria-pressed',on?'true':'false');}})();
  const chip=document.getElementById('port-pnl-chip');const meta=document.getElementById('port-meta');
  if(pnl!=null){chip.style.display='';chip.className='pnl-chip '+(pnl>=0?'pnl-up':'pnl-dn');chip.textContent=(pnl>=0?'+':'')+fmtPrice(pnl)+' ('+pct+'%)';meta.textContent='vs $'+totalPaid.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})+' cost basis';}
  else{chip.style.display='none';meta.textContent='Add purchase prices to see P&L';}
  document.getElementById('port-cost').textContent=totalPaid>0?'$'+totalPaid.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}):'—';
  document.getElementById('port-pnl').textContent=pnl!=null?(pnl>=0?'+':'')+fmtPrice(pnl):'—';
  if(pnl!=null)document.getElementById('port-pnl').style.color=pnl>=0?'var(--green)':'var(--red)';
  document.getElementById('port-roi').textContent=pct?pct+'%':'—';
  if(pct)document.getElementById('port-roi').style.color=pnl>=0?'var(--green)':'var(--red)';
  document.getElementById('port-updated').textContent='Updated '+new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
  // Categories
  const fC=(val,paid,pct2)=>{const p2=val-paid;const r=paid>0?((p2/paid)*100).toFixed(1):null;return{val:'$'+val.toLocaleString('en-US',{maximumFractionDigits:0}),pnl:paid>0?(p2>=0?'+':'')+fmtPrice(p2):null,pct:r,up:p2>=0};};
  const sc=fC(singlesVal,singlesPaid);const gc=fC(psaVal,psaPaid);const pc2=fC(sealedVal,sealedPaid);
  document.getElementById('cat-singles-val').textContent=sc.val;
  document.getElementById('cat-singles-pnl').textContent=sc.pnl?sc.pnl+(sc.pct?' ('+sc.pct+'%)':''):'';
  document.getElementById('cat-singles-pnl').style.color=sc.pnl?(sc.up?'var(--green)':'var(--red)'):'';
  document.getElementById('cat-singles-cnt').textContent=collection.filter(c=>c.type!=='graded').reduce((s,c)=>s+(c.qty||1),0)+' cards';
  document.getElementById('cat-psa-val').textContent=gc.val;
  document.getElementById('cat-psa-pnl').textContent=gc.pnl?gc.pnl+(gc.pct?' ('+gc.pct+'%)':''):'';
  document.getElementById('cat-psa-pnl').style.color=gc.pnl?(gc.up?'var(--green)':'var(--red)'):'';
  document.getElementById('cat-psa-cnt').textContent=collection.filter(c=>c.type==='graded').reduce((s,c)=>s+(c.qty||1),0)+' slabs';
  document.getElementById('cat-sealed-val').textContent=pc2.val;
  document.getElementById('cat-sealed-pnl').textContent=pc2.pnl?pc2.pnl+(pc2.pct?' ('+pc2.pct+'%)':''):'';
  document.getElementById('cat-sealed-pnl').style.color=pc2.pnl?(pc2.up?'var(--green)':'var(--red)'):'';
  document.getElementById('cat-sealed-cnt').textContent=sealed.reduce((s,p)=>s+(p.qty||1),0)+' items';
  renderTopHoldings();renderTimeline();
  renderPortfolioHistory();
}

function renderTopHoldings(){
  const rows=[];
  collection.forEach(card=>{const p=cardPriceData(card);const val=cardLineValue(card);const paid=parseFloat(card.paid||0)*itemQty(card);const pnl=val>0&&paid>0?val-paid:null;rows.push({name:card.name,meta:(card.set||'')+(card.grade?' · '+card.grade:' · '+card.cond),val,pnl,img:p?.img||card.img||null,id:card.id});});
  rows.sort((a,b)=>b.val-a.val);
  const el=document.getElementById('top-holdings');
  if(!rows.length||!rows[0].val){el.innerHTML='<p style="font-size:12px;color:var(--muted);padding:10px 0;">Add cards and purchase prices to see top holdings.</p>';return;}
  el.innerHTML=rows.slice(0,8).map((r,i)=>`<div class="holding-row" onclick="openDetail('${r.id}')">
    <div style="font-family:var(--mono);font-size:11px;color:var(--muted);width:18px;flex-shrink:0;">${i+1}</div>
    <div class="himg">${r.img?`<img src="${esc(r.img)}" alt="${esc(r.name)}" loading="lazy">`:'⟡'}</div>
    <div class="hinfo"><div class="holding-name">${esc(r.name)}</div><div class="holding-meta">${esc(r.meta)}</div></div>
    <div class="hright"><div class="hval">${fmtPrice(r.val)}</div>${r.pnl!=null?`<div class="hpnl" style="color:${r.pnl>=0?'var(--green)':'var(--red)'};">${r.pnl>=0?'+':''}${fmtPrice(r.pnl)}</div>`:''}</div>
  </div>`).join('');
}

// ═══ PROFIT & LOSS WINDOW ═══
let _pnlSort = 'pnl';
function pnlRows(){
  const rows = [];
  collection.forEach(card=>{
    const p = cardPriceData(card);
    const qty = itemQty(card);
    const val = cardLineValue(card);
    const cost = parseFloat(card.paid||0)*qty;
    const pnl = (val>0 && cost>0) ? val-cost : null;
    const pct = (pnl!=null && cost>0) ? (pnl/cost)*100 : null;
    rows.push({ id:card.id, name:card.name,
      meta:(card.set||'Unknown')+(card.grade?' · '+card.grade:' · '+card.cond)+(qty>1?' · ×'+qty:''),
      edition:cardEdition(card), img:(p&&p.img)||card.img||null, val, cost, pnl, pct });
  });
  sealed.forEach(prod=>{
    const qty = itemQty(prod);
    const val = sealedEffectiveValue(prod)*qty;
    const cost = parseFloat(prod.paid||0)*qty;
    const pnl = (val>0 && cost>0) ? val-cost : null;
    const pct = (pnl!=null && cost>0) ? (pnl/cost)*100 : null;
    rows.push({ id:prod.id, name:prod.name, meta:(prod.set||'Sealed')+(qty>1?' · ×'+qty:''),
      edition:'unlimited', img:prod.img||null, val, cost, pnl, pct });
  });
  return rows;
}
function setPnlSort(s){ _pnlSort=s; openPnL(); }
function openPnL(){
  const rows = pnlRows();
  let totalVal=0, totalCost=0;
  rows.forEach(r=>{ totalVal+=r.val; if(r.cost>0) totalCost+=r.cost; });
  const totalPnl = totalCost>0 ? totalVal-totalCost : null;
  const totalPct = (totalPnl!=null && totalCost>0) ? (totalPnl/totalCost)*100 : null;
  let realized=0, realizedCount=0;
  (soldHistory||[]).forEach(e=>{ if(e.soldPrice!=null && e.paid!=null){ realized += (e.soldPrice - e.paid)*(e.qty||1); realizedCount++; } });
  const sortFns = {
    pnl:  (a,b)=>(b.pnl==null?-Infinity:b.pnl)-(a.pnl==null?-Infinity:a.pnl),
    loss: (a,b)=>(a.pnl==null?Infinity:a.pnl)-(b.pnl==null?Infinity:b.pnl),
    pct:  (a,b)=>(b.pct==null?-Infinity:b.pct)-(a.pct==null?-Infinity:a.pct),
    value:(a,b)=>b.val-a.val,
    name: (a,b)=>a.name.localeCompare(b.name),
  };
  rows.sort(sortFns[_pnlSort]||sortFns.pnl);
  const winners = rows.filter(r=>r.pnl!=null && r.pnl>0).length;
  const losers  = rows.filter(r=>r.pnl!=null && r.pnl<0).length;
  const col = v => v>=0?'var(--green)':'var(--red)';
  const sgn = v => (v>=0?'+':'−')+'$'+Math.abs(v).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
  const stat = (label,big,bigColor,sub)=>`<div style="background:var(--bg3);border-radius:var(--r);padding:12px 14px;"><div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;font-family:var(--mono);">${label}</div><div style="font-size:19px;font-weight:700;margin-top:3px;${bigColor?'color:'+bigColor+';':''}">${big}</div>${sub?`<div style="font-size:10px;color:var(--muted);margin-top:2px;">${sub}</div>`:''}</div>`;
  const summary = `<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px;">
    ${stat('Market Value', fmtPrice(totalVal), '', '')}
    ${stat('Cost Basis', totalCost>0?fmtPrice(totalCost):'—', '', '')}
    ${stat('Unrealized P&L', totalPnl!=null?sgn(totalPnl)+(totalPct!=null?' ('+(totalPct>=0?'+':'')+totalPct.toFixed(1)+'%)':''):'—', totalPnl!=null?col(totalPnl):'', winners+' up · '+losers+' down')}
    ${stat('Realized P&L', realizedCount?sgn(realized):'—', realizedCount?col(realized):'', realizedCount?realizedCount+' sold':'no sales yet')}
  </div>`;
  const sortBtn = (key,label)=>`<button onclick="setPnlSort('${key}')" style="flex:1;padding:7px 4px;border-radius:8px;font-size:11px;font-weight:600;cursor:pointer;border:1px solid ${_pnlSort===key?'var(--gold)':'var(--border)'};background:${_pnlSort===key?'rgba(245,200,66,.15)':'var(--bg3)'};color:${_pnlSort===key?'var(--gold)':'var(--muted2)'};white-space:nowrap;">${label}</button>`;
  const sorter = `<div style="display:flex;gap:6px;margin-bottom:10px;">${sortBtn('pnl','Gainers')}${sortBtn('loss','Losers')}${sortBtn('pct','% chg')}${sortBtn('value','Value')}${sortBtn('name','Name')}</div>`;
  const priced = rows.filter(r=>r.val>0 || r.cost>0);
  const list = priced.length ? priced.map(r=>`<div onclick="closeModal('pnl-modal');openDetail('${r.id}')" style="display:flex;align-items:center;gap:11px;padding:9px 4px;border-bottom:1px solid var(--border);cursor:pointer;">
    <div style="width:34px;height:46px;border-radius:5px;overflow:hidden;flex-shrink:0;background:var(--bg3);display:flex;align-items:center;justify-content:center;">${r.img?`<img src="${esc(r.img)}" alt="" loading="lazy" style="width:100%;height:100%;object-fit:cover;">`:'<span style="opacity:.4;">⟡</span>'}</div>
    <div style="flex:1;min-width:0;"><div style="font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(r.name)}${r.edition&&r.edition!=='unlimited'?' '+editionBadge({edition:r.edition}):''}</div><div style="font-size:11px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(r.meta)}</div></div>
    <div style="text-align:right;flex-shrink:0;"><div style="font-family:var(--mono);font-weight:600;font-size:13px;">${r.val>0?fmtPrice(r.val):'—'}</div>${r.pnl!=null?`<div style="font-family:var(--mono);font-size:11px;color:${col(r.pnl)};">${sgn(r.pnl)}${r.pct!=null?' · '+(r.pct>=0?'+':'')+r.pct.toFixed(0)+'%':''}</div>`:'<div style="font-size:10px;color:var(--muted);">no cost basis</div>'}</div>
  </div>`).join('') : '<p style="font-size:12px;color:var(--muted);padding:16px 0;text-align:center;">No priced holdings yet. Add cards with purchase prices to see profit &amp; loss.</p>';
  document.getElementById('pnl-body').innerHTML = summary + sorter + list;
  openModal('pnl-modal');
}

function setTLRange(r,el){tlRange=r;document.querySelectorAll('.tl-btn').forEach(b=>b.classList.remove('active'));el.classList.add('active');renderTimeline();}

let _tlChart = null;
function renderTimeline(){
  // ph2 was filtered to v>0 before use, the vh fallback was not — preserved exactly.
  const _series = portfolioValueSeries();
  const history = readPortfolioHistory().length ? _series.filter(p=>p.v>0) : _series;

  const empty=document.getElementById('tl-empty');
  const labels=document.getElementById('tl-labels');

  // Also save a vh snapshot for legacy compat
  let totalVal=0;
  collection.forEach(card=>{totalVal+=cardLineValue(card);});
  sealed.forEach(prod=>{const v=sealedEffectiveValue(prod);if(v>0)totalVal+=v*itemQty(prod);});
  if(totalVal>0){
    const today=new Date().toLocaleDateString('en-US',{month:'short',day:'numeric',year:'2-digit'});
    const last=history[history.length-1];
    if(!last||last.d!==today)history.push({d:today,v:+totalVal.toFixed(2)});
    else last.v=+totalVal.toFixed(2);
  }

  let pts=[...history].filter(p=>p.v>0);
  if(tlRange==='3m')pts=pts.slice(-90);
  if(tlRange==='1m')pts=pts.slice(-30);

  if(pts.length===0){empty.style.display='';if(_tlChart){_tlChart.destroy();_tlChart=null;}labels.innerHTML='<span style="color:var(--muted);font-size:11px;">Prices loading… refresh to build your timeline.</span>';return;}
  // Always start from $0 — honest baseline before any tracking began
  pts=[{d:'Start',v:0},...pts];
  empty.style.display='none';

  const canvas=document.getElementById('tl-canvas');
  if(!canvas)return;
  if(typeof Chart==='undefined'){
    const s=document.createElement('script');
    s.src='https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js';
    s.onload=renderTimeline;
    document.head.appendChild(s);
    return;
  }
  if(_tlChart){_tlChart.destroy();_tlChart=null;}

  // Same engine as the dashboard timeline: fixed readout above (no floating tooltip
  // covering the line), %-baseline from the first REAL value, short dates, fat touch
  // targets, snap-back on release.
  const first = pts.find(p=>p.v>0) || pts[0];
  const last  = pts[pts.length-1];
  const up    = last.v >= first.v;
  const col   = up?'#2ecc80':'#ff4d6d';
  const colFill = up?'rgba(46,204,128,0.16)':'rgba(255,77,109,0.16)';
  const colFade = up?'rgba(46,204,128,0)':'rgba(255,77,109,0)';
  const isNarrow = (window.innerWidth||800) < 640;
  const readoutEl = document.getElementById('tl-chart-readout');

  const setReadout = (pt, live) => {
    if(!readoutEl) return;
    const diff = pt.v - first.v;
    const pct  = first.v>0 ? ` (${diff>=0?'+':''}${((diff/first.v)*100).toFixed(1)}%)` : '';
    readoutEl.innerHTML =
      `<span class="dbr-val">${fmtPrice(pt.v)}</span>`+
      `<span class="dbr-chg" style="color:${diff>=0?'var(--green)':'var(--red)'}">${diff>=0?'▲':'▼'} ${diff>=0?'+':'−'}$${Math.abs(diff).toLocaleString('en-US',{maximumFractionDigits:0})}${pct}</span>`+
      `<span class="dbr-date">${fmtChartDate(pt.d)}${live?'':' · latest'}</span>`;
  };

  const crosshairPlugin = {
    id:'tlCrosshair',
    afterDraw(chart){
      const act = chart.tooltip && chart.tooltip._active;
      if(!act || !act.length) return;
      const ctx=chart.ctx, el=act[0].element;
      ctx.save();
      ctx.beginPath(); ctx.moveTo(el.x, chart.scales.y.top); ctx.lineTo(el.x, chart.scales.y.bottom);
      ctx.lineWidth=1; ctx.strokeStyle='rgba(255,255,255,0.18)'; ctx.setLineDash([4,4]); ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.arc(el.x, el.y, 9, 0, Math.PI*2);
      ctx.fillStyle = up?'rgba(46,204,128,0.18)':'rgba(255,77,109,0.18)'; ctx.fill();
      ctx.beginPath(); ctx.arc(el.x, el.y, 4.5, 0, Math.PI*2);
      ctx.fillStyle=col; ctx.strokeStyle='#0b0c11'; ctx.lineWidth=2; ctx.fill(); ctx.stroke();
      ctx.restore();
    }
  };

  _tlChart = new Chart(canvas, {
    type:'line',
    plugins:[crosshairPlugin],
    data:{ labels:pts.map(p=>p.d), datasets:[{
      data:pts.map(p=>p.v), borderColor:col, borderWidth:2.5,
      pointRadius:0, pointHoverRadius:0, pointHitRadius:28,
      tension:0.35, fill:true,
      backgroundColor:(c)=>{const g=c.chart.ctx.createLinearGradient(0,0,0,c.chart.height);g.addColorStop(0,colFill);g.addColorStop(1,colFade);return g;}
    }]},
    options:{
      responsive:true, maintainAspectRatio:false, animation:{duration:300},
      layout:{padding:{top:6}},
      plugins:{legend:{display:false}, tooltip:{enabled:false}},
      scales:{
        x:{ grid:{display:false}, border:{display:false},
            ticks:{color:'rgba(255,255,255,0.28)',font:{family:'monospace',size:10},
                   maxTicksLimit:isNarrow?4:7,maxRotation:0,autoSkipPadding:18,
                   callback:function(v){return fmtChartDate(this.getLabelForValue(v));}} },
        y:{ position:'left', grid:{color:'rgba(255,255,255,0.04)',drawBorder:false}, border:{display:false},
            ticks:{color:'rgba(255,255,255,0.28)',font:{family:'monospace',size:10},maxTicksLimit:5,
                   callback:v=>v===0?'$0':v>=1000?'$'+(v/1000).toFixed(v>=10000?0:1)+'k':'$'+Math.round(v)} }
      },
      interaction:{mode:'index',intersect:false},
      onHover:(e,els)=>{ if(els.length){const pt=pts[els[0].index]; if(pt) setReadout(pt,true);} }
    }
  });

  const resetTL = () => { try{_tlChart.setActiveElements([]);_tlChart.update('none');}catch(_){}; setReadout(last,false); };
  canvas.addEventListener('mouseleave', resetTL);
  canvas.addEventListener('touchend', resetTL, {passive:true});
  canvas.addEventListener('touchcancel', resetTL, {passive:true});
  setReadout(last,false);
}

// ════════════════════════════════════════════════════════════════════════════
// REHOMED IN FINAL MIGRATION - portfolio-level Net Realizable Value.
// Deferred since Batch 2 ("portfolioNRV -> portfolio.js, not valuation.js").
// ════════════════════════════════════════════════════════════════════════════
function portfolioNRV(){
  let total = 0;
  collection.forEach(card => {
    const bp = cardValue(card);
    const r  = nrvForCard(card, bp);
    if (r.realizable != null) total += r.realizable * itemQty(card);
  });
  sealed.forEach(prod => {
    const r = nrvForCard({ type:'sealed', paid: prod.paid }, sealedEffectiveValue(prod));
    if (r.realizable != null) total += r.realizable * itemQty(prod);
  });
  return total;
}
