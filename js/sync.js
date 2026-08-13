/* ════════════════════════════════════════════════════════════════════════════
   MyTCG Ledger V6 - sync.js
   ────────────────────────────────────────────────────────────────────────────
   LAYER 7 (SYNC). Cloud/local reconciliation. THE most safety-critical file:
   it is what stops a user losing newer device data, resurrecting a deleted
   record, or overwriting cloud state with stale local state.

   OWNS:
     - sync state      _syncState, _syncPushTimer, _syncPending,
                       _syncReconciled, _lastLocalChange
     - transport       syncPull, syncPush, syncReconcile   (table user_app_state)
     - queue           syncQueuePush (1500ms debounce), online/offline listeners
     - merge           collectAppData, applyAppData, mergeAppData
     - wish history    _wishSeries, mergeWishHistory
     - status          setSyncStatus

   DEPENDENCY DIRECTION - storage NEVER calls sync. The contract is:
       local mutation -> save() -> notifyPersisted() -> [sync subscriber] -> queue
   The subscription `onPersist(() => syncQueuePush())` lives HERE, at the bottom
   of this file. Do not reintroduce a direct storage->sync call.

   SEMANTIC INVARIANTS (contract - do not alter without a parity run):
     - _syncReconciled gates every push. Before the first successful reconcile a
       queued push is DEFERRED (_syncPending = true), never sent, so stale local
       state cannot overwrite newer cloud state.
     - The deletion ledger is monotonic: syncPush() unions the cloud ledger into
       the payload first, so a background push can never erase another device's
       deletion.
     - applyDeletions() suppresses retired cards / sealed / wishlist / deals /
       sold history on both merge and apply - a cloud copy never resurrects.
     - mergeAppData is price-aware: the record with the newer lastPricedAt wins.
     - Wish history merges PER SERIES, PER DATE, local wins a same-date tie.
       Never `.length`, never Array.isArray on the object, never "more keys wins".

   OUTBOUND DEPENDENCIES (all call-time, none at load):
     - core       readJSON, STORAGE_KEYS, onPersist
     - storage    readPortfolioHistory, readWishHistory, writePortfolioHistory,
                  writeWishHistory, idbColSave, hydrate* state
     - identity   unionLedger, applyDeletions, deletionLedger
     - inline     supa + currentUser (auth, still inline - read per call, so this
                  file is safe to load before them), the state globals, and the
                  auth/sync UI (setSyncStatus calls renderAccountSection +
                  updateAuthUI; syncReconcile calls renderAll behind a typeof
                  guard). Account UI deliberately stayed inline.

   LOAD-TIME EXECUTION: the five state declarations, the two window online/offline
   listeners, and the single onPersist() subscription. No network call, no
   Supabase access, and no push occurs from loading this file.
   ════════════════════════════════════════════════════════════════════════════ */

// ══════════════════════════════════════════════════════════
// STAGE 2 — PORTFOLIO SYNC (offline-first)
// localStorage stays the working layer. Supabase is the backup/sync layer.
//   • Signed out → pure local, nothing changes.
//   • Sign in    → pull cloud, merge with local (nothing lost), push result.
//   • On change  → save local now, debounced push to cloud in background.
//   • On open    → pull latest, reconcile by timestamp.
//   • Offline    → works locally; pending changes flush on reconnect.
// One JSON row per user in user_app_state. Last-write-wins by updated_at.
// ══════════════════════════════════════════════════════════
let _syncState = 'idle';        // idle | syncing | synced | offline | error
let _syncPushTimer = null;
let _syncPending = false;
let _syncReconciled = false;    // true only after a successful syncReconcile() this session (cloud-push guard)
let _lastLocalChange = 0;       // ms timestamp of last local mutation

// Gather everything we sync into one plain object
function collectAppData() {
  return {
    collection,
    wishlist,
    sealed,
    deals,
    soldHistory,
    cardHistory: (typeof cardHistory !== 'undefined' ? cardHistory : JSON.parse(localStorage.getItem('pkv2_cardhist')||'{}')),
    portfolioHistory: readPortfolioHistory(),
    // Sends the real object shape. Safe now that mergeAppData() merges wish history
    // per entry instead of comparing `.length` (see WISH HISTORY MERGE).
    wishHistory: readWishHistory(),
    cashPosition: parseFloat(localStorage.getItem('pkv2_cash') || '0'),
    deletionLedger: Array.isArray(deletionLedger) ? deletionLedger : [],
    _localChange: _lastLocalChange || Date.now()
  };
}

// Write a pulled cloud object back into local state + localStorage
function applyAppData(d) {
  if (!d || typeof d !== 'object') return;
  if (Array.isArray(d.collection))  { collection  = d.collection;  idbColSave(collection); }
  if (Array.isArray(d.wishlist))    { wishlist    = d.wishlist;    localStorage.setItem('pkv2_wish',   JSON.stringify(wishlist)); }
  if (Array.isArray(d.sealed))      { sealed      = d.sealed;      localStorage.setItem('pkv2_sealed', JSON.stringify(sealed)); }
  if (Array.isArray(d.deals))       { deals       = d.deals;       localStorage.setItem('pkv2_deals',  JSON.stringify(deals)); }
  // Direct setItem on purpose — this is the INBOUND apply path. Routing it through
  // saveSoldHistory() would queue a cloud push immediately after a pull (ping-pong).
  if (Array.isArray(d.soldHistory)) { soldHistory = d.soldHistory; localStorage.setItem(STORAGE_KEYS.soldHistory, JSON.stringify(soldHistory)); }
  if (d.cardHistory && typeof d.cardHistory==='object') { localStorage.setItem('pkv2_cardhist', JSON.stringify(d.cardHistory)); if(typeof cardHistory!=='undefined') cardHistory = d.cardHistory; }
  if (Array.isArray(d.portfolioHistory)) writePortfolioHistory(d.portfolioHistory);
  // Accepts the real object shape. The old Array.isArray() guard could never pass,
  // so inbound wish history was silently dropped on every pull.
  if (d.wishHistory && typeof d.wishHistory === 'object' && !Array.isArray(d.wishHistory)) {
    writeWishHistory(d.wishHistory);
  }
  if (typeof d.cashPosition === 'number') { localStorage.setItem('pkv2_cash', d.cashPosition.toFixed(2)); if(typeof _cashPosition!=='undefined') _cashPosition = d.cashPosition; }
  // Deletion ledger: union in (monotonic — never shrinks), then suppress in-memory lists.
  if (Array.isArray(d.deletionLedger)) {
    deletionLedger = unionLedger(deletionLedger, d.deletionLedger);
    if (Array.isArray(collection)) { collection = applyDeletions(collection, deletionLedger, 'card'); idbColSave(collection); }
    if (Array.isArray(sealed))   { sealed   = applyDeletions(sealed,   deletionLedger, 'sealed'); }
    if (Array.isArray(wishlist)) { wishlist = applyDeletions(wishlist, deletionLedger, 'wishlist'); }
    if (Array.isArray(deals))    { deals    = applyDeletions(deals,    deletionLedger, 'deal'); }
    // 'sold' was the one entity type mergeAppData() suppressed but applyAppData() did
    // not, so a retired sale could come back on a pull-only path. Same helper, same
    // ledger semantics — only the missing call site is added.
    if (Array.isArray(soldHistory)) { soldHistory = applyDeletions(soldHistory, deletionLedger, 'sold'); localStorage.setItem(STORAGE_KEYS.soldHistory, JSON.stringify(soldHistory)); }
  }
}

// Merge cloud + local so the FIRST sign-in never loses anything.
// Arrays merge by id (union, local wins on id clash since it's the device in hand).
function mergeAppData(localD, cloudD) {
  const mergeById = (a=[], b=[]) => {
    const map = new Map();
    (b||[]).forEach(x => { if(x && x.id!=null) map.set(x.id, x); });
    (a||[]).forEach(x => { if(x && x.id!=null) map.set(x.id, x); }); // local overrides
    // include any id-less items just in case
    const extras = [...(a||[]), ...(b||[])].filter(x => !x || x.id==null);
    return [...map.values(), ...extras];
  };
  // Collection merge is price-aware: keep the local record, but adopt whichever
  // side has the NEWER lastPricedAt for the price fallback fields. This makes two
  // devices converge to the same (freshest) market value.
  const mergeCollection = (a=[], b=[]) => {
    const cloudMap = new Map();
    (b||[]).forEach(x => { if(x && x.id!=null) cloudMap.set(x.id, x); });
    const seen = new Set();
    const out = [];
    (a||[]).forEach(local => {
      if (!local || local.id==null) { out.push(local); return; }
      seen.add(local.id);
      const cloud = cloudMap.get(local.id);
      if (cloud && (cloud.lastPricedAt||0) > (local.lastPricedAt||0)) {
        // Cloud priced this card more recently → adopt its price fields only.
        out.push({ ...local,
          lastMarketValue: cloud.lastMarketValue,
          lastPricedAt: cloud.lastPricedAt,
          lastPriceConfidence: cloud.lastPriceConfidence,
          lastPriceSource: cloud.lastPriceSource });
      } else {
        out.push(local);
      }
    });
    // Cards that exist only in the cloud (added on another device)
    (b||[]).forEach(cloud => { if(cloud && cloud.id!=null && !seen.has(cloud.id)) out.push(cloud); });
    return out;
  };
  const mergedCardHist = Object.assign({}, cloudD.cardHistory||{}, localD.cardHistory||{});
  // Deletion ledger: union FIRST (monotonic, never shrinks), then suppress per domain
  // with fold-before-drop. Inert when the ledger is empty (byte-identical to pre-ledger).
  const mergedLedger = unionLedger(localD.deletionLedger, cloudD.deletionLedger);
  return {
    collection:  applyDeletions(mergeCollection(localD.collection,  cloudD.collection), mergedLedger, 'card'),
    wishlist:    applyDeletions(mergeById(localD.wishlist,    cloudD.wishlist),    mergedLedger, 'wishlist'),
    sealed:      applyDeletions(mergeById(localD.sealed,      cloudD.sealed),      mergedLedger, 'sealed'),
    deals:       applyDeletions(mergeById(localD.deals,       cloudD.deals),       mergedLedger, 'deal'),
    soldHistory: applyDeletions(mergeById(localD.soldHistory, cloudD.soldHistory), mergedLedger, 'sold'),
    cardHistory: mergedCardHist,
    deletionLedger: mergedLedger,
    // histories: take whichever is longer (more data)
    portfolioHistory: (localD.portfolioHistory||[]).length >= (cloudD.portfolioHistory||[]).length ? localD.portfolioHistory : cloudD.portfolioHistory,
    // Per-entry union by date. Was: `.length` comparison on an object, i.e. always
    // undefined >= undefined === false, so cloud replaced local unconditionally.
    wishHistory:      mergeWishHistory(localD.wishHistory, cloudD.wishHistory),
    cashPosition: (typeof localD.cashPosition==='number' && localD.cashPosition>0) ? localD.cashPosition : (cloudD.cashPosition||0),
    _localChange: Date.now()
  };
}

function setSyncStatus(state) {
  _syncState = state;
  renderAccountSection();
  updateAuthUI();
}

// Pull the user's cloud row
async function syncPull() {
  if (!supa || !currentUser) return null;
  const { data, error } = await supa
    .from('user_app_state')
    .select('data, updated_at')
    .eq('user_id', currentUser.id)
    .maybeSingle();
  if (error) { console.warn('[Sync] pull error', error.message); throw error; }
  return data; // { data:{...}, updated_at } or null
}

// Push current local state to cloud
async function syncPush() {
  if (!supa || !currentUser) return false;
  const payload = collectAppData();
  // Fix C1: the deletion ledger is monotonic. Before a (possibly stale) blind push,
  // union our ledger with the cloud's so a background push can NEVER shrink/erase
  // deletions another device wrote. Cheap read of just the ledger; best-effort.
  try {
    const cur = await syncPull();
    if (cur && cur.data && Array.isArray(cur.data.deletionLedger)) {
      const unioned = unionLedger(payload.deletionLedger, cur.data.deletionLedger);
      payload.deletionLedger = unioned;
      deletionLedger = unioned;
    }
  } catch (e) { /* offline/read-failed → push our ledger as-is (still never deletes a cloud entry on its own) */ }
  const { error } = await supa
    .from('user_app_state')
    .upsert({ user_id: currentUser.id, data: payload, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
  if (error) { console.warn('[Sync] push error', error.message); setSyncStatus('error'); return false; }
  return true;
}

// First reconcile after sign-in / app open
async function syncReconcile() {
  if (!supa || !currentUser) return;
  if (!navigator.onLine) { setSyncStatus('offline'); return; }
  setSyncStatus('syncing');
  _syncReconciled = false;            // re-reconciling — block pushes until this succeeds
  try {
    const cloud = await syncPull();
    const localD = collectAppData();
    const localHasData = (collection.length + wishlist.length + sealed.length + deals.length + soldHistory.length) > 0;

    if (!cloud) {
      // No cloud row yet → first sign-in. Push local up (your migration).
      await syncPush();
      _syncReconciled = true;
      setSyncStatus('synced');
      if (_syncPending) { _syncPending = false; syncQueuePush(); }
      return;
    }

    const cloudD = cloud.data || {};
    const cloudChange = new Date(cloud.updated_at).getTime();
    const localChange = localD._localChange || 0;
    const cloudHasData = ((cloudD.collection||[]).length + (cloudD.wishlist||[]).length + (cloudD.sealed||[]).length + (cloudD.deals||[]).length + (cloudD.soldHistory||[]).length) > 0;

    if (localHasData && cloudHasData) {
      // Both have data → MERGE on first reconcile so nothing is ever lost.
      const merged = mergeAppData(localD, cloudD);
      applyAppData(merged);
      await syncPush();
    } else if (cloudHasData && !localHasData) {
      // Fresh device → pull cloud down.
      applyAppData(cloudD);
    } else {
      // Local has data, cloud empty → push up.
      await syncPush();
    }
    if (typeof renderAll === 'function') renderAll();
    _syncReconciled = true;
    setSyncStatus('synced');
    if (_syncPending) { _syncPending = false; syncQueuePush(); }
  } catch (e) {
    console.error('[Sync] reconcile failed', e);
    setSyncStatus('error');
  }
}

// Called by save() — debounced background push
// The sync layer's single subscription to the persistence layer. This is the
// whole of the storage→sync coupling, and it points sync→storage (registration),
// which is the direction that lets storage.js be extracted on its own.
onPersist(() => syncQueuePush());

function syncQueuePush() {
  _lastLocalChange = Date.now();
  if (!supa || !currentUser) return;       // signed out → local only
  if (!navigator.onLine) { _syncPending = true; setSyncStatus('offline'); return; }
  if (!_syncReconciled) { _syncPending = true; setSyncStatus('error'); return; }   // not reconciled this session → hold, don't overwrite cloud
  clearTimeout(_syncPushTimer);
  setSyncStatus('syncing');
  _syncPushTimer = setTimeout(async () => {
    const ok = await syncPush();
    setSyncStatus(ok ? 'synced' : 'error');
  }, 1500); // debounce — wait for edits to settle
}

// Flush pending changes when connection returns
window.addEventListener('online', () => {
  if (currentUser && _syncPending) {
    _syncPending = false;
    syncQueuePush();
  }
});
window.addEventListener('offline', () => {
  if (currentUser) setSyncStatus('offline');
});

// ════════════════════════════════════════════════════════════════════════════
// ── WISH HISTORY MERGE ──
// SHAPE (written by captureWishSnapshot):
//   { "<wishlistId>": [ {d:'YYYY-MM-DD', v:Number}, ... ],   // ascending by date
//     "_total":       [ {d:'YYYY-MM-DD', v:Number}, ... ] }  // reserved key
//   One point per series per day; a same-day re-capture overwrites v. Points are
//   never removed (a deleted watchlist item leaves its series behind).
//
// WHY THIS EXISTS: pkv2_wh is an OBJECT, but the sync layer treated it as an
// array — applyAppData() guarded with Array.isArray() (never true, so inbound
// history was never applied) and mergeAppData() picked a winner with `.length`
// (undefined on an object, so the comparison was always false). Net effect: wish
// history never synced, and whichever side "won" replaced the other wholesale.
//
// MERGE RULE: per-entry union keyed by date — NOT "more keys wins". Every point
// carries its own date, so the two sides can be combined without discarding
// either. On a same-date collision the LOCAL value wins, matching how the rest of
// mergeAppData treats records the local device holds. Deterministic, and no point
// present on either side is ever lost. Inputs are never mutated.
// ════════════════════════════════════════════════════════════════════════════
function _wishSeries(v){
  // Tolerate anything: only well-formed {d,v} points survive.
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const p of v) {
    if (!p || typeof p !== 'object') continue;
    const d = p.d, n = parseFloat(p.v);
    if (typeof d !== 'string' || !d || !isFinite(n)) continue;
    out.push({ d, v: n });
  }
  return out;
}
function mergeWishHistory(localH, cloudH){
  const L = (localH && typeof localH === 'object' && !Array.isArray(localH)) ? localH : {};
  const C = (cloudH && typeof cloudH === 'object' && !Array.isArray(cloudH)) ? cloudH : {};
  const out = {};
  for (const key of new Set([...Object.keys(C), ...Object.keys(L)])) {
    const byDate = new Map();
    for (const p of _wishSeries(C[key])) byDate.set(p.d, p.v);   // cloud first…
    for (const p of _wishSeries(L[key])) byDate.set(p.d, p.v);   // …local overwrites same date
    const series = [...byDate.entries()].map(([d, v]) => ({ d, v })).sort((a, b) => a.d < b.d ? -1 : a.d > b.d ? 1 : 0);
    if (series.length) out[key] = series;
  }
  return out;
}
