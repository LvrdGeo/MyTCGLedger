/* ════════════════════════════════════════════════════════════════════════════
   MyTCG Ledger V6 - universal-valuation.js
   ────────────────────────────────────────────────────────────────────────────
   THE UNIVERSAL VALUATION ENGINE. Deferred since Batch 2 under one rule - "move
   it only when it can move as a complete unit". It now can: the engine core, the
   Phase-2 routing flags and the Sealed Pricing Agent are one contiguous section.

   *** THIS ENGINE IS DORMANT BY DESIGN AND MUST STAY THAT WAY. ***
   FLAGS = { singlesEngine:false, gradedEngine:false, sealedEngine:false }
   Verified: NOTHING anywhere in the project writes to FLAGS - no Settings UI, no
   persistence, no boot code. With the flags off, analyzePriceRouted() is a
   transparent pass-through to the legacy analyzeRaw/analyzeGraded, and
   fetchSealedValuation() returns an empty valuation without touching the network.
   Extraction must not make the engine one byte more active than it is today.

   OWNS - Phase 1 core:
     ValuationPorts (inert DI seam), makePriceQuery, CONFIDENCE_LEVELS,
     confidenceFrom, makeValuation, CategoryProfiles, registerCategoryProfile,
     ValuationEngine
   OWNS - Phase 2 routing:
     FLAGS, analyzePriceRouted
   OWNS - Sealed Pricing Agent (the engine's 'sealed' CategoryProfile):
     SEALED_REASON_CODES, SEALED_TYPE_PHRASES, buildSealedQuery,
     makeSealedValuation, fetchSealedValuation, and the single load-time
     registerCategoryProfile({id:'sealed'}) call.

   DOES NOT OWN: the pricing algorithms themselves. Every profile DELEGATES to
   valuation.js (analyzeRaw / analyzeGraded / findConsensus), which remains
   authoritative. It owns no eBay/Worker acquisition (pricing.js), no sealed
   Worker pricing or sealed CRUD (sealed.js), no cardValue / cardLineValue /
   sealedEffectiveValue, no portfolio or dashboard math, no NRV, no Evidence
   Explorer, no cache, no storage, no UI.

   DORMANT NETWORK NOTE: fetchSealedValuation() contains a Worker call, but it is
   the FIRST thing gated by `if(!FLAGS.sealedEngine ...) return` and it has ZERO
   callers project-wide. This transport was always part of this engine block; it
   was not relocated here from pricing or sealed.

   LIVE CONSUMER: sealed.js's loadSealedPrices() calls buildSealedQuery() at call
   time. That single edge is the only part of this file the running app uses, and
   Batches 8 and 9 both deliberately left the function here. Ownership unchanged.

   CONSUMERS (all CALL-time, no cycles): analytics.js, pricing.js, card-detail.js
   and the inline calculateMarketSignal call analyzePriceRouted; sealed.js calls
   buildSealedQuery. This file calls back into NONE of them.

   LOAD ORDER: placed immediately after valuation.js - the earliest safe point.
   Its only outbound dependency (valuation's analyze*) resolves at call time, and
   its one load-time statement needs only registerCategoryProfile/CategoryProfiles
   declared directly above it in this same file.

   LOAD-TIME EXECUTION: exactly one statement - registerCategoryProfile({id:
   'sealed'}), which mutates only this file's own CategoryProfiles registry. No
   pricing run, no fetch, no cache write, no DOM, no persistence.
   ════════════════════════════════════════════════════════════════════════════ */

/* ═══════════════════════════════════════════════════════════════════════════
   UNIVERSAL VALUATION ENGINE — Phase 1 (pure core, additive seam)
   ---------------------------------------------------------------------------
   DORMANT BY DESIGN: no existing call site is rerouted through this engine yet.
   It exists so future phases (Sealed, adapters, scheduler, intelligence) can
   plug in. Its profiles DELEGATE to the existing analyzePrice/analyzeRaw/
   analyzeGraded/findConsensus — they do NOT reimplement any pricing logic, so
   anything routed through the engine is byte-identical to today's output.
   Phase 1 touches NO cache / history / scheduler / network / UI / storage.
   ═══════════════════════════════════════════════════════════════════════════ */

// Dependency-injection seam (ports). Phase 1 uses NONE of these in value();
// the value path is pure delegation. Defaults are inert no-ops — future phases
// will inject real implementations (cache=pcache, history=cardHistory, etc.).
const ValuationPorts = {
  cache:   { get(){ return null; }, set(){}, del(){} },   // CachePort   (future: IndexedDB pcache)
  source:  { fetch(){ return null; } },                   // SourcePort  (future: eBay/TCG adapters)
  history: { read(){ return []; }, append(){} },          // HistoryPort (future: cardHistory series)
  clock:   { now(){ return Date.now(); } },               // ClockPort
};

// SourceAdapter interface (CONTRACT ONLY — no implementations in Phase 1):
//   { name, capabilities:[category…], buildQuery(profile,identity), fetch(query), normalize(raw)->Comp[] }

// PriceQuery model — the category-agnostic request the engine answers.
function makePriceQuery(category, identity, priceData, opts){
  return { category: category||null, identity: identity||null, priceData: priceData||null, opts: opts||{} };
}

// Confidence model — Phase 1 passes the existing analyze confidence through verbatim.
const CONFIDENCE_LEVELS = ['none','low','medium','high'];
function confidenceFrom(analysis){
  return { level: (analysis && analysis.confidence) || 'none',
           score: null,                              // numeric score is a later phase
           reason: (analysis && analysis.reason) || '' };
}

// Valuation Intelligence model — Phase 1 fills ONLY what the existing pipeline
// already produces. trend/volatility/liquidity/signal/fairValue are explicit
// nulls (NOT computed here — those are later phases).
function makeValuation(analysis){
  return {
    value:      (analysis && analysis.price) || 0,
    currency:   'USD',
    asOf:       null,
    confidence: confidenceFrom(analysis),
    sources:    (analysis && analysis.sources)
                  ? Object.keys(analysis.sources).map(k => ({ source: k, price: analysis.sources[k] }))
                  : [],
    comps:      null,
    trend:      null,
    volatility: null,
    liquidity:  null,
    signal:     null,
    fairValue:  null,
  };
}

// Aggregation interface — Phase 1 delegates to the existing findConsensus/analyze
// via the profiles below; no new aggregation math is introduced.

// CategoryProfile registry — each profile maps a PriceQuery to an analysis by
// DELEGATING to the existing functions. Adding a category later = registering a
// profile; the engine core does not change.
const CategoryProfiles = {
  singles: { id:'singles', analyze(q){ return analyzePrice(q.priceData, false); } },  // → analyzeRaw
  graded:  { id:'graded',  analyze(q){ return analyzePrice(q.priceData, true);  } },  // → analyzeGraded
};
function registerCategoryProfile(profile){ if(profile && profile.id) CategoryProfiles[profile.id] = profile; return profile; }

// ValuationEngine — the single brain. PURE: given the same priceData it returns
// the same Valuation, because it calls the same analyze* the app calls today.
const ValuationEngine = {
  ports: ValuationPorts,
  profileFor(category){ return CategoryProfiles[category] || null; },
  value(query){
    const profile = this.profileFor(query && query.category);
    if(!profile) return makeValuation(null);
    return makeValuation(profile.analyze(query));   // delegates to existing analyzePrice
  },
};
/* ═══════════════ end Universal Valuation Engine (Phase 1) ═══════════════ */

/* ─── Phase 2: feature-flagged Singles routing through the ValuationEngine ───
   Flag defaults OFF → analyzePriceRouted is a transparent pass-through to
   analyzePrice (zero behavior change). When ON, SINGLES (non-graded) route
   through ValuationEngine.value — which itself delegates to analyzePrice, so the
   result is byte-identical. Graded is ALWAYS direct (PSA path untouched). Any
   engine error falls back to analyzePrice. No new pricing logic, cache, or UI. */
const FLAGS = { singlesEngine: false, gradedEngine: false, sealedEngine: false };   // default OFF
function analyzePriceRouted(p, isGraded){
  if(FLAGS.singlesEngine && !isGraded){
    try {
      const v = ValuationEngine.value(makePriceQuery('singles', null, p));
      const sources = {};
      (v.sources||[]).forEach(s => { sources[s.source] = s.price; });
      return { price: v.value, confidence: v.confidence.level, reason: v.confidence.reason, sources };
    } catch(e){ return analyzePrice(p, isGraded); }   // safety net → current behavior
  }
  if(FLAGS.gradedEngine && isGraded){
    try {
      const v = ValuationEngine.value(makePriceQuery('graded', null, p));
      const sources = {};
      (v.sources||[]).forEach(s => { sources[s.source] = s.price; });
      return { price: v.value, confidence: v.confidence.level, reason: v.confidence.reason, sources };
    } catch(e){ return analyzePrice(p, isGraded); }   // safety net → current behavior
  }
  return analyzePrice(p, isGraded);                    // graded, or flag OFF → unchanged
}

/* ════════════════════════════════════════════════════════════════════════════
   SEALED PRICING AGENT — Phase 1 (additive · DORMANT behind FLAGS.sealedEngine)
   ----------------------------------------------------------------------------
   Vertical slice: immutable Valuation record + sealed CategoryProfile + query
   builder + evidence-ledger mapper + dormant client agent. NO confidence/integrity
   scoring, NO portfolio wiring, NO UI — those are Phase 2. Nothing here is called
   by any existing render/pricing path, so current behavior is unchanged.
   Heavy lifting (eBay fetch, normalize, reject, ledger, median) lives in the
   Worker /sealed endpoint; the client maps its response into ONE frozen record.
   ════════════════════════════════════════════════════════════════════════════ */

// Rejection reason codes — shared contract with the Worker. Every rejected comp
// in the Evidence Ledger carries exactly one of these.
const SEALED_REASON_CODES = Object.freeze({
  SINGLE:    'single_card',
  LOT:       'lot_or_bundle_of_singles',
  BREAK:     'break_or_live_break',
  EMPTY_BOX: 'empty_box',
  OPENED:    'opened_or_used',
  CODE_CARD: 'code_card_only',
  DAMAGED:   'damaged',
  ACCESSORY: 'accessory',
  UNRELATED: 'unrelated_product',
  OUTLIER:   'price_outlier',
  WRONG_SET: 'set_name_missing',
});

// Query Intelligence (Phase 1 subset): product-type → canonical eBay phrase.
const SEALED_TYPE_PHRASES = Object.freeze({
  booster_box:'booster box', etb:'elite trainer box', booster_bundle:'booster bundle',
  collection_box:'collection box', tin:'tin', premium_collection:'premium collection',
  upc:'ultra premium collection', special_collection:'special collection',
  build_battle:'build & battle', blister:'blister pack', booster_pack:'booster pack',
});
function buildSealedQuery(item){
  if(!item) return '';
  const phrase = SEALED_TYPE_PHRASES[item.type] || '';
  const parts = [item.name, item.set, phrase, 'factory sealed'].filter(Boolean);
  if(item.lang && item.lang!=='EN') parts.push(String(item.lang).toLowerCase());
  return parts.join(' ').replace(/\s+/g,' ').trim();
}

// Immutable Valuation record — Phase 1 shape: value + full evidence ledger only.
// (confidence / integrity / aggregation detail / fairValue are intentionally absent.)
function makeSealedValuation(resp, item){
  const accepted = Array.isArray(resp && resp.acceptedComps) ? resp.acceptedComps : [];
  const rejected = Array.isArray(resp && resp.rejectedComps) ? resp.rejectedComps : [];
  const codes    = Array.isArray(resp && resp.reasonCodes)   ? resp.reasonCodes   : [];
  return Object.freeze({
    category:      'sealed',
    itemId:        item ? item.id : null,
    marketValue:   (resp && typeof resp.marketValue === 'number') ? resp.marketValue : null,
    source:        (resp && resp.source) || 'ebay-sold',
    lastPricedAt:  (resp && resp.lastPricedAt) || null,
    acceptedComps: Object.freeze(accepted.map(c => Object.freeze({ ...c }))),  // evidence ledger
    rejectedComps: Object.freeze(rejected.map(c => Object.freeze({ ...c }))),  // each carries .reason
    reasonCodes:   Object.freeze([ ...codes ]),
    compCount:     accepted.length,
  });
}

// Client adapter → calls Worker /sealed, returns ONE deterministic frozen record.
// DORMANT: runs only when FLAGS.sealedEngine is ON (default OFF). On any failure
// or missing endpoint, returns a null-value record (caller would stay on manual).
async function fetchSealedValuation(item){
  if(!FLAGS.sealedEngine || !item) return makeSealedValuation(null, item);
  try {
    const q   = buildSealedQuery(item);
    const url = `${EBAY_WORKER}/sealed?q=${encodeURIComponent(q)}&type=${encodeURIComponent(item.type||'')}&lang=${encodeURIComponent(item.lang||'EN')}&limit=20`;
    const r = await fetch(url);
    if(!r.ok) return makeSealedValuation(null, item);
    return makeSealedValuation(await r.json(), item);
  } catch(e){ return makeSealedValuation(null, item); }
}

// Register the sealed CategoryProfile (additive; singles/graded untouched). Maps an
// already-fetched Worker response (q.priceData) → the engine's analysis shape, so
// sealed can flow through ValuationEngine.value(makePriceQuery('sealed', item, resp)).
registerCategoryProfile({
  id: 'sealed',
  analyze(q){
    const resp = q && q.priceData;
    const mv = (resp && typeof resp.marketValue === 'number') ? resp.marketValue : 0;
    return { price: mv || 0, confidence: 'none', reason: '', sources: mv > 0 ? { ebay: mv } : {} };
  },
});
/* ═══════════════ end Sealed Pricing Agent — Phase 1 ═══════════════ */
