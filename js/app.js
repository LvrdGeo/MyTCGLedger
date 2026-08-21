/* ════════════════════════════════════════════════════════════════════════════
   MyTCG Ledger V6 - app.js
   ────────────────────────────────────────────────────────────────────────────
   THE APPLICATION SHELL. The final module: startup, navigation, page dispatch,
   data import/export and the global listeners. It is the frame the 29 domain
   modules hang inside, and owns no product domain of its own.

   OWNS:
     - startup        _bootDone, _listenersBound, init, initGlobalListeners, boot
     - page dispatch  registerPageRenderers, renderAll, refreshCurrentPage,
                      _currentPage, goPage
     - navigation     fabAction, updateFab, updateMobTabs, openMobileCollection,
                      openMobileMore, closeMobileMore, mobGoPage, setTabPageSize
     - data I/O       exportData, importData, clearAll
     - bulk refresh   refreshPrices
     - analyzer stub  analyzeScreenshot, renderAnalyzer - a DEVELOPMENT STUB that
                      deliberately reports an unsupported state instead of
                      fabricating a valuation. Preserved exactly.
     - two constants  HISTORY_KEY, _cashPosition

   STARTUP CONTRACT, preserved verbatim:
       boot() -> initGlobalListeners() -> registerPageRenderers() -> init()
   AppState.renderActive() dispatches through PAGE_RENDERERS only; this file
   registers the renderers and never names one inside AppState.

   DOES NOT OWN: any domain. Every renderer it dispatches to, every price it
   refreshes and every record it exports lives in a domain module. app.js is the
   only file legitimately allowed to know about all of them.

   LOAD ORDER: LAST. It depends on every other module, all at call time.

   LOAD-TIME EXECUTION: five declarations (HISTORY_KEY, _cashPosition,
   _currentPage, _bootDone, _listenersBound). boot() is NOT invoked here - the
   page's own bootstrap line still calls it, exactly as before.
   ════════════════════════════════════════════════════════════════════════════ */

const HISTORY_KEY = 'pkv2_ph2'; // v2 richer format
let _cashPosition = parseFloat(localStorage.getItem('pkv2_cash') || '0');
let _cashPositionAt = parseInt(localStorage.getItem('pkv2_cash_at') || '0', 10) || 0;
let _currentPage='dashboard';
let _bootDone = false;
let _listenersBound = false;

// ═══ INIT ═══
function init() {
  loadKeys(); updateStatusDots();
  initAuth();
  // Render dashboard immediately for fast perceived load
  AppState.update();
  renderDashboard();
  hydrateCollection();  // async: load collection from IndexedDB, then re-render
  hydratePcache();   // async: load durable cache from IndexedDB, then re-render
  // Defer heavy work so the UI paints first
  setTimeout(() => {
    captureHistorySnapshot();
    loadSets();
    loadAllPrices();
  }, 100);
  // Silently test eBay worker and update status dot
  fetch(EBAY_WORKER + '/health').then(r=>r.json()).then(d=>{
    const s2 = document.getElementById('s2');
    if (s2) s2.className = 'dot ' + (d.hasToken ? 'dot-on' : 'dot-warn');
  }).catch(()=>{});
  // Restore the page the user was last on (so reload/pull-to-refresh stays put)
  try {
    const last = localStorage.getItem(STORAGE_KEYS.lastPage);
    if (last && last !== 'dashboard' && document.getElementById('page-' + last)) {
      // Find the matching sidebar nav button so it highlights correctly
      const navBtn = Array.from(document.querySelectorAll('.nav-btn')).find(b => (b.getAttribute('onclick')||'').includes("goPage('" + last + "'"));
      goPage(last, navBtn || null);
      // Sync the mobile bottom-nav highlight too
      const mobMap = { dashboard:'mt-dashboard', portfolio:'mt-portfolio', cardsearch:'mt-cardsearch', deals:'mt-deals' };
      if (mobMap[last]) updateMobTabs(mobMap[last]);
      else if (typeof updateMobTabs === 'function') updateMobTabs('mt-more');
    }
  } catch(e) { console.warn('[init] restore page failed', e); }
}

// ╔═══════════════════════════════════════════════════════════════════════╗
// ║  MyTCGLedger  ·  SCRIPT 2 of 2  ·  SECTION MAP                          ║
// ║  Jump to any section by searching its  "// ═══ NAME ═══"  banner.      ║
// ╟───────────────────────────────────────────────────────────────────────╢
// ║  DEALS              Deal Center: deal logging, gallery, leaderboard     ║
// ║  ANALYZER           standalone price analyzer                           ║
// ║  SEALED             sealed product tracking                             ║
// ║  CARD CRUD          add / edit / save / delete cards                    ║
// ║  DETAIL VIEW        full card detail modal (incl. not-owned cards)      ║
// ║  SEARCH + SETS      card search and set browser                         ║
// ║  ADD FORM HELPERS   prefill / open helpers for the Add Card form        ║
// ║  WISHLIST           watchlist render, detail view, move-to-portfolio    ║
// ║  NAV + MOBILE       page switching, mobile tabs, context-aware FAB      ║
// ║  DATA               import / export and misc data                       ║
// ║  CARD SCANNER       Vision scanner (slab & grade detection)             ║
// ║  MODALS / UTILS     modal open/close, toasts, formatters                ║
// ╚═══════════════════════════════════════════════════════════════════════╝
// ═══ DEALS ═══
// ════════════════════════════════════════════════════════════════════════════
// ── DEAL SHAPE COMPATIBILITY (2026-08) ──
// deals[] can hold TWO record shapes:
//   v1 "legacy"  — written by saveDeal() via #deal-modal:
//                  { id, type:'buy'|'sell'|'offer', name, amount, date, source, cond, notes }
//   v2 "log"     — written by saveDealLog() via #deal-log-modal:
//                  { id, dealType:'purchase'|'sale'|'trade', status:'open'|'closed',
//                    cardsIn[], cardsOut[], buyPrice, sellPrice, platform, ... }
// The v1 UI has been REMOVED (2026-08 — proven unreachable), but v1 records may
// still exist in a user's localStorage / Supabase row from an earlier build, so
// everything below stays. Because every renderer keys off `status`, those records were stored
// and synced but displayed nowhere. These helpers give downstream code one shape to
// read WITHOUT rewriting stored data — nothing here mutates a deal record.
// ════════════════════════════════════════════════════════════════════════════
// ═══ ANALYZER ═══
// DEVELOPMENT STUB — NOT IMPLEMENTED. This UI is reachable in production, so it
// must never present invented numbers as analysis. The previous body derived a
// "Detected Price" and "Condition" by hashing the image bytes and indexing two
// hard-coded arrays: pure fabrication, indistinguishable from a real valuation.
// It now reports an honest unsupported state and points at the Card Scanner,
// which performs real vision-based identification. The screenshot pipeline can be
// implemented here later; until then it returns no valuation at all.
function analyzeScreenshot(input){
  const file = input && input.files && input.files[0];
  if(!file) return;
  console.warn('[analyzer] Screenshot analysis is not implemented — no valuation produced.');
  const result = document.getElementById('az-result');
  const out    = document.getElementById('az-output');
  if(result) result.style.display='';
  if(out) out.innerHTML =
    '<div style="font-size:12px;color:var(--muted2);line-height:1.7;">'
    + '<div style="font-weight:600;color:var(--gold);margin-bottom:4px;">Screenshot analysis isn\'t available yet</div>'
    + 'This tool can\'t read prices out of a screenshot, so nothing has been valued. '
    + 'Use the <b>Card Scanner</b> below to identify a card from a photo and pull its real market price, '
    + 'or search the card in <b>Card Search</b>.'
    + '</div>';
  if(input) { try { input.value=''; } catch(_){} }
}

function renderAnalyzer(){
  let topCard=null,topVal=0,bestROI=null,bestROIPct=0;
  collection.forEach(card=>{const bp=cardValue(card);if(bp>topVal){topVal=bp;topCard=card;}const paid=parseFloat(card.paid||0);if(bp>0&&paid>0){const pct=((bp-paid)/paid)*100;if(pct>bestROIPct){bestROIPct=pct;bestROI=card;}}});
  document.getElementById('val-top-name').textContent=topCard?topCard.name+(topCard.set?' · '+topCard.set:''):'—';
  document.getElementById('val-top-price').textContent=topVal>0?fmtPrice(topVal):'—';
  const brackets=[{label:'<$10',max:10},{label:'$10–50',min:10,max:50},{label:'$50–200',min:50,max:200},{label:'$200–1k',min:200,max:1000},{label:'$1k+',min:1000}];
  const counts=brackets.map(b=>collection.filter(c=>{const bp=cardValue(c);return bp>=(b.min||0)&&(!b.max||bp<b.max);}).length);
  const maxC=Math.max(...counts,1);
  document.getElementById('val-dist').innerHTML=brackets.map((b,i)=>`<div style="display:flex;align-items:center;gap:8px;margin-bottom:5px;font-size:11px;"><span style="width:60px;color:var(--muted);">${b.label}</span><div style="flex:1;height:6px;background:var(--bg2);border-radius:3px;overflow:hidden;"><div style="width:${(counts[i]/maxC*100).toFixed(0)}%;height:100%;background:var(--blue);border-radius:3px;"></div></div><span style="width:20px;text-align:right;color:var(--muted2);font-family:var(--mono);">${counts[i]}</span></div>`).join('');
  document.getElementById('val-roi-name').textContent=bestROI?bestROI.name:'—';
  document.getElementById('val-roi-pct').textContent=bestROI?'+'+bestROIPct.toFixed(1)+'% ROI':'Add purchase prices to calculate';
}

// Hook into goPage so set browser renders when tab opens
function setTabPageSize(size, el){
  TAB_PAGE_SIZE = size;
  // Update active button
  document.querySelectorAll('.perpage-btn').forEach(b => b.classList.remove('active'));
  if(el) el.classList.add('active');
  // Re-run search from page 1 with new size
  if(_tabQuery) doTabSearch(_tabQuery, 1);
}

// The mobile FAB is context-aware: it adds a card everywhere, but creates a new
// deal while in the Deal Center (with a distinct look so the action is obvious).
function fabAction(){
  if(_currentPage==='deals') openDealLogModal();
  else openAddModal();
}

function updateFab(name){
  const fab=document.getElementById('mob-fab');
  if(!fab)return;
  // Hide FAB on pages where adding a card doesn't apply (mobile only; desktop CSS hides it)
  const isMobile = window.matchMedia('(max-width:768px)').matches;
  if(!isMobile){ fab.style.display=''; }
  else if(name==='settings'||name==='analyzer'){ fab.style.display='none'; return; }
  else { fab.style.display='flex'; }
  if(name==='deals'){
    fab.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:20px;height:20px;"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>';
    fab.title='New deal'; fab.setAttribute('aria-label','Create new deal');
    fab.style.background='rgba(46,204,128,0.85)';
    fab.style.boxShadow='0 4px 16px rgba(46,204,128,.35)';
  } else {
    fab.innerHTML='+';
    fab.title='Add card'; fab.setAttribute('aria-label','Add card');
    fab.style.background=''; fab.style.boxShadow='';
  }
}

function goPage(name,el){
  _currentPage=name;
  try { localStorage.setItem(STORAGE_KEYS.lastPage, name); } catch(e){}
  try {
    const _ab = document.getElementById('mob-account-btn');
    if (_ab) {
      // Park the avatar INSIDE the active page's topbar so it shares that bar's
      // layout/scroll context. As a viewport-fixed element it drifted out of the bar
      // whenever Safari collapsed its chrome mid-scroll.
      const _bar = document.querySelector('#page-' + name + ' .topbar');
      if (_bar && _ab.parentElement !== _bar) _bar.appendChild(_ab);
      _ab.style.visibility = (name === 'settings') ? 'hidden' : '';
    }
  } catch(_){}
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.getElementById('page-'+name).classList.add('active');
  document.querySelectorAll('.nav-btn').forEach(b=>b.classList.remove('active'));
  if(el){ el.classList.add('active'); }
  else { try{ const _nb=[...document.querySelectorAll('.nav-btn')].find(b=>(b.getAttribute('onclick')||'').includes("'"+name+"'")); if(_nb)_nb.classList.add('active'); }catch(_){} }
  updateFab(name);
  // Render each tab when first visited
  if(name==='dashboard'){renderDashboard();}
  if(name==='portfolio'){renderPortfolio();loadAllPrices();}
  if(name==='singles'  && !document.getElementById('page-singles')._rendered){renderSingles();document.getElementById('page-singles')._rendered=true;}
  if(name==='psa'      && !document.getElementById('page-psa')._rendered){renderPSA();document.getElementById('page-psa')._rendered=true;}
  if(name==='sealed'   && !document.getElementById('page-sealed')._rendered){renderSealed();document.getElementById('page-sealed')._rendered=true;}
  if(name==='wishlist' && !document.getElementById('page-wishlist')._rendered){renderWishlist();document.getElementById('page-wishlist')._rendered=true;}
  if(name==='deals'    && !document.getElementById('page-deals')._rendered){renderDeals();document.getElementById('page-deals')._rendered=true;}
  if(name==='analyzer'){renderAnalyzer();}
  if(name==='intelligence'){renderIntelligence();}
  if(name==='cardsearch'){initTabSearchSets();renderSetBrowser();setTimeout(()=>document.getElementById('tab-search-input')?.focus(),100);}
  if(name==='settings'){loadKeys();renderAccountSection();updateAuthUI();loadNrvForm();}
}

function updateMobTabs(id){document.querySelectorAll('.mob-tab').forEach(t=>t.classList.remove('active'));const el=document.getElementById(id);if(el)el.classList.add('active');}

function openMobileCollection() {
  updateMobTabs('mt-collection');
  // Show a bottom sheet to pick which collection tab
  const existing = document.getElementById('mob-collection-sheet');
  if (existing) { existing.remove(); return; }

  const sheet = document.createElement('div');
  sheet.id = 'mob-collection-sheet';
  sheet.style.cssText = 'position:fixed;bottom:calc(56px + env(safe-area-inset-bottom,20px));left:0;right:0;background:var(--bg2);border-top:1px solid var(--border);border-radius:16px 16px 0 0;z-index:999;padding:12px 0;';
  sheet.innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--border);">
      <button onclick="mobGoPage('singles','mt-collection');document.getElementById('mob-collection-sheet').remove();" style="background:var(--bg2);border:none;padding:14px;color:var(--text);font-size:12px;font-weight:600;cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:6px;">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" style="width:20px;height:20px;"><rect x="3" y="2" width="12" height="18" rx="2"/><path d="M7 7h5M7 11h3"/></svg>Singles
      </button>
      <button onclick="mobGoPage('psa','mt-collection');document.getElementById('mob-collection-sheet').remove();" style="background:var(--bg2);border:none;padding:14px;color:var(--text);font-size:12px;font-weight:600;cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:6px;">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" style="width:20px;height:20px;"><rect x="2" y="2" width="20" height="20" rx="3"/><path d="M7 12l3 3 7-7"/></svg>PSA Slabs
      </button>
      <button onclick="mobGoPage('sealed','mt-collection');document.getElementById('mob-collection-sheet').remove();" style="background:var(--bg2);border:none;padding:14px;color:var(--text);font-size:12px;font-weight:600;cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:6px;">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" style="width:20px;height:20px;"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>Sealed
      </button>
      <button onclick="mobGoPage('wishlist','mt-collection');document.getElementById('mob-collection-sheet').remove();" style="background:var(--bg2);border:none;padding:14px;color:var(--text);font-size:12px;font-weight:600;cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:6px;">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" style="width:20px;height:20px;"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>Watchlist
      </button>
    </div>`;

  document.body.appendChild(sheet);
  // Tap anywhere else to dismiss
  setTimeout(() => {
    document.addEventListener('click', function dismiss(e) {
      if (!sheet.contains(e.target) && e.target.id !== 'mt-collection') {
        sheet.remove();
        document.removeEventListener('click', dismiss);
      }
    });
  }, 100);
}

function openMobileMore() {
  updateMobTabs('mt-more');
  const existing = document.getElementById('mob-more-sheet');
  if (existing) { existing.remove(); document.body.classList.remove('sheet-open'); return; }

  const sheet = document.createElement('div');
  sheet.id = 'mob-more-sheet';
  sheet.className = 'mob-more-sheet';
  sheet.innerHTML = `
    <div class="mob-more-grab"></div>
    <div class="mob-more-label">Collection</div>
    <div class="mob-more-grid">
      <button class="mob-more-tile" onclick="closeMobileMore();mobGoPage('singles','mt-more');">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="2" width="12" height="18" rx="2"/><path d="M7 7h5M7 11h3"/></svg>
        <span>Singles</span>
      </button>
      <button class="mob-more-tile" onclick="closeMobileMore();mobGoPage('psa','mt-more');">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="2" y="2" width="20" height="20" rx="3"/><path d="M7 12l3 3 7-7"/></svg>
        <span>PSA Slabs</span>
      </button>
      <button class="mob-more-tile" onclick="closeMobileMore();mobGoPage('sealed','mt-more');">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>
        <span>Sealed</span>
      </button>
      <button class="mob-more-tile" onclick="closeMobileMore();mobGoPage('wishlist','mt-more');">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
        <span>Watchlist</span>
      </button>
    </div>
    <div class="mob-more-sep"></div>
    <div class="mob-more-label">Tools</div>
    <button class="mob-more-row" onclick="closeMobileMore();mobGoPage('intelligence','mt-more');">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>
      Intelligence
    </button>
    <button class="mob-more-row" onclick="closeMobileMore();mobGoPage('analyzer','mt-more');">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
      Analyzer
    </button>
    <button class="mob-more-row" onclick="closeMobileMore();openSoldHistory();">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 8v13H3V8"/><path d="M1 3h22v5H1z"/><line x1="10" y1="12" x2="14" y2="12"/></svg>
      Sold &amp; Removed History
    </button>`;

  document.body.appendChild(sheet);
  // Sit exactly on top of the REAL tab bar. The old CSS hardcoded 58px, but the bar's
  // height varies by device (padding + icon + label + safe-area inset), so the last
  // row could overlap the tabs. Measuring guarantees a flush fit on every screen.
  try {
    const tabs = document.querySelector('.mobile-tabs');
    if (tabs) {
      const h = Math.round(tabs.getBoundingClientRect().height);
      if (h > 0) sheet.style.bottom = h + 'px';
    }
  } catch(_){}
  document.body.classList.add('sheet-open');   // freeze page scroll behind the sheet
  setTimeout(() => {
    document.addEventListener('click', function dismiss(e) {
      if (!sheet.contains(e.target) && e.target.id !== 'mt-more' && !e.target.closest('#mt-more')) {
        sheet.remove();
        document.body.classList.remove('sheet-open');
        document.removeEventListener('click', dismiss);
      }
    });
  }, 100);
}

function closeMobileMore() {
  const s = document.getElementById('mob-more-sheet');
  if (s) s.remove();
  document.body.classList.remove('sheet-open');
}

function mobGoPage(page,tabId){goPage(page,null);updateMobTabs(tabId);}

// ═══ DATA ═══
// ── PAGE RENDERER REGISTRATION ──
// The UI layer declaring itself to the state layer. Runs at parse time, before
// any render can be triggered (init() is called from the DOM-ready handler at
// the very bottom of the file), so the registry is always populated in time.
// This block is the whole of the UI→core coupling: when the file is split, this
// is what each feature file contributes, and AppState needs to know nothing.
// ── POST-PRICING ORCHESTRATION (Batch 31) ──────────────────────────────────
// Moved verbatim out of pricing.js. Pricing announces a phase; the shell decides
// which views refresh and which follow-up work runs. Statement order, renderer
// order, call counts and conditions are all identical to the old pricing tail —
// this is a dependency-direction change, not a behaviour change.
//
//   loadAllPrices()      -> 'render' {scope:'all'}   then 'settled' {scope:'all'}
//   loadPricesForCards() -> 'render' {scope:'cards'} then 'settled' {scope:'cards'}
//
// Note the deliberate asymmetry, preserved exactly as it was: the 'cards' scope
// re-renders ONLY Portfolio + Dashboard (Singles/PSA/Wishlist call
// loadPricesForCards themselves, so re-rendering them would loop), and it does
// NOT capture a history snapshot. calculateMarketSignal fires in BOTH scopes —
// the known x2 behaviour, carried forward untouched as deferred debt.
function onPricingPhase(phase, ctx){
  const scope = ctx && ctx.scope;
  if (phase === 'render'){
    AppState._dirty = true;
    AppState.update();
    if (scope === 'all'){
      renderPortfolio();
      renderPSA();
      renderSingles();
      renderWishlist();
      renderAnalyzer();
      renderDashboard();
    } else {
      renderPortfolio();
      renderDashboard();
    }
    return;
  }
  if (phase === 'settled'){
    if (scope === 'all') captureHistorySnapshot(); // capture after prices are fresh
    calculateMarketSignal();                       // recompute + persist intelligence signals
  }
}

function registerPageRenderers(){
  // Pricing announces completion; this shell owns the reaction (Batch 31).
  // Registered here in boot() step 2, before init() (step 3) can call loadAllPrices().
  setPricingPhaseHandler(onPricingPhase);

  registerPageRenderer('page-dashboard', renderDashboard);
  registerPageRenderer('page-portfolio', renderPortfolio);
  registerPageRenderer('page-psa',       renderPSA);
  registerPageRenderer('page-singles',   renderSingles);
  registerPageRenderer('page-sealed',    renderSealed);
  registerPageRenderer('page-analyzer',  renderAnalyzer);
  registerPageRenderer('page-deals',     renderDeals);
  registerPageRenderer('page-wishlist',  renderWishlist);
}

// Full redraw of every page. Kept as an explicit list (not a loop over the
// registry) because the ORDER matters: renderDashboard() reads totals that the
// portfolio pass refreshes, so it stays last.
function renderAll(){
  AppState.update();
  safeRender(renderPortfolio,  'renderPortfolio');
  safeRender(renderPSA,        'renderPSA');
  safeRender(renderSingles,    'renderSingles');
  safeRender(renderSealed,     'renderSealed');
  safeRender(renderDeals,      'renderDeals');
  safeRender(renderWishlist,   'renderWishlist');
  safeRender(renderAnalyzer,   'renderAnalyzer');
  safeRender(renderDashboard,  'renderDashboard');
}

function exportData(){
  const history = readPortfolioHistory();
  const data = {collection,wishlist,sealed,deals,history,cardHistory,cashPosition:AppState.cashPosition,exported:new Date().toISOString(),version:'5.0'};
  const b=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});
  const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download='mytcgledger-v6-export.json';a.click();
  toast('Export includes full portfolio history','green');
}

function importData(e){
  const f=e.target.files[0];if(!f)return;
  const r=new FileReader();
  r.onload=ev=>{
    try{
      const d=JSON.parse(ev.target.result);
      if(d.collection)collection=d.collection;
      if(d.wishlist)wishlist=d.wishlist;
      if(d.sealed)sealed=d.sealed;
      if(d.deals)deals=d.deals;
      // Deletion ledger: UNION on import (never shrinks) so importing an old backup
      // can't resurrect post-backup deletions; then suppress the imported collection.
      if(Array.isArray(d.deletionLedger)){deletionLedger=unionLedger(deletionLedger,d.deletionLedger);}
      if(Array.isArray(collection))collection=applyDeletions(collection,deletionLedger,'card');
      if(Array.isArray(sealed))sealed=applyDeletions(sealed,deletionLedger,'sealed');
      if(Array.isArray(wishlist))wishlist=applyDeletions(wishlist,deletionLedger,'wishlist');
      if(Array.isArray(deals))deals=applyDeletions(deals,deletionLedger,'deal');
      if(d.history){writePortfolioHistory(d.history);}
      if (Object.prototype.hasOwnProperty.call(d, 'cashPosition')) { const importedCash = parseFloat(d.cashPosition); _cashPosition = Number.isFinite(importedCash) && importedCash >= 0 ? importedCash : 0; localStorage.setItem('pkv2_cash', _cashPosition.toFixed(2)); }
      save();init();toast('Imported successfully — history restored','green');
    }catch{toast('Invalid JSON file','red');}
  };
  r.readAsText(f);
}

async function clearAll(){
  // CRITICAL: record every entity in the deletion ledger BEFORE clearing. Without
  // this, another device still holding the old data sees its cards as "not yet in
  // the cloud" and pushes them straight back — resurrecting a deleted portfolio.
  try {
    (collection||[]).forEach(c => { if(c && c.id!=null) retire('card', c.id); });
    (wishlist||[]).forEach(w => { if(w && w.id!=null) retire('wishlist', w.id); });
    (sealed||[]).forEach(s => { if(s && s.id!=null) retire('sealed', s.id); });
    (deals||[]).forEach(d => { if(d && d.id!=null) retire('deal', d.id); });
    if(typeof soldHistory!=='undefined') (soldHistory||[]).forEach(s => { if(s && s.id!=null) retire('sold', s.id); });
  } catch(e){ console.warn('[clearAll] ledger record failed', e); }
  collection=[];wishlist=[];sealed=[];deals=[];pcache={};if(typeof soldHistory!=='undefined')soldHistory=[];if(typeof cardHistory!=='undefined')cardHistory={};if(typeof _cashPosition!=='undefined')_cashPosition=0;['pkv2_col','pkv2_wish','pkv2_sealed','pkv2_deals','pkv2_pcache','pkv2_sold','pkv2_ph2','pkv2_wh','pkv2_vh','pkv2_cardhist','pkv2_cash'].forEach(k=>localStorage.removeItem(k));try{idbClear();}catch(e){}try{idbColClear();}catch(e){}try{if(typeof syncPush==='function')await syncPush();}catch(e){}init();toast('All data cleared','red');}

function refreshPrices(){
  pcache = {};
  localStorage.removeItem('pkv2_pcache');
  localStorage.setItem('pkv2_pcache', '{}');
  idbClear();
  AppState._dirty = true;
  AppState.update();
  toast('Refreshing prices…','gold');
  // Reset render caches so the current page rebuilds with fresh data
  ['page-singles','page-psa','page-sealed','page-wishlist','page-deals'].forEach(id=>{
    const el=document.getElementById(id);if(el)el._rendered=false;
  });
  // Re-render and reprice ONLY the page you're on — stay put, don't jump home.
  refreshCurrentPage();
}

// Re-render the current page in place and reload its prices (mirrors goPage's
// per-page logic but without switching pages).
function refreshCurrentPage(){
  const name = _currentPage || 'dashboard';
  switch(name){
    case 'dashboard': renderDashboard(); loadAllPrices(); break;
    case 'portfolio': renderPortfolio(); loadAllPrices(); break;
    case 'singles':   renderSingles();   document.getElementById('page-singles')._rendered=true; break;
    case 'psa':       renderPSA();       document.getElementById('page-psa')._rendered=true; break;
    case 'sealed':    renderSealed();    document.getElementById('page-sealed')._rendered=true; break;
    case 'wishlist':  renderWishlist();  document.getElementById('page-wishlist')._rendered=true; break;
    case 'deals':     renderDeals();     document.getElementById('page-deals')._rendered=true; break;
    case 'analyzer':  renderAnalyzer(); break;
    case 'cardsearch': /* search results are user-driven; nothing to reprice */ break;
    case 'settings':  renderAccountSection(); updateAuthUI(); break;
    default:          renderDashboard(); loadAllPrices();
  }
}

// Document-level listeners that were previously bare top-level statements.
// Guarded so a double call cannot double-bind (which would fire handlers twice).
function initGlobalListeners(){
  if (_listenersBound) return;
  _listenersBound = true;
  document.querySelectorAll('.modal-bg').forEach(bg =>
    bg.addEventListener('click', e => { if (e.target === bg) bg.classList.remove('open'); }));
  const okBtn = document.getElementById('confirm-ok');
  if (okBtn) okBtn.onclick = () => { if (confirmCb) confirmCb(); closeConfirm(); };

  // "Click outside to dismiss" handlers, relocated here from three different
  // feature sections where they sat as bare top-level execution. Registration
  // order among them is preserved; each targets a different container, so they
  // do not interact. Owning them here means search.js / cards.js can be extracted
  // as pure function collections with no top-level side effects.
  document.addEventListener('click', e => {
    if(!e.target.closest('#add-modal')) document.getElementById('modal-name-dd')?.classList.remove('open');
  });
  document.addEventListener('click', e => {
    if(!e.target.closest('#mode-name')) document.getElementById('name-dd')?.classList.remove('open');
  });
  document.addEventListener('click', e => {
    if(!e.target.closest('.card-search-wrap')) closeOverviewSearch();
  });
}

function boot(){
  if (_bootDone) { console.warn('[boot] already booted — ignoring repeat call'); return; }
  _bootDone = true;
  initGlobalListeners();      // 1. DOM wiring
  registerPageRenderers();    // 2. UI -> AppState registration, before any render
  init();                     // 3. state hydrate -> auth -> first render
}
