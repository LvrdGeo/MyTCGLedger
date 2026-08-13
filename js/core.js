/* ════════════════════════════════════════════════════════════════════════════
   MyTCG Ledger V6 — core.js
   ────────────────────────────────────────────────────────────────────────────
   LAYER 1 (CORE). The bottom of the dependency graph.

   INVARIANT: core.js has ZERO outbound subsystem dependencies. Nothing in this
   file may call into valuation, state, storage, sync, pricing or any feature
   module. If a symbol here ever needs one of those, it does not belong here.

   Loaded as a CLASSIC script (no modules, no defer/async) immediately before the
   main inline block, so every symbol below is a plain global by the time any
   consumer — inline handler or later script — runs.

   Contents:
     · persistence notification  onPersist · notifyPersisted
     · localStorage primitives   readJSON · writeJSON · readNumber · writeNumber
     · storage key registry      STORAGE_KEYS
     · misc utilities            safeRender · newId
     · formatters                num · money · moneyFull · moneyK · moneySigned
                                 pct · fmtDate · esc · evxEsc
     · modal / toast primitives  openModal · closeModal · showConfirm
                                 closeConfirm · toast

   NOTE ON DOM: showConfirm / closeConfirm / toast / openModal / closeModal read
   DOM ids at CALL time, never at load time, so this file is safe to load before
   the body exists.
   ════════════════════════════════════════════════════════════════════════════ */

// ════════════════════════════════════════════════════════════════════════════
// ── PERSISTENCE CHANGE NOTIFICATION ──
// The persistence layer must not know a sync layer exists. save() /
// saveSoldHistory() / saveCashPosition() announce "local state changed"; the
// sync layer subscribes via onPersist(). Pure pub/sub — no dependencies, which
// is why it lives in core rather than in storage or sync.
// ════════════════════════════════════════════════════════════════════════════
const _persistListeners = [];
function onPersist(fn){ if (typeof fn === 'function') _persistListeners.push(fn); }
function notifyPersisted(){
  for (const fn of _persistListeners) {
    // One bad subscriber must never break a save.
    try { fn(); } catch (e) { console.warn('[persist] listener failed:', e && e.message); }
  }
}

// ── STORAGE HELPERS ──
// Safe localStorage wrappers: never throw, no UI side-effects.

// readJSON — parse a JSON value from localStorage. Missing key or unparseable
// value → fallback. Never throws.
function readJSON(key, fallback){
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    return JSON.parse(raw);
  } catch (e) { return fallback; }
}

// writeJSON — serialize + persist a value. Returns true on success, false on
// error (e.g. quota exceeded). No UI side-effects.
function writeJSON(key, value){
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (e) { return false; }
}

// readNumber — read a numeric value from localStorage. Missing/invalid → fallback.
function readNumber(key, fallback=0){
  const n = parseFloat(localStorage.getItem(key));
  return isFinite(n) ? n : fallback;
}

// writeNumber — persist a numeric value. Returns true on success, false on error.
function writeNumber(key, value){
  try {
    localStorage.setItem(key, String(value));
    return true;
  } catch (e) { return false; }
}

// ════════════════════════════════════════════════════════════════════════════
// ── STORAGE KEY REGISTRY ──
// Single catalogue of the app's localStorage keys. Key STRINGS are frozen
// contract with existing installs — never rename one.
// ════════════════════════════════════════════════════════════════════════════
const STORAGE_KEYS = {
  collection:       'pkv2_col',
  sealed:           'pkv2_sealed',
  wishlist:         'pkv2_wish',
  deals:            'pkv2_deals',
  soldHistory:      'pkv2_sold',
  cash:             'pkv2_cash',
  keys:             'pkv2_keys',
  prefs:            'pkv2_prefs',
  priceCache:       'pkv2_pcache',
  cardHistory:      'pkv2_cardhist',
  portfolioHistory: 'pkv2_ph2',
  valueHistory:     'pkv2_vh',
  wishHistory:      'pkv2_wh',
  schema:           'pkv2_schema',
  lastPage:         'pkv2_lastpage',
  nrv:              'pkv2_nrv',
};

// ── Error boundary wrapper for render functions ──
function safeRender(fn, name) {
  try { fn(); }
  catch(err) { console.error('[Render] ' + name + ' failed:', err); try { window.Sentry && Sentry.captureException(err); } catch(_) {} }
}
// ── Tier 0: collision-proof record IDs. crypto.randomUUID() for NEW records only;
// existing Date.now()-based IDs are left untouched (opaque strings, still valid).
function newId(prefix){
  try {
    if (window.crypto && crypto.randomUUID) return (prefix||'') + crypto.randomUUID();
  } catch(_){}
  // Fallback for non-secure contexts (e.g. http://localhost dev) — intentionally no Date.now().
  return (prefix||'') + Math.random().toString(36).slice(2,11) + Math.random().toString(36).slice(2,11);
}
// ════════════════════════════════════════════════════════════════════════════
// ── FORMATTERS ──
// ════════════════════════════════════════════════════════════════════════════
// num — safe numeric parser. Returns parseFloat(v), or `fallback` when not finite.
function num(v, fallback=0){ const n = parseFloat(v); return isFinite(n) ? n : fallback; }

// money — canonical price formatter (fmtPrice delegates here).
// invalid / null / non-positive → '—'; otherwise '$' + value.toFixed(2).
function money(v){ return (v == null || !isFinite(v) || v <= 0) ? '—' : '$' + v.toFixed(2); }

// moneyFull — always shows a value with thousands separators; preserves '$0.00'.
function moneyFull(v){ return '$' + num(v, 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

// moneyK — compact thousands display ('$1.5k', '$12k'); full value below 1000.
function moneyK(v){ const n = num(v, 0); return n >= 1000 ? '$' + (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : moneyFull(n); }

// moneySigned — explicit +/- sign ('+$5.00', '-$5.00').
function moneySigned(v){ const n = num(v, 0); return (n >= 0 ? '+' : '-') + '$' + Math.abs(n).toFixed(2); }

// pct — signed percent, configurable decimals; '' when not finite.
function pct(v, dp=1){ if (v == null || !isFinite(v)) return ''; return (v >= 0 ? '+' : '') + v.toFixed(dp) + '%'; }

// fmtDate — central short date formatter ('Jun 10'); '' on invalid input.
function fmtDate(v){ const d = new Date(v); return isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); }

// esc — THE canonical HTML escaper for dynamic strings placed into innerHTML.
// Apply to anything the user typed (card/product names, sets, notes, image URLs)
// or that arrived from a third-party API. null/undefined → '' so it is a drop-in
// for the existing `${x||''}` patterns. Never apply it to markup the app itself
// generates (editionBadge(), tileImage(), nested templates) — that is already HTML.
function esc(v){ return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]); }

function evxEsc(s){ return esc(s); }   // kept as an alias — esc() is the canonical escaper

// ════════════════════════════════════════════════════════════════════════════
// ── MODAL / TOAST PRIMITIVES ──
// ════════════════════════════════════════════════════════════════════════════
function openModal(id){document.getElementById(id).classList.add('open');}
function closeModal(id){document.getElementById(id).classList.remove('open');}
let confirmCb=null;
function showConfirm(title,msg,cb){document.getElementById('confirm-title').textContent=title;document.getElementById('confirm-msg').textContent=msg;confirmCb=cb;document.getElementById('confirm-bg').classList.add('open');}
function closeConfirm(){document.getElementById('confirm-bg').classList.remove('open');confirmCb=null;}

function toast(msg,color='green',undoCb=null){const t=document.getElementById('toast');document.getElementById('toast-msg').textContent=msg;document.getElementById('toast-dot').style.background=color==='green'?'var(--green)':color==='red'?'var(--red)':'var(--gold)';const ub=document.getElementById('toast-undo');if(ub){if(undoCb){ub.style.display='';ub.onclick=()=>{t.classList.remove('show');try{undoCb();}catch(e){}};}else{ub.style.display='none';ub.onclick=null;}}t.classList.add('show');if(window._toastTimer)clearTimeout(window._toastTimer);window._toastTimer=setTimeout(()=>t.classList.remove('show'),undoCb?6000:2800);}
