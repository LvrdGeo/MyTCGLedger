/* ════════════════════════════════════════════════════════════════════════════
   MyTCG Ledger V6 - storage.js
   ────────────────────────────────────────────────────────────────────────────
   LAYER 5 (PERSISTENCE). Depends on core.js, valuation.js, state.js.

   OWNS - every durable write the app makes locally:
     - collection IndexedDB   mytcg_collection / store 'kv' / key 'collection'
                              _colOpen, _colStore, idbColLoad, idbColSave,
                              idbColClear, hydrateCollection
     - price-cache IndexedDB  mytcg_pcache / store 'pcache' / key = cacheKey()
                              _idbOpen, _idbStore, idbGetAll, idbPut, idbDelete,
                              idbClear, hydratePcache
     - per-card price history cardHistory, recordCardPrice, saveCardHistory,
                              getCardHistory              (pkv2_cardhist)
     - history store          readPortfolioHistory, writePortfolioHistory,
                              readValueHistory, portfolioValueSeries,
                              readWishHistory, writeWishHistory
                              (pkv2_ph2, pkv2_vh, pkv2_wh)
     - snapshot               captureHistorySnapshot
     - save paths             saveSoldHistory (pkv2_sold), save()

   DOES NOT OWN: Supabase transport, auth, merge semantics (mergeWishHistory and
   mergeAppData stay with sync), identity rules, pricing acquisition, rendering.

   INVARIANT - NO STORAGE -> SYNC DEPENDENCY. save() and saveSoldHistory() publish
   notifyPersisted() (core); the sync layer subscribes via onPersist(). Neither
   function names syncQueuePush. Do not reintroduce that call here.

   COMPATIBILITY CONTRACT - these are frozen for existing installs:
     - IndexedDB db/store names and keys, exactly as above.
     - localStorage keys pkv2_col / pkv2_pcache / pkv2_wish / pkv2_sealed /
       pkv2_deals / pkv2_sold / pkv2_cardhist / pkv2_ph2 / pkv2_vh / pkv2_wh.
     - pkv2_col and pkv2_pcache remain FROZEN ROLLBACK COPIES: IndexedDB is
       authoritative, but the localStorage blobs are never deleted.
     - If IndexedDB is unavailable or throws, every helper degrades silently and
       the synchronous localStorage seed remains in force.

   OUTBOUND DEPENDENCIES (all call-time, none at load):
     - core.js       readJSON, writeJSON, STORAGE_KEYS, notifyPersisted
     - valuation.js  cacheKey (per-card history keying)
     - state.js      AppState (dirty flag + post-hydration refresh)
     - inline app    the state globals collection / pcache / wishlist / sealed /
                     deals / soldHistory, and savePortfolioSnapshot (analytics -
                     see the note at captureHistorySnapshot). save() also clears
                     `_rendered` flags on page elements, a DOM touch at call time.

   LOAD-TIME EXECUTION: three declarations only -
     let _colDB/_colOK, let _idbDB/_idbOK, let cardHistory = <pkv2_cardhist read>.
   No IndexedDB is opened at load; _colOpen/_idbOpen run only from the hydrate*
   functions, which init() awaits. Timing is unchanged by this extraction.
   ════════════════════════════════════════════════════════════════════════════ */


// ════════════════════════════════════════════════════════════════════════════
// ── COLLECTION STORE (IndexedDB: mytcg_collection) ──
// ════════════════════════════════════════════════════════════════════════════
// ── Tier 1: durable collection store in IndexedDB (separate DB, single record).
// collection stays the in-memory array; this only retargets persistence.
// localStorage 'pkv2_col' is left intact as a frozen rollback copy.
let _colDB = null, _colOK = false;
function _colOpen(){
  return new Promise(function(resolve){
    try {
      if (!window.indexedDB) return resolve(null);
      const req = indexedDB.open('mytcg_collection', 1);
      req.onupgradeneeded = function(e){ const db = e.target.result; if(!db.objectStoreNames.contains('kv')) db.createObjectStore('kv'); };
      req.onsuccess = function(e){ _colDB = e.target.result; _colOK = true; resolve(_colDB); };
      req.onerror   = function(){ resolve(null); };
    } catch(_) { resolve(null); }
  });
}
function _colStore(mode){ return _colDB.transaction('kv', mode).objectStore('kv'); }
function idbColLoad(){
  return new Promise(function(resolve){
    if(!_colOK) return resolve(null);
    try {
      const req = _colStore('readonly').get('collection');
      req.onsuccess = function(){ resolve(req.result != null ? req.result : null); };
      req.onerror   = function(){ resolve(null); };
    } catch(_) { resolve(null); }
  });
}
function idbColSave(arr){ try { if(_colOK) _colStore('readwrite').put(arr, 'collection'); } catch(_){} }
function idbColClear(){ try { if(_colOK) _colStore('readwrite').delete('collection'); } catch(_){} }
async function hydrateCollection(){
  await _colOpen();
  if(!_colOK) return;  // fallback: keep the synchronous localStorage seed (behavior unchanged)
  try {
    const stored = await idbColLoad();
    if (stored == null) {
      // one-time COPY migration: localStorage seed → IndexedDB (pkv2_col left intact)
      if (Array.isArray(collection) && collection.length) idbColSave(collection);
      return;  // in-memory already equals the migrated seed this session
    }
    // IndexedDB is authoritative: replace the in-memory array
    if (Array.isArray(stored)) collection = stored;
    // Version-gated stale-price-stamp clear (mirrors the load-time schema guard), applied to IDB data
    if (window._collectionSchemaReset && Array.isArray(collection)) {
      let _cleared = 0;
      collection.forEach(function(card){
        if (card && card.lastMarketValue != null) {
          delete card.lastMarketValue; delete card.lastPricedAt;
          delete card.lastPriceConfidence; delete card.lastPriceSource; _cleared++;
        }
      });
      if (_cleared) idbColSave(collection);
    }
    try { AppState.update(); AppState.renderActive(); } catch(_){}
  } catch(_){}
}

// ════════════════════════════════════════════════════════════════════════════
// ── PRICE CACHE STORE (IndexedDB: mytcg_pcache) ──
// ════════════════════════════════════════════════════════════════════════════
// ── Tier 1: durable price cache in IndexedDB (per-key writes). pcache stays the
// synchronous in-memory object used by every read; this only changes persistence.
// The localStorage 'pkv2_pcache' blob is left in place as a frozen rollback copy.
let _idbDB = null, _idbOK = false;
function _idbOpen(){
  return new Promise(function(resolve){
    try {
      if (!window.indexedDB) return resolve(null);
      const req = indexedDB.open('mytcg_pcache', 1);
      req.onupgradeneeded = function(e){ const db = e.target.result; if(!db.objectStoreNames.contains('pcache')) db.createObjectStore('pcache'); };
      req.onsuccess = function(e){ _idbDB = e.target.result; _idbOK = true; resolve(_idbDB); };
      req.onerror   = function(){ resolve(null); };
    } catch(_) { resolve(null); }
  });
}
function _idbStore(mode){ return _idbDB.transaction('pcache', mode).objectStore('pcache'); }
function idbGetAll(){
  return new Promise(function(resolve){
    if(!_idbOK) return resolve({});
    try {
      const out = {}, cur = _idbStore('readonly').openCursor();
      cur.onsuccess = function(e){ const c = e.target.result; if(c){ out[c.key] = c.value; c.continue(); } else resolve(out); };
      cur.onerror   = function(){ resolve(out); };
    } catch(_) { resolve({}); }
  });
}
function idbPut(k,v){ try { if(_idbOK) _idbStore('readwrite').put(v,k); } catch(_){} }
function idbDelete(k){ try { if(_idbOK) _idbStore('readwrite').delete(k); } catch(_){} }
function idbClear(){ try { if(_idbOK) _idbStore('readwrite').clear(); } catch(_){} }
async function hydratePcache(){
  await _idbOpen();
  if(!_idbOK) return;  // fallback: keep the synchronous localStorage seed (behavior unchanged)
  try {
    if (window._pcacheSchemaReset) { idbClear(); return; }  // schema bump → wipe stale IDB too
    const all = await idbGetAll();
    const seedKeys = Object.keys(pcache);
    if ((!all || Object.keys(all).length === 0) && seedKeys.length) {
      // one-time COPY migration: localStorage blob → IndexedDB (blob left intact)
      seedKeys.forEach(function(k){ idbPut(k, pcache[k]); });
      return;  // pcache already equals the migrated seed this session
    }
    // IndexedDB is authoritative: replace in-memory contents (drops stale/invalidated keys)
    Object.keys(pcache).forEach(function(k){ delete pcache[k]; });
    Object.assign(pcache, all);
    try { AppState.update(); AppState.renderActive(); } catch(_){}
  } catch(_){}
}

// ── PER-CARD PRICE HISTORY ENGINE ──
// Records each card's price over time → real trend charts. {cacheKey: [{d,v}]}
let cardHistory = JSON.parse(localStorage.getItem('pkv2_cardhist') || '{}');
function recordCardPrice(card, price) {
  if (!price || price <= 0 || !isFinite(price)) return;
  const key = cacheKey(card);
  const today = new Date().toISOString().slice(0,10);
  if (!cardHistory[key]) cardHistory[key] = [];
  const s = cardHistory[key];
  const last = s[s.length-1];
  if (last && last.d === today) last.v = +price.toFixed(2);
  else s.push({ d: today, v: +price.toFixed(2) });
  if (s.length > 400) s.splice(0, s.length - 400);
}
function saveCardHistory() {
  try { localStorage.setItem('pkv2_cardhist', JSON.stringify(cardHistory)); } catch(e){}
}
function getCardHistory(card, days) {
  const key = cacheKey(card);
  let s = cardHistory[key] || [];
  if (days && s.length) {
    const cut = new Date(Date.now()-days*86400000).toISOString().slice(0,10);
    s = s.filter(p => p.d >= cut);
  }
  return s;
}

// ════════════════════════════════════════════════════════════════════════════
// ── HISTORY STORE ──
// ARCHITECTURAL INVARIANT: nothing outside this block reads or writes the
// history keys directly. Before this, five renderers, the sync layer and the
// export path each did their own JSON.parse(localStorage.getItem(...)) with
// three different spellings of the key ('pkv2_ph2' vs HISTORY_KEY) and two
// different fallbacks ('[]' vs '{}'), so history had no owner and a malformed
// record failed differently depending on which screen you were looking at.
// Keys, formats and fallbacks are UNCHANGED — this only centralises access.
//   pkv2_ph2 (portfolio history) — array of rich snapshots {date,totalValue,...}
//   pkv2_vh  (value history)     — LEGACY array of {d,v}; read-only fallback
//   pkv2_wh  (wish history)      — object keyed by wishlist id
// ════════════════════════════════════════════════════════════════════════════
function readPortfolioHistory(){
  const v = readJSON(STORAGE_KEYS.portfolioHistory, []);
  return Array.isArray(v) ? v : [];
}
function writePortfolioHistory(arr){
  if (!Array.isArray(arr)) return false;
  return writeJSON(STORAGE_KEYS.portfolioHistory, arr);
}
// Legacy {d,v} series. Read-only: nothing writes pkv2_vh any more, but existing
// installs still have it and it is the fallback when ph2 is empty.
function readValueHistory(){
  const v = readJSON(STORAGE_KEYS.valueHistory, []);
  return Array.isArray(v) ? v : [];
}
// The chart series every history view draws: rich ph2 normalised to {d,v},
// falling back to the legacy vh series. This normalisation was duplicated
// verbatim in renderDBChart() and renderTimeline().
function portfolioValueSeries(){
  const ph2 = readPortfolioHistory();
  if (ph2.length) return ph2.map(s => ({ d: s.date || s.d, v: s.totalValue || s.v || 0 }));
  return readValueHistory();
}
function readWishHistory(){
  const v = readJSON(STORAGE_KEYS.wishHistory, {});
  return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
}
function writeWishHistory(obj){
  if (!obj || typeof obj !== 'object') return false;
  return writeJSON(STORAGE_KEYS.wishHistory, obj);
}

// ════════════════════════════════════════════════════════════════════════════
// ── DAILY PORTFOLIO SNAPSHOT ──
// ════════════════════════════════════════════════════════════════════════════
function captureHistorySnapshot() {
  try {
    if (AppState._dirty) AppState.update();

    const history = readPortfolioHistory();
    const now     = new Date();
    const dateKey = now.toISOString().slice(0, 10); // YYYY-MM-DD
    const timeKey = now.toISOString();

    // Realized P&L from closed deals
    const closedDeals = deals.filter(d => d.status === 'closed');
    const realizedPnL = closedDeals.reduce((sum, d) => {
      return sum + (parseFloat(d.sellPrice||0) - parseFloat(d.buyPrice||0));
    }, 0);

    const snapshot = {
      ts:           timeKey,
      date:         dateKey,
      totalValue:   AppState.totalValue,
      costBasis:    AppState.totalCost,
      unrealizedPnL:AppState.totalPnL || 0,
      realizedPnL:  realizedPnL,
      totalPnL:     (AppState.totalPnL || 0) + realizedPnL,
      cardCount:    collection.length,
      slabCount:    AppState.slabsCount,
      sealedCount:  AppState.sealedCount,
      cashPosition: AppState.cashPosition,
      topCard:      AppState.bestCard ? { name: AppState.bestCard.card.name, value: AppState.bestCard.bp } : null,
      trigger:      'auto',
    };

    // Update today's snapshot or add new one
    const todayIdx = history.findIndex(s => s.date === dateKey);
    if (todayIdx >= 0) {
      history[todayIdx] = snapshot; // update today's entry
    } else {
      history.push(snapshot); // new day
    }

    writePortfolioHistory(history);
    savePortfolioSnapshot();   // mirror the daily snapshot to structured analytics
    return history;
  } catch(err) {
    console.error('[History] Snapshot failed:', err);
    return [];
  }
}

// ════════════════════════════════════════════════════════════════════════════
// ── SAVE PATHS ──
// ════════════════════════════════════════════════════════════════════════════
// ── SOLD HISTORY PERSISTENCE ──
// soldHistory IS part of synced app state (collectAppData / mergeAppData / applyAppData),
// but save() never owned it: four call sites each did their own
// localStorage.setItem('pkv2_sold', ...). One of them (deleteSoldEntry) never called
// save() at all, so the write never marked the state dirty and never queued a cloud
// push. This is the single persistence path for sold history. Storage key, record
// shape and sync scope are all unchanged.
function saveSoldHistory(){
  try{
    localStorage.setItem(STORAGE_KEYS.soldHistory, JSON.stringify(soldHistory));
  }catch(e){
    console.warn('[soldHistory] persist failed:', e && e.message);
  }
  AppState._dirty = true;
  notifyPersisted();          // debounced downstream — safe to call twice
}

function save(){
  idbColSave(collection);
  saveSoldHistory();          // sold history can no longer be forgotten by a caller
  localStorage.setItem('pkv2_wish',JSON.stringify(wishlist));
  localStorage.setItem('pkv2_sealed',JSON.stringify(sealed));
  localStorage.setItem('pkv2_deals',JSON.stringify(deals));
  // Invalidate tab render caches so they refresh next visit
  ['page-singles','page-psa','page-sealed','page-wishlist','page-deals'].forEach(id=>{
    const el=document.getElementById(id);if(el)el._rendered=false;
  });
  AppState._dirty = true;
  setTimeout(captureHistorySnapshot, 500); // capture after state updates
  notifyPersisted();          // cloud push happens via a subscriber, not a direct call
}
