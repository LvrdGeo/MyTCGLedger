/* ════════════════════════════════════════════════════════════════════════════
   MyTCG Ledger V6 - app-state.js
   ────────────────────────────────────────────────────────────────────────────
   THE SHARED MUTABLE STATE LAYER. Every domain module reads these globals at
   CALL time; this file is where they are declared and hydrated from
   localStorage. It is deliberately the last piece of "the monolith" to move,
   because it is what all 28 modules have been referencing.

   OWNS:
     - entity arrays   collection, sealed, wishlist, deals, soldHistory
     - caches/config   pcache, keys, prefs, allSets
     - UI selection    typeFilter, sealedFilter, sealedSetFilter, sortBy,
                       editingId, editingSealedId, tlRange, _pickerCard,
                       _pickerEdition, _pickerWatchKind, searchTimer
     - constants       SCHEMA_VERSION, SOURCES, EBAY_WORKER, HISTORY_KEY
     - cash position   _cashPosition
     - schema guard    the version check that runs at load

   LOAD ORDER: immediately after core.js, because `keys` and `prefs` call
   readJSON()/STORAGE_KEYS at LOAD time. Everything else that touches these
   globals does so at call time, so any later module is safe.

   LOAD-TIME EXECUTION: the localStorage hydration of each global plus the
   schema-version guard - exactly as before, byte-identical. No render, no
   fetch, no network, no persistence write beyond the guard's own behaviour.
   ════════════════════════════════════════════════════════════════════════════ */

// ═══ STATE ═══
let collection = JSON.parse(localStorage.getItem('pkv2_col')   || '[]');
let sealed     = JSON.parse(localStorage.getItem('pkv2_sealed') || '[]');
let wishlist   = JSON.parse(localStorage.getItem('pkv2_wish')  || '[]');
let deals      = JSON.parse(localStorage.getItem('pkv2_deals') || '[]');
let soldHistory= JSON.parse(localStorage.getItem('pkv2_sold')  || '[]');

// ════════════════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════════════════
// ── PERSISTENCE CHANGE NOTIFICATION ──
// ARCHITECTURAL INVARIANT: the persistence layer must not know that a sync layer
// exists. save() / saveSoldHistory() / saveCashPosition() used to call
// syncQueuePush() directly, which made storage depend on sync — the last
// bidirectional edge in the dependency graph (sync also calls save()).
// They now announce "local state changed" and the sync layer subscribes.
// Behaviour is identical: the single subscriber registered below IS
// syncQueuePush, which is debounced and a no-op when signed out or offline.
// ════════════════════════════════════════════════════════════════════════════

// ── STORAGE HELPERS ──
// Safe localStorage read/write wrappers: never throw, no UI side-effects.
// INVARIANT: these are the lowest layer — they must not call anything else in
// the app. The HISTORY STORE is built on them; adopt them for new persistence
// rather than hand-rolling another JSON.parse(localStorage.getItem(...)).
// ════════════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════════════
// ── STORAGE KEY REGISTRY · Maintainability Patch 4 · pure addition (2026-06) ──
// Single catalogue of the app's current localStorage keys. ADDITIVE ONLY — used
// nowhere yet; every existing hardcoded 'pkv2_*' string is left untouched. The
// values below mirror those literals exactly (verified against the code). This
// is reference/centralization only, not wired into save / sync / storage.
// (Patch 4A: 'pkv2_lastpage' is now catalogued below — registry lists all 15 current keys.)
// Rollback: delete this block.
// ════════════════════════════════════════════════════════════════════════════

// Portfolio-wide realizable total. SEPARATE aggregator — mirrors the read pattern
// AppState uses but never touches AppState. Read-only over collection/sealed/pcache.



// ── Schema version guard ──
// If the data format changes, bump SCHEMA_VERSION to auto-clear stale data
const SCHEMA_VERSION = '6.8';
if (localStorage.getItem(STORAGE_KEYS.schema) !== SCHEMA_VERSION) {
  console.log('[Schema] Version mismatch — clearing price cache + stale graded values');
  localStorage.removeItem('pkv2_pcache');
  localStorage.setItem('pkv2_pcache', '{}');
  window._pcacheSchemaReset = true;  // hydratePcache() will also clear IndexedDB
  window._collectionSchemaReset = true;  // hydrateCollection() re-applies the stamp-clear to IDB
  // Clear stale lastMarketValue on ALL cards so bad synced prices (e.g. the old
  // junk-comp graded prices) get re-fetched fresh instead of stuck as a fallback.
  try {
    const _c = JSON.parse(localStorage.getItem('pkv2_col') || '[]');
    let _cleared = 0;
    _c.forEach(card => {
      if (card.lastMarketValue != null) {
        delete card.lastMarketValue; delete card.lastPricedAt;
        delete card.lastPriceConfidence; delete card.lastPriceSource;
        _cleared++;
      }
    });
    if (_cleared) { localStorage.setItem('pkv2_col', JSON.stringify(_c)); console.log('[Schema] Cleared '+_cleared+' stale price stamps'); }
  } catch(e) {}
  localStorage.setItem(STORAGE_KEYS.schema, SCHEMA_VERSION);
}

// ── MIGRATION: fix cards that have a grade but wrong type ──
try {
  const _col = JSON.parse(localStorage.getItem('pkv2_col') || '[]');
  let _fixed = 0;
  _col.forEach(c => {
    // If a card has a grade (PSA 10, BGS 9.5, etc) but isn't marked graded, fix it
    if (c.grade && c.grade.trim() && c.type !== 'graded') {
      c.type = 'graded';
      _fixed++;
    }
    // Also catch cards with a cert number but no graded type
    if (c.cert && c.cert.trim() && c.type !== 'graded') {
      c.type = 'graded';
      _fixed++;
    }
  });
  if (_fixed > 0) {
    console.log('[Migration] Fixed ' + _fixed + ' graded cards that were miscategorized');
    localStorage.setItem('pkv2_col', JSON.stringify(_col));
  }
} catch(e) { console.error('[Migration] failed:', e); }

let keys       = JSON.parse(localStorage.getItem(STORAGE_KEYS.keys)  || '{"ptcg":"83d3cfd0-e05d-4fc0-9a4d-efef50602756","ppt":"","psa":""}');
// Backfill the pokemontcg.io key if it was never set or was cleared, so TCGPlayer
// lookups stay authenticated (unauthenticated requests are rate-limited → missing TCG prices).
if (!keys.ptcg) { keys.ptcg = '83d3cfd0-e05d-4fc0-9a4d-efef50602756'; localStorage.setItem(STORAGE_KEYS.keys, JSON.stringify(keys)); }

let prefs      = readJSON(STORAGE_KEYS.prefs, { cond: 'NM' });  // Patch 5: key via STORAGE_KEYS.prefs (resolves to 'pkv2_prefs')
let pcache     = JSON.parse(localStorage.getItem('pkv2_pcache')|| '{}');
let allSets=[], typeFilter='', sealedFilter='', sealedSetFilter='', sortBy='added';
let editingId=null, editingSealedId=null, tlRange='all';   // editingDealId removed with the v1 deal modal
let _pickerCard=null, _pickerEdition='unlimited', _pickerWatchKind='single', searchTimer=null;

const SOURCES=[
  {k:'tcg', label:'TCGPlayer', color:'#f5c842'},
  {k:'ebay',label:'eBay Sold', color:'#4f8ef7'},
  {k:'ppt', label:'PokePrice',color:'#0fd4b0'},
  {k:'psa', label:'PSA Market',color:'#b06ef5'},
];
// CACHE_TTL moved to js/pricing.js (its only consumer). EBAY_WORKER stays here:
// it is shared by liquidity, sealed, JP catalogue and the scanner as well as pricing.
const EBAY_WORKER = 'https://mytcgledger-ebay.geo6810-03e.workers.dev';

// ═══════════════════════════════════════════════════════════════════
// EDITION MODEL — 1st Edition / Unlimited / Shadowless
// Single source of truth for eligibility, pricing, caching & display.
// To change which sets are edition-eligible, edit WOTC_SETS ONLY.
// Cutoff = Neo Destiny (last English set with a 1st Edition print run).
// Base Set 2 (base4) intentionally excluded — reprint, no 1st Edition.
// ═══════════════════════════════════════════════════════════════════
