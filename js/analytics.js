/* ════════════════════════════════════════════════════════════════════════════
   MyTCG Ledger V6 - analytics.js
   ────────────────────────────────────────────────────────────────────────────
   LAYER 6 (ANALYTICS). Depends on core, valuation, state - all at CALL TIME.

   OWNS - the additive structured-analytics writes to Supabase:
     dbWrite                  fire-and-forget guard around every write
     buildHoldingRow          holdings row builder (live cache only)
     saveHoldingToDatabase    -> table `holdings`        (upsert)
     buildSnapshotRow         price_snapshots row builder
     savePriceSnapshot        -> table `price_snapshots` (insert, single)
     flushPriceAnalytics      -> table `price_snapshots` (insert, bulk)
     savePortfolioSnapshot    -> table `portfolio_snapshots` (upsert)
     saveTransactionToDatabase-> table `transactions`    (insert, append-only)

   DOES NOT OWN: auth, user_app_state, sync merge, persistence, IndexedDB,
   storage keys, identity rules, pricing acquisition, rendering. Market signals
   (calculateMarketSignal) and deal evaluation (saveDealEvaluation) merely USE
   dbWrite - they are feature logic and deliberately stayed inline.

   INVARIANT - THESE WRITES ARE ADDITIVE AND NEVER AUTHORITATIVE. localStorage +
   user_app_state remain the source of truth. dbWrite() silently no-ops when
   signed out, offline, or if Supabase is unavailable, and swallows every error,
   so an analytics failure can never block a save or corrupt user data.
   Do not add retries, batching, or throw-on-error here.

   OUTBOUND DEPENDENCIES (all call-time, none at load):
     - Supabase   `supa` + `currentUser`, declared by the inline app which loads
                  AFTER this file. dbWrite reads them per call and returns null
                  if either is missing, so load order cannot break it.
     - valuation  cardPriceEntry, bestPrice, analyzePriceRouted, cacheKey
     - state      AppState (portfolio snapshot totals)
     - inline app the state globals collection / sealed / soldHistory / pcache

   STORAGE -> ANALYTICS EDGE: storage.js's captureHistorySnapshot() calls
   savePortfolioSnapshot() by global name. analytics.js loads AFTER storage.js,
   which is safe because that call happens only from save() at run time - never
   while either file is being evaluated.

   LOAD-TIME EXECUTION: none. Declarations only.
   ════════════════════════════════════════════════════════════════════════════ */

// ══════════════════════════════════════════════════════════
// STRUCTURED ANALYTICS WRITES (Supabase — Phase 2)
// ──────────────────────────────────────────────────────────
// Additive long-term analytics store. localStorage + user_app_state remain the
// source of truth; these writes are fire-and-forget and must NEVER block the UI
// or throw. dbWrite() silently no-ops when signed out, offline, or if Supabase
// is unavailable, so a write failure can never corrupt or interrupt a save.
// ══════════════════════════════════════════════════════════
async function dbWrite(fn){
  try{
    if(!supa || !currentUser || !navigator.onLine) return null;
    return await fn(supa, currentUser);
  }catch(e){
    console.warn('[db] structured write skipped:', e && e.message);
    return null;
  }
}

// Build a complete holdings row from a collection card. market_value comes from
// the LIVE price cache only (never a stored/synced fallback), matching
// AppState.update — so a stale value can't pollute the row. With no live price,
// market_value / price_source / confidence are null (never invented).
function buildHoldingRow(card, userId){
  const hit     = cardPriceEntry(card);   // live cache only — never the synced fallback (see note above)
  const p       = hit?.data;
  const isG     = card.type==='graded';
  const bp      = p ? bestPrice(p, isG) : null;
  const hasLive = bp != null && isFinite(bp) && bp > 0;
  const a       = (hasLive && p) ? analyzePriceRouted(p, isG) : null;   // {price, confidence, sources}
  const src     = (a && a.sources && Object.keys(a.sources).length) ? Object.keys(a.sources).join('+') : null;
  const cb      = parseFloat(card.paid);
  return {
    user_id:            userId,
    client_id:          card.id,
    name:               card.name || null,
    card_set:           card.set || null,
    card_number:        card.num || null,
    card_id:            card.cardId || null,
    item_type:          card.type || null,
    condition:          card.cond || null,
    edition:            card.edition || null,
    grade:              card.grade || null,
    cert:               card.cert || null,
    rarity:             card.rarity || null,
    quantity:           parseInt(card.qty, 10) || 1,
    cost_basis:         (isFinite(cb) && cb >= 0) ? cb : null,
    acquisition_source: card.source || null,
    image_url:          card.img || null,
    notes:              card.notes || null,
    market_value:       hasLive ? bp : null,
    price_confidence:   a ? a.confidence : (card.lastPriceConfidence || null),
    price_source:       src || card.lastPriceSource || null,
    priced_at:          (hasLive && hit && hit.ts) ? new Date(hit.ts).toISOString()
                          : (card.lastPricedAt ? new Date(card.lastPricedAt).toISOString() : null),
    acquired_at:        card.added || null,
    updated_at:         new Date().toISOString()
  };
}

// Upsert one holding (current-state mirror), keyed by (user_id, client_id).
function saveHoldingToDatabase(card){
  if(!card || !card.id) return;
  return dbWrite(async (db, user) => {
    const { error } = await db.from('holdings').upsert(buildHoldingRow(card, user.id), { onConflict: 'user_id,client_id' });
    if(error) console.warn('[db] holdings upsert error:', error.message);
  });
}

// Build one price-snapshot row: resolved best price + per-source breakdown +
// comps + confidence, all from real price fields. Missing values => null.
function buildSnapshotRow(card, data, userId){
  const a     = analyzePriceRouted(data, card.type==='graded');   // {price, confidence, sources}
  const num   = v => (v != null && isFinite(parseFloat(v))) ? parseFloat(v) : null;
  const comps = parseInt(data && data.ebayN, 10);
  const mp    = (a && isFinite(a.price) && a.price > 0) ? a.price : null;
  const src   = (a && a.sources && Object.keys(a.sources).length) ? Object.keys(a.sources).join('+') : null;
  return {
    user_id:       userId,
    client_id:     card.id,
    card_name:     card.name || null,
    snapshot_date: new Date().toISOString().slice(0,10),   // YYYY-MM-DD (UTC)
    market_price:  mp,
    price_source:  src,
    comps_count:   Number.isFinite(comps) ? comps : null,
    confidence:    (a && a.confidence) || null,
    tcg_price:     num(data && data.tcg),
    ebay_price:    num(data && data.ebay),
    ppt_price:     num(data && data.ppt),
    psa_price:     num(data && data.psa),
    updated_at:    new Date().toISOString()
  };
}

// Upsert one price snapshot for a single card (one row per card per day;
// same-day re-fetches overwrite that day's row via the unique constraint).
function savePriceSnapshot(card, data){
  if(!card || !card.id || !data) return;
  return dbWrite(async (db, user) => {
    const { error } = await db.from('price_snapshots').upsert(buildSnapshotRow(card, data, user.id), { onConflict: 'user_id,client_id,snapshot_date' });
    if(error) console.warn('[db] price_snapshots upsert error:', error.message);
  });
}

// After a price load, bulk-write snapshots + refresh holding market_value in just
// TWO upserts (not per card). Owned items only — wishlist pseudo-cards and items
// no longer in the collection are skipped so structured rows stay aligned. Rows
// are de-duped by client_id (a single upsert can't touch the same key twice).
function flushPriceAnalytics(pairs){
  if(!Array.isArray(pairs) || !pairs.length) return;
  return dbWrite(async (db, user) => {
    const ownedIds = new Set(collection.map(c => c.id));
    const snapRows = [], holdRows = [], seen = new Set();
    for(const { card, data } of pairs){
      if(!card || !card.id || !data) continue;
      if(!ownedIds.has(card.id)) continue;   // owned holdings only
      if(seen.has(card.id)) continue;        // one row per card per flush
      seen.add(card.id);
      snapRows.push(buildSnapshotRow(card, data, user.id));
      holdRows.push(buildHoldingRow(card, user.id));
    }
    if(snapRows.length){
      const { error } = await db.from('price_snapshots').upsert(snapRows, { onConflict: 'user_id,client_id,snapshot_date' });
      if(error) console.warn('[db] price_snapshots bulk upsert error:', error.message);
    }
    if(holdRows.length){
      const { error } = await db.from('holdings').upsert(holdRows, { onConflict: 'user_id,client_id' });
      if(error) console.warn('[db] holdings bulk price refresh error:', error.message);
    }
  });
}

// Upsert one account-level portfolio snapshot per day (unique user_id+date).
// Reads the app's own freshly-computed AppState totals, so the row matches the
// on-screen numbers exactly — no parallel recomputation. Same-day updates
// overwrite that day's row. client_id stays null here (account-level).
function savePortfolioSnapshot(){
  return dbWrite(async (db, user) => {
    if (AppState._dirty) AppState.update();
    const n = v => (v != null && isFinite(v)) ? v : null;
    const cnt = v => Number.isFinite(v) ? v : null;
    const row = {
      user_id:        user.id,
      snapshot_date:  new Date().toISOString().slice(0,10),   // YYYY-MM-DD (UTC)
      total_value:    n(AppState.totalValue),
      total_cost:     n(AppState.totalCost),
      total_pnl:      n(AppState.totalPnL),
      total_pnl_pct:  n(AppState.totalPnLPct),
      cash_position:  n(AppState.cashPosition),
      singles_count:  cnt(AppState.singlesCount),
      slabs_count:    cnt(AppState.slabsCount),
      sealed_count:   cnt(AppState.sealedCount),
      holdings_count: collection.length + sealed.length,      // all owned line items
      updated_at:     new Date().toISOString()
    };
    const { error } = await db.from('portfolio_snapshots').upsert(row, { onConflict: 'user_id,snapshot_date' });
    if(error) console.warn('[db] portfolio_snapshots upsert error:', error.message);
  });
}

// Append-only event log — one immutable INSERT per add / edit / sell event.
// All numerics are guarded: a bad/empty value becomes null, never NaN.
function saveTransactionToDatabase(txn){
  if(!txn || !txn.txn_type) return;
  return dbWrite(async (db, user) => {
    const qty = parseInt(txn.quantity, 10);
    const up  = parseFloat(txn.unit_price);
    const cb  = parseFloat(txn.cost_basis);
    const rp  = parseFloat(txn.realized_pnl);
    const ta  = (txn.total_amount != null) ? parseFloat(txn.total_amount)
                  : (Number.isFinite(up) && Number.isFinite(qty) ? up * qty : NaN);
    const row = {
      user_id:      user.id,
      client_id:    txn.client_id || null,
      txn_type:     txn.txn_type,
      card_name:    txn.card_name || null,
      quantity:     Number.isFinite(qty) ? qty : null,
      unit_price:   Number.isFinite(up) ? up : null,
      total_amount: Number.isFinite(ta) ? ta : null,
      cost_basis:   Number.isFinite(cb) ? cb : null,
      realized_pnl: Number.isFinite(rp) ? rp : null,
      source:       txn.source || null,
      notes:        txn.notes || null,
      occurred_at:  txn.occurred_at ? new Date(txn.occurred_at).toISOString() : new Date().toISOString()
    };
    const { error } = await db.from('transactions').insert(row);
    if(error) console.warn('[db] transactions insert error:', error.message);
  });
}
