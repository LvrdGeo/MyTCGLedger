/* ════════════════════════════════════════════════════════════════════════════
   MyTCG Ledger V6 - wishlist.js
   ────────────────────────────────────────────────────────────────────────────
   DOMAIN MODULE (watchlist). One contiguous run: the whole "// ═══ WISHLIST ═══"
   section. Owns watchlist lifecycle, presentation and its own price-cache
   namespace - and nothing beneath it.

   OWNS:
     - lifecycle       removeWish, addToWatchlistFromSearch, moveWishToVault,
                       wishAddToPortfolio, wishLogDeal
     - in-page search  _wishTimer, openWishSearch, closeWishSearch,
                       _wishSearchMode, onWishSearch
     - charts          _wcView, _wcCharts, setWishChart, renderWishCharts,
                       renderWishValueChart, renderWishBreakdownChart,
                       renderWishSparklines
     - history capture captureWishSnapshot  (WRITES via storage.js's
                       readWishHistory/writeWishHistory - it does not own the keys)
     - detail          openWishCard, openWishDetail
     - price cache     wishCacheKey, wishPriceData, _wishTried, WISH_RETRY_MS
                       Namespace 'wish_<id>' with a tolerant read of the retired
                       'wish_<id>_NM_unlimited' key. UNCHANGED - not redesigned,
                       not migrated, not separated.
     - page            renderWishlist
     - WISH_HISTORY_KEY: dormant. The live path is storage.js via
                       STORAGE_KEYS.wishHistory; this const has no reader. Moved
                       unchanged rather than removed (no dead-code removal).

   DOES NOT OWN:
     - generic search / catalogue: onWishSearch calls getPokemonDexNumber,
       buildDexNameQuery, buildNameQuery and searchCountLine at call time. The
       picker cluster (pickerConfirm / addToWatchlistFromPicker) also stays inline
       - it belongs to the add-form/search region. wishlist -> search, never
       wishlist owns search.
     - pricing acquisition: fetchLivePrices / getPrices / bestPrice stay in
       pricing.js and valuation.js.
     - wish-history MERGE: mergeWishHistory and _wishSeries remain in sync.js. Its
       per-date union, ascending sort, local-wins collision and malformed-point
       handling are a sync contract and are untouched.
     - history persistence: readWishHistory / writeWishHistory stay in storage.js.
     - deletion ledger: removeWish calls retire('wishlist', id) - identity.js owns
       the tombstone; this file only requests it.
     - card detail: openWishCard / openWishDetail call openDetail at call time.

   LOAD-TIME DEPENDENCIES: none. Six declarations only (_wishTimer, _wcView,
   _wcCharts, WISH_HISTORY_KEY, _wishTried, WISH_RETRY_MS) - no render, no fetch,
   no cache write, no persistence.

   CALL-TIME DEPENDENCIES:
     core       esc, money, moneyFull, toast, openModal, closeModal, newId
     valuation  bestPrice, cardEdition
     identity   retire
     storage    save, readWishHistory, writeWishHistory, idbPut
     pricing    fetchLivePrices
     inline     wishlist, pcache, collection, Chart (CDN), openDetail,
                prefillAddForm, dealPickCard, the search helpers listed above,
                and the #page-wishlist markup
   ════════════════════════════════════════════════════════════════════════════ */

// ═══ WISHLIST ═══
// (2026-08) REMOVED: addWish() — read #wish-input, an element that does not exist
// anywhere in the document, and had zero callers (no inline handler, no string
// invocation, no dynamic lookup). Watchlist entries are created by wishAdd* /
// pickerConfirm(), which are unaffected.
function removeWish(id){retire('wishlist',id);wishlist=wishlist.filter(w=>w.id!==id);save();renderWishlist();}

let _wishTimer = null;
function openWishSearch(){
  const bar=document.getElementById('wish-search-bar');
  if(!bar) return;
  bar.style.display='';
  const inp=document.getElementById('wish-search-input');
  // iOS Safari only raises the keyboard when focus() runs SYNCHRONOUSLY inside the
  // tap gesture — the old setTimeout(…,100) broke that chain, so tapping "Add First
  // Card" appeared to do nothing (the bar was often already visible).
  if(inp){
    try{ inp.focus({preventScroll:true}); }catch(_){ try{ inp.focus(); }catch(__){} }
    try{ inp.setSelectionRange(inp.value.length, inp.value.length); }catch(_){}
  }
  // Bring it into view and flash the border so the target is unmistakable.
  try{ bar.scrollIntoView({block:'nearest', behavior:'smooth'}); }catch(_){}
  const box=bar.querySelector('.card-search-bar');
  if(box){
    box.classList.add('cs-bar-flash');
    setTimeout(()=>box.classList.remove('cs-bar-flash'),900);
  }
}
function closeWishSearch(){
  document.getElementById('wish-search-bar').style.display='none';
  document.getElementById('wish-search-results').style.display='none';
  document.getElementById('wish-search-input').value='';
  _wishSearchMode(false);
}
// While a watchlist search is active, collapse the "Nothing on your watchlist"
// empty state and the sort row — they were eating the bottom half of the screen and
// squeezing results into a tiny scroll box.
function _wishSearchMode(on){
  const empty = document.getElementById('wish-empty');
  const sortRow = document.getElementById('wish-sort-row');
  if (empty) {
    if (on) { if (empty.style.display !== 'none') { empty.dataset.wasShown='1'; empty.style.display='none'; } }
    else if (empty.dataset.wasShown === '1') { empty.style.display=''; delete empty.dataset.wasShown; }
  }
  if (sortRow) sortRow.style.display = on ? 'none' : '';
  document.body.classList.toggle('wish-searching', !!on);
}

function onWishSearch(val){
  clearTimeout(_wishTimer);
  const res=document.getElementById('wish-search-results');
  if(!val.trim()||val.length<3){res.style.display='none';_wishSearchMode(false);const c=document.getElementById('wish-search-count');if(c)c.style.display='none';return;}
  res.style.display='';
  _wishSearchMode(true);
  document.getElementById('wish-search-grid').innerHTML='<div class="cs-loading"><div class="spinner"></div>Searching…</div>';
  _wishTimer=setTimeout(async()=>{
    try{
      const dexNum=getPokemonDexNumber(val);
      const qStr=dexNum?buildDexNameQuery(val, dexNum):buildNameQuery(val);
      const r=await ptcgFetchOk(`/cards?q=${encodeURIComponent(qStr)}&orderBy=-set.releaseDate&pageSize=250`);
      const j=await r.json();
      const _cnt=document.getElementById('wish-search-count');
      if(!j.data?.length){
        if(_cnt){_cnt.style.display='none';}
        document.getElementById('wish-search-grid').innerHTML='<div class="cs-empty">No results.</div>';return;}
      if(_cnt){
        _cnt.innerHTML = searchCountLine(j, val).replace(/^<div[^>]*>/,'').replace(/<\/div>$/,'');
        _cnt.style.display='';
      }
      document.getElementById('wish-search-grid').innerHTML=j.data.map(card=>{
        const tier=card.tcgplayer?.prices?Object.values(card.tcgplayer.prices)[0]:null;
        const price=tier?.market||null;
        const key='ws_'+card.id.replace(/[^a-z0-9]/gi,'_');
        const alreadyWatching=wishlist.some(w=>w.cardId===card.id||(w.name===card.name&&w.set===card.set?.name));
        window._wsCards=window._wsCards||{};
        window._wsCards[key]={id:card.id,name:card.name,set:card.set?.name||'',num:card.number||'',img:card.images?.large||card.images?.small||'',rarity:card.rarity||''};
        return `<div class="cs-card" onclick="addToWatchlistFromSearch(window._wsCards['${key}'])">
          <div class="cs-img-wrap">${card.images?.small?`<img src="${card.images.small}" alt="${card.name}" loading="lazy">`:'<div class="cs-img-ph">⟡</div>'}</div>
          <div class="cs-body">
            <div class="cs-set-pill">#${card.number||'?'}</div>
            <div class="cs-name">${esc(card.name)}</div>
            <div class="cs-set">${esc(card.set?.name||'')}</div>
            ${price?`<div class="cs-price">$${price.toFixed(2)}</div>`:'<div class="cs-price" style="color:var(--muted);">—</div>'}
          </div>
          <button class="cs-add" style="${alreadyWatching?'background:var(--green);opacity:1;':''}">${alreadyWatching?'✓':'+'}</button>
        </div>`;
      }).join('');
    }catch(e){document.getElementById('wish-search-grid').innerHTML='<div class="cs-empty">Search failed.</div>';}
  },400);
}
function addToWatchlistFromSearch(card){
  if(wishlist.some(w=>w.cardId===card.id||(w.name===card.name&&w.set===card.set))){toast('Already watching','gold');return;}
  wishlist.push({id:newId('w'),name:card.name,set:card.set||'',num:card.num||'',cardId:card.id||'',img:card.img||'',rarity:card.rarity||'',edition:'unlimited',type:'single',grade:'',added:new Date().toISOString()});
  save();renderWishlist();
  closeWishSearch();
  toast(card.name+' added to watchlist','green');
}


// ── Watchlist Charts ──
let _wcView = 'value';
let _wcCharts = {};
const WISH_HISTORY_KEY = 'pkv2_wh'; // daily price snapshots per watched card

function setWishChart(view, el) {
  _wcView = view;
  document.querySelectorAll('#wish-charts .tl-btn').forEach(b => b.classList.remove('active'));
  if (el) el.classList.add('active');
  document.getElementById('wc-value-view').style.display     = view === 'value'     ? '' : 'none';
  document.getElementById('wc-breakdown-view').style.display = view === 'breakdown' ? '' : 'none';
  renderWishCharts();
}

function captureWishSnapshot() {
  // Save today's prices for all watched cards
  const history = readWishHistory();
  const today   = new Date().toISOString().slice(0, 10);
  let totalVal  = 0;

  wishlist.forEach(w => {
    const p    = wishPriceData(w);
    const best = p ? bestPrice(p) : 0;
    if (best > 0) {
      if (!history[w.id]) history[w.id] = [];
      const last = history[w.id][history[w.id].length-1];
      if (!last || last.d !== today) history[w.id].push({ d: today, v: best });
      else last.v = best;
      totalVal += best;
    }
  });

  // Save combined total
  if (!history._total) history._total = [];
  const lastTotal = history._total[history._total.length-1];
  if (totalVal > 0) {
    if (!lastTotal || lastTotal.d !== today) history._total.push({ d: today, v: totalVal });
    else lastTotal.v = totalVal;
  }

  writeWishHistory(history);
}

function renderWishCharts() {
  if (typeof Chart === 'undefined') {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js';
    s.onload = renderWishCharts;
    document.head.appendChild(s);
    return;
  }

  const hasCards = wishlist.length > 0;
  const chartsEl = document.getElementById('wish-charts');
  if (!hasCards) { if (chartsEl) chartsEl.style.display = 'none'; return; }
  if (chartsEl) chartsEl.style.display = '';

  if (_wcView === 'value')     renderWishValueChart();
  if (_wcView === 'breakdown') renderWishBreakdownChart();
  renderWishSparklines();
}

function renderWishValueChart() {
  const history = readWishHistory();
  // GUARD (maintainability batch): points are read from localStorage, which can be
  // corrupted or hand-edited. mergeWishHistory already drops malformed points on
  // the SYNC path, but a bad LOCAL write would reach the chart and throw on p.d.
  // Filtering here keeps the existing "fewer than 2 points" empty state.
  const pts = (history._total || []).filter(p => p && p.d != null && p.v != null);

  if (_wcCharts.value) { _wcCharts.value.destroy(); delete _wcCharts.value; }
  const canvas = document.getElementById('wc-value-chart');
  if (!canvas) return;

  if (pts.length < 2) {
    canvas.parentElement.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;font-size:12px;color:var(--muted);">Price history builds up as you keep the app open daily.</div>';
    return;
  }

  const labels = pts.map(p => p.d.slice(5));
  const values = pts.map(p => p.v);
  const up = values[values.length-1] >= values[0];
  const col = up ? '#2ecc80' : '#ff4d6d';

  _wcCharts.value = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        data: values,
        borderColor: col, borderWidth: 2,
        pointRadius: 0, pointHoverRadius: 5,
        tension: 0.4, fill: true,
        backgroundColor: ctx => {
          const g = ctx.chart.ctx.createLinearGradient(0,0,0,ctx.chart.height);
          g.addColorStop(0, up?'rgba(46,204,128,0.15)':'rgba(255,77,109,0.15)');
          g.addColorStop(1, 'rgba(0,0,0,0)'); return g;
        }
      }]
    },
    options: {
      responsive:true, maintainAspectRatio:false,
      plugins: {
        legend:{display:false},
        tooltip:{
          mode:'index',intersect:false,
          backgroundColor:'rgba(15,15,22,0.95)',
          borderColor:'rgba(255,255,255,0.1)',borderWidth:1,
          titleColor:'rgba(255,255,255,0.5)',bodyColor:col,
          bodyFont:{family:'monospace',size:12,weight:'700'},
          titleFont:{family:'monospace',size:10},padding:10,displayColors:false,
          callbacks:{label:ctx=>'$'+ctx.parsed.y.toLocaleString('en-US',{maximumFractionDigits:0})}
        }
      },
      scales:{
        x:{grid:{color:'rgba(255,255,255,0.03)',drawBorder:false},ticks:{color:'rgba(255,255,255,0.25)',font:{family:'monospace',size:10},maxTicksLimit:6,maxRotation:0},border:{display:false}},
        y:{grid:{color:'rgba(255,255,255,0.03)',drawBorder:false},ticks:{color:'rgba(255,255,255,0.25)',font:{family:'monospace',size:10},maxTicksLimit:4,callback:v=>v===0?'$0':v>=1000?'$'+(v/1000).toFixed(1)+'k':'$'+Math.round(v)},border:{display:false}}
      },
      interaction:{mode:'index',intersect:false}
    }
  });

  const gain = values[values.length-1] - values[0];
  const lbl = document.getElementById('wc-value-labels');
  if (lbl) lbl.innerHTML = `
    <span>${pts[0].d}: <b>$${values[0].toLocaleString('en-US',{maximumFractionDigits:0})}</b></span>
    <span style="color:${col};font-weight:600;">${gain>=0?'▲ +':'▼ '}$${Math.abs(gain).toLocaleString('en-US',{maximumFractionDigits:0})}</span>
    <span>${pts[pts.length-1].d}: <b>$${values[values.length-1].toLocaleString('en-US',{maximumFractionDigits:0})}</b></span>`;
}

function renderWishBreakdownChart() {
  if (_wcCharts.breakdown) { _wcCharts.breakdown.destroy(); delete _wcCharts.breakdown; }
  const canvas = document.getElementById('wc-breakdown-chart');
  if (!canvas) return;

  const items = wishlist.map(w => {
    const p    = wishPriceData(w);
    const best = p ? bestPrice(p) : 0;
    return { name: w.name.length > 16 ? w.name.slice(0,14)+'…' : w.name, val: best };
  }).filter(i => i.val > 0).sort((a,b) => b.val - a.val);

  if (!items.length) {
    canvas.parentElement.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;font-size:12px;color:var(--muted);">Prices loading…</div>';
    return;
  }

  const colors = ['#f5c842','#2ecc80','#3b8bff','#ff6b9d','#a78bfa','#ff9500','#2ecc80','#ff4d6d'];

  _wcCharts.breakdown = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: items.map(i => i.name),
      datasets: [{
        data: items.map(i => i.val),
        backgroundColor: items.map((_, i) => colors[i % colors.length] + '99'),
        borderColor:     items.map((_, i) => colors[i % colors.length]),
        borderWidth: 1.5,
        borderRadius: 4,
      }]
    },
    options: {
      indexAxis: 'y',
      responsive:true, maintainAspectRatio:false,
      plugins:{
        legend:{display:false},
        tooltip:{
          backgroundColor:'rgba(10,10,18,0.97)',
          borderColor:'rgba(255,255,255,0.15)',borderWidth:1,
          bodyColor:'#fff',bodyFont:{family:'monospace',size:14,weight:'700'},
          titleColor:'rgba(255,255,255,0.45)',titleFont:{family:'monospace',size:10},
          padding:12,displayColors:false,cornerRadius:10,
          callbacks:{label:ctx=>'$'+ctx.parsed.x.toLocaleString('en-US',{maximumFractionDigits:0})}
        }
      },
      scales:{
        x:{grid:{color:'rgba(255,255,255,0.03)',drawBorder:false},ticks:{color:'rgba(255,255,255,0.25)',font:{family:'monospace',size:10},callback:v=>v>=1000?'$'+(v/1000).toFixed(1)+'k':'$'+v},border:{display:false}},
        y:{grid:{display:false},ticks:{color:'rgba(255,255,255,0.5)',font:{family:'monospace',size:10}},border:{display:false}}
      }
    }
  });
}

function renderWishSparklines() {
  // Draw mini sparkline on each card using canvas 2D
  wishlist.forEach(w => {
    const canvas = document.getElementById('wsp-'+w.id);
    if (!canvas) return;
    const history = readWishHistory();
    const pts = (history[w.id] || []).map(p => p.v);

    // If no history, build a simulated sparkline from trend data
    const p    = wishPriceData(w);
    const best = p ? bestPrice(p) : 0;
    if (!pts.length && best > 0) {
      const trend = p?.trend30 || 0;
      const start = best / (1 + trend/100);
      for (let i = 0; i < 10; i++) {
        const t = i/9;
        pts.push(start + (best-start)*t + (Math.random()-.5)*best*0.03);
      }
      pts[pts.length-1] = best;
    }

    if (pts.length < 2) return;

    const ctx    = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    const min  = Math.min(...pts) * 0.98;
    const max  = Math.max(...pts) * 1.02;
    const range = max - min || 1;
    const toX  = i => (i / (pts.length-1)) * W;
    const toY  = v => H - ((v-min)/range) * H;

    const up  = pts[pts.length-1] >= pts[0];
    const col = up ? '#2ecc80' : '#ff4d6d';

    // Fill
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, up ? 'rgba(46,204,128,0.25)' : 'rgba(255,77,109,0.25)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.beginPath();
    ctx.moveTo(toX(0), toY(pts[0]));
    pts.forEach((v,i) => ctx.lineTo(toX(i), toY(v)));
    ctx.lineTo(toX(pts.length-1), H);
    ctx.lineTo(0, H);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // Line
    ctx.beginPath();
    ctx.moveTo(toX(0), toY(pts[0]));
    pts.forEach((v,i) => ctx.lineTo(toX(i), toY(v)));
    ctx.strokeStyle = col;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.stroke();

    // End dot
    ctx.beginPath();
    ctx.arc(toX(pts.length-1), toY(pts[pts.length-1]), 2.5, 0, Math.PI*2);
    ctx.fillStyle = col;
    ctx.fill();
  });
}



function openWishCard(wishId) {
  // wishId is the actual wishlist item ID — look up directly
  const w = wishlist.find(x => x.id === wishId);
  if (!w) { toast('Card not found — try refreshing','red'); return; }
  // If already in collection open normal detail
  const owned = collection.find(c => c.cardId===w.cardId||(c.name===w.name&&c.set===w.set));
  if (owned) { openDetail(owned.id); return; }
  // Show watchlist detail modal
  openWishDetail(wishId);
}
function openWishDetail(wishId) {
  const w = wishlist.find(x => x.id === wishId);
  if (!w) { toast('Watchlist item not found','red'); return; }
  // If the user already owns this card, open its real collection detail.
  const inCollection = collection.find(c => c.cardId===w.cardId || (c.name===w.name && c.set===w.set));
  if (inCollection) { openDetail(inCollection.id); return; }
  // Otherwise show the SAME full detail view as the portfolio, via a not-owned
  // (transient) card carrying the watchlist item's kind/grade/edition so it prices right.
  window._detailTransient = {
    id: 'wishview_' + w.id, cardId: w.cardId || '', name: w.name, set: w.set || '', num: w.num || '',
    img: (wishPriceData(w) || {}).img || w.img || '',
    rarity: w.rarity || '', type: w.type==='graded' ? 'graded' : 'standard', grade: w.grade || '',
    cert: '', edition: w.edition || 'unlimited', cond: 'NM', paid: '', _transient: true, _wishId: w.id
  };
  openDetail('wishview_' + w.id);
}

let _wishTried = {};                 // wishId → last fetch-attempt ts (retry throttle, session-scoped)
const WISH_RETRY_MS = 5*60*1000;     // don't refetch an unpriceable wishlist card more than once / 5 min
// Watchlist items are priced into their own 'wish_<id>' cache namespace — NOT via
// cacheKey(), because a watchlist entry is not an owned holding and has no cond/
// edition identity. Reads and writes both go through these two helpers so the
// namespace is declared in exactly one place.
function wishCacheKey(w){ return 'wish_' + (w && w.id); }
function wishPriceData(w){
  if (!w || w.id == null) return null;
  const e = pcache[wishCacheKey(w)];
  if (e && e.data) return e.data;
  // Tolerant read of the legacy key written by the retired loadAllPrices()
  // pseudo-card path ('wish_<id>_NM_unlimited'). Nothing writes it any more; existing
  // entries stay readable so a user's cached watchlist prices don't blank out after
  // this change. No migration, no deletion — the stale keys simply age out.
  const legacy = pcache['wish_' + w.id + '_NM_unlimited'];
  return (legacy && legacy.data) ? legacy.data : null;
}

function renderWishlist(){
  const grid=document.getElementById('wish-grid');
  const empty=document.getElementById('wish-empty');
  const summary=document.getElementById('wish-summary');
  document.getElementById('nb-wish').textContent=wishlist.length;

  if(!wishlist.length){
    if(grid)grid.innerHTML='';
    if(empty)empty.style.display='';
    if(summary)summary.style.display='none';
    return;
  }
  if(empty)empty.style.display='none';
  if(summary)summary.style.display='flex';

  // Sort
  const sort=(document.getElementById('wish-sort')?.value)||'added';
  const sorted=[...wishlist].sort((a,b)=>{
    if(sort==='name')return a.name.localeCompare(b.name);
    if(sort==='price_desc'||sort==='price_asc'){
      const pa=bestPrice(wishPriceData(a)||{}, a.type==='graded'||!!a.grade)||0;
      const pb=bestPrice(wishPriceData(b)||{}, b.type==='graded'||!!b.grade)||0;
      return sort==='price_desc'?pb-pa:pa-pb;
    }
    return new Date(b.added||0)-new Date(a.added||0);
  });

  // Calculate totals
  let totalVal=0;
  wishlist.forEach(w=>{const p=wishPriceData(w);const bp=p?bestPrice(p, w.type==='graded'||!!w.grade):0;totalVal+=bp;});
  document.getElementById('wish-cnt').textContent=wishlist.length+' cards';
  document.getElementById('wish-total').textContent=totalVal>0?'$'+totalVal.toLocaleString('en-US',{maximumFractionDigits:0}):'Loading…';
  document.getElementById('wish-if-bought').textContent=totalVal>0?'$'+totalVal.toLocaleString('en-US',{maximumFractionDigits:0}):'—';

  if(!grid)return;
  window._wishCards = {};
  grid.innerHTML=sorted.map((w,idx)=>{
    const p=wishPriceData(w);
    // Respect the selected grade — bestPrice takes an isGraded flag that the
    // watchlist was never passing, so a PSA 8 holding was priced as if it were raw.
    const _isG=(w.type==='graded')||!!w.grade;
    const best=(p&&bestPrice(p,_isG)>0)?bestPrice(p,_isG):null;
    const img=p?.img||w.img||'';
    const inVault=collection.some(c=>c.cardId===w.cardId||(c.name===w.name&&c.set===w.set));
    // Store in global map by index to avoid quote escaping issues in onclick
    window._wishCards[w.id] = {wishId:w.id, cardId:w.cardId||"", name:w.name, set:w.set||"", num:w.num||"", img:img||w.img||"", rarity:w.rarity||""};
    return `<div class="db-card" onclick="openWishDetail('${w.id}')" style="position:relative;cursor:pointer;">
      <div class="db-card-img">
        ${img?`<img src="${esc(img)}" alt="${esc(w.name)}" loading="lazy" style="pointer-events:none;" onerror="this.style.display='none'">`:'<div class="cs-img-ph" style="font-size:32px;opacity:.2;">⟡</div>'}
      </div>
      ${inVault?'<div style="position:absolute;top:6px;left:6px;background:var(--green);color:#0a0a0f;font-family:var(--mono);font-size:8px;font-weight:700;padding:2px 6px;border-radius:10px;">IN VAULT</div>':''}
      <div class="db-card-body">
        <div class="db-card-set-pill" style="font-family:var(--mono);font-size:8px;color:var(--muted);margin-bottom:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(w.set||'')}${w.num?' · #'+esc(w.num):''}${w.type==='graded'&&w.grade?' · '+esc(w.grade):(w.type==='sealed'?' · Sealed':'')}</div>
        <div class="db-card-name">${esc(w.name)}</div>${editionBadge({edition:w.edition})?`<div style="margin-top:3px;">${editionBadge({edition:w.edition})}</div>`:''}
        <div style="margin-top:4px;">
          ${best!=null
            ? `<div style="font-family:var(--mono);font-size:13px;font-weight:700;color:var(--green);">$${best.toFixed(2)}</div>`
            : (_wishTried[w.id]
                ? `<div style="font-family:var(--mono);font-size:11px;color:var(--muted);">—</div>`
                : `<div style="display:flex;align-items:center;gap:4px;"><div class="spinner" style="width:8px;height:8px;border-width:1.5px;flex-shrink:0;"></div><span style="font-size:10px;color:var(--muted);">Loading…</span></div>`)}
          <canvas id="wsp-${w.id}" width="120" height="32" style="display:block;margin-top:4px;opacity:.8;pointer-events:none;"></canvas>
        </div>
        <div style="display:flex;gap:4px;margin-top:8px;">
          <button class="btn btn-primary btn-xs" style="flex:1;font-size:10px;justify-content:center;" onclick="event.stopPropagation();wishAddToPortfolio('${w.id}')">+ Portfolio</button>
          <button class="btn btn-ghost btn-xs" style="flex:1;font-size:10px;justify-content:center;" onclick="event.stopPropagation();wishLogDeal('${w.id}')">＄ Deal</button>
          <button class="btn btn-danger btn-xs" onclick="event.stopPropagation();removeWish('${w.id}')">✕</button>
        </div>
      </div>
    </div>`;
  }).join('');

  // Lazy load prices
  wishlist.forEach(async w=>{
    const ck=wishCacheKey(w);
    // Tolerant read (canonical key, then the retired bulk-loader key) so an item
    // already priced by the old path is not re-fetched just because the key moved.
    const cached=wishPriceData(w);
    if(cached&&bestPrice(cached)>0) return;                              // usable price already cached
    const now=Date.now();
    if(_wishTried[w.id]&&(now-_wishTried[w.id])<WISH_RETRY_MS) return;   // retry throttle — no refetch storm
    _wishTried[w.id]=now;
    const data=await fetchLivePrices({id:ck,name:w.name,cardId:w.cardId,type:w.type==='graded'?'graded':'holo',grade:w.grade||'',cond:'NM',edition:w.edition||'unlimited',img:w.img||null,set:w.set||'',num:w.num||''});
    if(data&&bestPrice(data)>0){                                        // cache ONLY usable results
      pcache[ck]={ts:now,data};
      idbPut(ck,pcache[ck]);
    }
    renderWishlist();                                                   // reflect price, or swap spinner→dash
  });

  // Render charts + sparklines after grid is built
  setTimeout(()=>{
    captureWishSnapshot();
    renderWishCharts();
    // Attach event delegation AFTER grid renders
  // click handled by onclick on each card
  }, 100);
}

function moveWishToVault(id){
  const w=wishlist.find(x=>x.id===id);if(!w)return;
  const cardObj={id:w.cardId||'',name:w.name,set:w.set||'',num:w.num||'',img:w.img||'',rarity:w.rarity||'',edition:w.edition||'unlimited'};
  prefillAddForm(cardObj, w.type==='graded'?'graded':'raw');
  if(w.type==='graded' && w.grade){
    const parts=w.grade.match(/^(\w+)\s+(.+)$/);
    if(parts){document.getElementById('f-grader').value=parts[1];document.getElementById('f-grade-sel').value=parts[2];}
    document.getElementById('f-grade').value=w.grade;
  }
  // Once saved, this watchlist entry moves into the portfolio.
  window._pendingWishRemoval=id;
}

// Watchlist → Portfolio: reuses moveWishToVault but guards against a missing form
// field silently aborting before the Add modal opens (the old "+ Vault did nothing"
// bug). If prefill throws, we still surface the modal so the action never dead-ends.
function wishAddToPortfolio(id){
  try {
    moveWishToVault(id);
  } catch(e){
    console.warn('[wishAddToPortfolio] prefill issue, opening add modal anyway:', e);
    try { window._pendingWishRemoval=id; openModal('add-modal'); } catch(_){}
  }
}

// Watchlist → Log a Deal: maps the watched card into the existing deal picker.
function wishLogDeal(id){
  const w=wishlist.find(x=>x.id===id); if(!w) return;
  dealPickCard({ id:w.cardId||'', name:w.name, set:w.set||'', num:w.num||'', img:w.img||'' });
}
