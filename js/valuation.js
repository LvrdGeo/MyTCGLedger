/* ════════════════════════════════════════════════════════════════════════════
   MyTCG Ledger V6 — valuation.js
   ────────────────────────────────────────────────────────────────────────────
   LAYER 2 (VALUATION). Depends on core.js only.

   THE BOUNDARY:
     valuation = math / interpretation / canonical value retrieval
     pricing   = network acquisition (fetchLivePrices, fetchEbaySold, loaders)
   Nothing in this file performs I/O. No Worker call, no fetch, no Supabase, no
   IndexedDB, no renderer, no AppState, no DOM — verified by the dependency scan.

   OUTBOUND DEPENDENCIES:
     · core.js  — readJSON / writeJSON / STORAGE_KEYS  (NRV settings only)
     · two app-state globals read AT CALL TIME, never at load time:
         `pcache`   read by cardPriceEntry/cardPriceData
         `SOURCES`  read by bestPrice/worstPrice/findConsensus
       Both are declared in the main inline block, which loads AFTER this file.
       That is safe because no function here runs during load — see LOAD-TIME
       EXECUTION below. When state.js/pricing.js are extracted these become
       ordinary cross-file globals.

   LOAD-TIME EXECUTION — exactly two statements run when this file loads:
     1. the WOTC set-name lookup, derived from the set table declared above it
     2. the NRV settings initialiser, which needs only core's readJSON
   Both depend solely on this file and core.js, so this script is safe to load
   immediately after core.js and before everything else.

   FINANCIAL INVARIANT: this file decides what a held item is WORTH. The pricing
   methodology below (raw TCGPlayer-led, graded sold-median, ask trimmed-median,
   consensus/outlier rules) is contract — do not alter it without a parity run.
   ════════════════════════════════════════════════════════════════════════════ */


// ════════════════════════════════════════════════════════════════════════════
// ── SEALED VALUE RESOLUTION ──
// ════════════════════════════════════════════════════════════════════════════
// ── Sealed pricing foundation (Phase 1): manual `value` is the override; `marketValue`
// is stored SEPARATELY (populated by the Phase 2 agent — not fetched yet). This resolver
// chooses which the portfolio uses, defaulting to manual so existing totals are unchanged.
function sealedValueSource(item){
  if(!item) return 'manual';
  const manual=parseFloat(item.value||0), market=parseFloat(item.marketValue||0);
  return item.valueSource || (manual>0 ? 'manual' : (market>0 ? 'market' : 'manual'));
}
function sealedEffectiveValue(item){
  if(!item) return 0;
  const manual=parseFloat(item.value||0), market=parseFloat(item.marketValue||0);
  const src=sealedValueSource(item);
  if(src==='market' && market>0) return market;
  if(src==='manual' && manual>0) return manual;
  return manual>0 ? manual : (market>0 ? market : 0);   // safe fallback
}

// ════════════════════════════════════════════════════════════════════════════
// ── NET REALIZABLE VALUE (NRV) ──
// ════════════════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════════════════
// ── NET REALIZABLE VALUE (NRV) · v1 · separate calc layer (2026-06) ──
// Derives the honest "what you'd actually pocket" number from EXISTING market
// values. ADDITIVE & SEPARATE: reads market value, never modifies pricing,
// market value, AppState, sync, export/import, sealed pricing, or provenance.
// Device-local settings (not synced). Rollback: delete this block, its three
// display hooks, and the STORAGE_KEYS.nrv registry entry.
// ════════════════════════════════════════════════════════════════════════════
const NRV_DEFAULTS = {
  enabled:         true,
  shown:           true,          // portfolio Realizable line visible (toggle)
  feePct:          0.136,         // eBay trading-card final-value fee (non-store), editable
  feeFixedSmall:   0.30,          // per-order fee, order <= $10
  feeFixedLarge:   0.40,          // per-order fee, order  > $10
  discount:        0.05,          // single expected-sale discount: liquidity/negotiation haircut only (fees+shipping already deducted separately)
  shipping:        { standard: 1.50, graded: 6.00, sealed: 18.00 },
  shippingDefault: 4.00,
  taxEnabled:      false,
  taxPct:          0.28,          // applied to GAIN only, when enabled
};

function loadNrvSettings(){
  const s = readJSON(STORAGE_KEYS.nrv, {});
  const m = Object.assign({}, NRV_DEFAULTS, s || {});
  m.shipping = Object.assign({}, NRV_DEFAULTS.shipping, (s && s.shipping) || {});
  return m;
}
function saveNrvSettings(){ return writeJSON(STORAGE_KEYS.nrv, NRV); }

let NRV = loadNrvSettings();

// Per-unit realizable value + breakdown. Pure (reads NRV settings only). Returns
// realizable=null when there is no market value, so callers render '—'.
function nrvForCard(card, market){
  const m = parseFloat(market);
  if (!(m > 0)) return { realizable: null, breakdown: null, sellable: false };
  const disc     = Math.min(Math.max(NRV.discount || 0, 0), 0.95);
  const gross    = m * (1 - disc);
  const feePct   = (NRV.feePct != null ? NRV.feePct : 0.136);
  const feeFixed = gross > 10 ? NRV.feeFixedLarge : NRV.feeFixedSmall;
  const fees     = gross * feePct + feeFixed;
  const type     = card.type === 'graded' ? 'graded' : card.type === 'sealed' ? 'sealed' : 'standard';
  const shipping = (NRV.shipping && NRV.shipping[type] != null) ? NRV.shipping[type] : NRV.shippingDefault;
  let net = gross - fees - shipping;
  if (net < 0) net = 0;
  const basis = parseFloat(card.paid || 0);
  const gain  = net - basis;
  const tax   = (NRV.taxEnabled && gain > 0) ? gain * (NRV.taxPct || 0) : 0;
  const realizable = Math.max(net - tax, 0);
  return { realizable, breakdown: { market: m, disc, gross, fees, shipping, tax, net }, sellable: net > 0 };
}

// ════════════════════════════════════════════════════════════════════════════
// ── CANONICAL INVENTORY VALUE PATH (2026-08) ──
// ONE place decides what a held item is currently worth. Before this block the
// same rule was re-implemented in ~20 renderers, half of which read the live
// price cache with NO lastMarketValue fallback — so a freshly-synced device
// showed a non-zero Dashboard total and a $0 Portfolio total from the SAME
// collection. These helpers do not change how prices are CALCULATED (bestPrice /
// analyze* / the sealed engine are untouched); they only standardise retrieval.
//   cardPriceData(card)  → the cached price payload, or null   (cache read)
//   cardValue(card)      → per-unit market value, with fallback (value read)
//   cardLineValue(card)  → cardValue × qty                      (line total)
//   itemQty(item)        → sane quantity for any inventory record
// Sealed products keep their own resolver (sealedEffectiveValue) because their
// value comes from manual/market fields, not the card price cache.
// ════════════════════════════════════════════════════════════════════════════

// Canonical price-cache read. The ONLY place a card's cache entry is looked up
// for rendering, so the key format lives in exactly one function (cacheKey).
// Tolerant of malformed/legacy records — returns null rather than throwing.
function cardPriceEntry(card){
  if (!card || card.id == null) return null;
  try { return pcache[cacheKey(card)] || null; } catch(_) { return null; }
}
function cardPriceData(card){
  const e = cardPriceEntry(card);
  return (e && e.data) ? e.data : null;
}

// Quantity for any inventory record. Missing/0/NaN/negative → 1 (never drops a row).
function itemQty(item){
  const q = parseInt(item && item.qty, 10);
  return (isFinite(q) && q > 0) ? q : 1;
}

// Resolve a card's market value: live pcache wins; else the synced lastMarketValue
// baseline, so a freshly-synced device shows a non-zero total before its own refresh.
// Returns 0 (never null/NaN) so callers can sum without guarding.
function cardValue(card){
  if (!card) return 0;
  const d = cardPriceData(card);
  if (d) {
    const bp = bestPrice(d, card.type === 'graded');
    if (isFinite(bp) && bp > 0) return bp;
    // A cached entry that prices to 0 is a legitimate "no price found" — fall
    // through to the synced stamp rather than reporting a false $0.
  }
  const stamp = parseFloat(card.lastMarketValue);
  return (isFinite(stamp) && stamp > 0) ? stamp : 0;
}

// Per-line total (value × quantity). Used by every aggregate so qty handling
// can't drift between the Dashboard, Portfolio and Inventory panel.
function cardLineValue(card){ return cardValue(card) * itemQty(card); }

// ════════════════════════════════════════════════════════════════════════════
// ── CARD IDENTITY FOR PRICING — EDITION / VARIANT / CACHE KEY ──
// ════════════════════════════════════════════════════════════════════════════
const WOTC_SETS = {
  base1:{name:'Base',           shadowless:true},
  base2:{name:'Jungle'},
  base3:{name:'Fossil'},
  base5:{name:'Team Rocket'},
  gym1: {name:'Gym Heroes'},
  gym2: {name:'Gym Challenge'},
  neo1: {name:'Neo Genesis'},
  neo2: {name:'Neo Discovery'},
  neo3: {name:'Neo Revelation'},
  neo4: {name:'Neo Destiny'},
};
const WOTC_SET_NAMES = Object.fromEntries(
  Object.entries(WOTC_SETS).map(([id,v]) => [v.name.toLowerCase(), id])
);
const EDITIONS = {
  'unlimited':  {label:'Unlimited',    short:'UNL',  color:'#9ca3af',    bg:'rgba(148,163,184,.15)'},
  '1stEdition': {label:'1st Edition',  short:'1ST',  color:'var(--gold)',bg:'rgba(245,200,66,.18)'},
  'shadowless': {label:'Shadowless',   short:'SHDW', color:'#60a5fa',    bg:'rgba(79,142,247,.16)'},
};
// Resolve a card's pokemontcg.io SET id from an explicit setId,
// from its cardId ("gym2-15" → "gym2"), or by matching its set name.
function getSetId(card){
  if(card && card.setId) return card.setId;
  const cid = card && card.cardId;
  if(cid && cid.indexOf('-') > 0) return cid.slice(0, cid.lastIndexOf('-'));
  const nm = ((card && card.set) || '').toLowerCase().trim();
  return WOTC_SET_NAMES[nm] || '';
}
// Which edition options does this card support? Sealed never qualifies.
function editionEligibility(card){
  if(!card || card.type === 'sealed') return {eligible:false, shadowless:false};
  const info = WOTC_SETS[getSetId(card)];
  if(!info) return {eligible:false, shadowless:false};
  return {eligible:true, shadowless:!!info.shadowless};
}
// Normalize a card's stored edition (defaults to unlimited).
function cardEdition(card){
  const e = card && card.edition;
  return (e === '1stEdition' || e === 'shadowless') ? e : 'unlimited';
}
// THE single source of truth for price-cache keys (now edition-aware).
function cacheKey(card){ return card.id + '_' + card.cond + '_' + cardEdition(card); }
// Inline badge for holdings/detail/preview. Returns '' for plain Unlimited.
function editionBadge(card){
  const e = cardEdition(card);
  if(e === 'unlimited') return '';
  const d = EDITIONS[e];
  return `<span style="background:${d.bg};color:${d.color};font-family:var(--mono);font-size:10px;font-weight:600;padding:1px 6px;border-radius:5px;">${d.label}</span>`;
}
// eBay search qualifier for edition ('' for unlimited). Used by both the worker
// query and the clickable "View sold" link so they always match.
function editionSearchTerm(card){
  const e = cardEdition(card);
  return e === '1stEdition' ? '1st Edition' : e === 'shadowless' ? 'Shadowless' : '';
}
// Explicit foil/variant. Prefers the stored card.variant field; falls back to
// the legacy /reverse/ sniff on rarity/notes so pre-variant cards still work.
function cardVariant(card){
  if(card && card.variant) return card.variant;             // 'holo'|'reverse'|'normal'
  if(/reverse/i.test(card&&card.rarity||'')||/reverse/i.test(card&&card.notes||'')) return 'reverse';
  return '';                                                 // '' = auto/unspecified
}
function variantSearchTerm(card){
  const v = cardVariant(card);
  return v === 'reverse' ? 'reverse holo' : v === 'holo' ? 'holo' : '';
}
// Edition-aware TCGPlayer tier selection. Returns a price number or null.
function pickTcgTier(prices, card){
  if(!prices) return null;
  const ed = cardEdition(card);
  const isReverse = /reverse/i.test(card.rarity||'') || /reverse/i.test(card.notes||'');
  let order;
  if(ed === '1stEdition')      order = ['1stEditionHolofoil','1stEditionNormal','holofoil','normal'];
  else if(isReverse)           order = ['reverseHolofoil','holofoil','normal'];
  else                         order = ['holofoil','normal','reverseHolofoil','1stEditionHolofoil'];
  for(const t of order){ if(prices[t]?.market) return prices[t].market; }
  for(const t of order){ if(prices[t]?.mid)    return prices[t].mid; }
  const any = Object.values(prices)[0];
  return any?.market || any?.mid || any?.low || null;
}

// ════════════════════════════════════════════════════════════════════════════
// ── PRICE ANALYSIS MATH (pure — operates on an already-fetched payload) ──
// ════════════════════════════════════════════════════════════════════════════
// OWNERSHIP NOTE: smartPrice / bestPrice / worstPrice / analyzePrice / analyzeRaw /
// analyzeGraded / findConsensus / medianOf / askSoldEstimate are PURE functions over
// an already-fetched price payload — no network, no DOM, no globals. They belong to
// the VALUATION layer, not the pricing-I/O layer (fetchLivePrices / fetchEbaySold /
// the Worker calls). Classifying them as "pricing" is what produced the apparent
// valuation <-> pricing cycle; the real dependency runs pricing -> valuation only.
function smartPrice(p, isGraded) {
  const analysis = analyzePrice(p, isGraded);
  return analysis.price;
}

// ── Pricing reasoning: raw singles lead on TCGPlayer market; graded slabs use the
//    average of the eBay sold comps for that grade. Two distinct engines. ──

function analyzePrice(p, isGraded) {
  if (!p) return { price: 0, confidence: 'none', reason: 'No price data', sources: {} };
  return isGraded ? analyzeGraded(p) : analyzeRaw(p);
}

function analyzeRaw(p) {
  const sources = {};
  if (p.tcg  > 0) sources.tcg  = p.tcg;
  if (p.ebay > 0) sources.ebay = p.ebay;
  if (p.ppt  > 0) sources.ppt  = p.ppt;
  if (Object.keys(sources).length === 0)
    return { price: 0, confidence: 'none', reason: 'No price sources available', sources };

  // Premium vintage (1st Ed / Shadowless): the real market is eBay sold comps —
  // pokemontcg.io's TCGPlayer edition feed is thin/stale, so eBay leads here.
  if (p.premiumVintage && p.ebay > 0) {
    return { price: +p.ebay.toFixed(2), confidence: p.tcg > 0 ? 'high' : 'medium',
             reason: 'eBay sold comps (1st-Edition / Shadowless market)', sources };
  }

  // Normal raw single: TCGPlayer market IS the answer. The other sources don't move
  // the number — they only tell us how confident to be in it.
  if (p.tcg > 0) {
    const others = [p.ebay, p.ppt].filter(v => v > 0);
    const inBand = others.filter(v => v >= p.tcg / 2 && v <= p.tcg * 2);
    const conf = inBand.length ? 'high' : 'medium';
    return { price: +p.tcg.toFixed(2), confidence: conf,
             reason: inBand.length ? `TCGPlayer market — corroborated by ${inBand.length} source${inBand.length > 1 ? 's' : ''}`
                     : others.length ? 'TCGPlayer market (other sources diverged — not blended in)'
                     : 'TCGPlayer market (no cross-check available)',
             sources };
  }

  // No TCGPlayer figure → fall back to eBay sold, then PriceCharting.
  if (p.ebay > 0) return { price: +p.ebay.toFixed(2), confidence: 'medium', reason: 'No TCGPlayer price — using eBay sold', sources };
  return { price: +p.ppt.toFixed(2), confidence: 'low', reason: 'PriceCharting estimate only', sources };
}

function analyzeGraded(p) {
  const sources = {};
  if (p.psa  > 0) sources.psa  = p.psa;
  if (p.ebay > 0) sources.ebay = p.ebay;
  if (p.ppt  > 0) sources.ppt  = p.ppt;
  if (Object.keys(sources).length === 0)
    return { price: 0, confidence: 'none', reason: 'No graded sold comps found', sources };

  // Headline = the average of the eBay "{grade} Sold" page (p.psa carries that mean).
  if (p.psa > 0) {
    const n = p.ebayN || 0;
    const isAsk = p.ebaySource && p.ebaySource !== 'ebay-sold-scrape' && p.ebaySource !== 'ebay-sold-cache';   // v21: cached solds are SOLDS
    let conf = isAsk ? 'low' : (n >= 5 ? 'high' : n >= 2 ? 'medium' : 'low');
    let reason = isAsk
      ? `Estimated market value from ${n} active eBay ask${n > 1 ? 's' : ''} (trimmed median) — no recent solds found`
      : n ? `Median of ${n} eBay sold comp${n > 1 ? 's' : ''} at this grade`
          : 'eBay sold comp for this grade';
    // SANITY CHECK: a graded slab should be worth at least as much as the raw card.
    // If the graded comp is well BELOW the raw TCGPlayer price, the comps are likely
    // polluted (cheap junk matched). Flag it so the user knows to verify.
    if (p.tcg > 0 && p.psa < p.tcg * 0.9) {
      conf = 'low';
      reason = `⚠️ Graded comp ($${p.psa.toFixed(0)}) is below the raw price ($${p.tcg.toFixed(0)}) — likely a bad match. Verify on eBay sold.`;
    }
    return { price: +p.psa.toFixed(2), confidence: conf, reason, sources };
  }
  if (p.ebay > 0) return { price: +p.ebay.toFixed(2), confidence: 'low', reason: 'eBay sold', sources };
  return { price: +p.ppt.toFixed(2), confidence: 'low', reason: 'Estimate only', sources };
}

// Find the most trustworthy price when sources disagree
function findConsensus(sources) {
  const entries = Object.entries(sources); // [['tcg', 357], ['ebay', 8]]
  const vals = entries.map(e => e[1]);

  // If we have 3+ sources, drop the single biggest outlier and use median of rest
  if (entries.length >= 3) {
    const med = medianOf(vals);
    // Which source is furthest from the median? That's the outlier.
    let outlierKey = null, maxDist = 0;
    for (const [k, v] of entries) {
      const dist = Math.abs(v - med) / med;
      if (dist > maxDist) { maxDist = dist; outlierKey = k; }
    }
    const trimmed = entries.filter(([k]) => k !== outlierKey).map(([,v]) => v);
    return {
      price: medianOf(trimmed),
      basis: 'consensus of remaining sources',
      label: 'most reliable',
      outlier: outlierKey
    };
  }

  // Only 2 sources that disagree — trust eBay (real sold market) over TCGPlayer (can mismatch)
  // because eBay sold is actual transactions; a wrong TCGPlayer match is the usual culprit.
  if (sources.ebay && sources.ebay > 0) {
    const outlier = sources.tcg && Math.abs(sources.tcg - sources.ebay)/sources.ebay > 1.5 ? 'tcg' : null;
    return { price: sources.ebay, basis: 'eBay sold data', label: 'actual sales', outlier };
  }
  // No eBay — fall back to the lower value (overpriced listings are common; wrong-match highs too)
  const lo = Math.min(...vals);
  return { price: lo, basis: 'lower estimate', label: 'conservative', outlier: null };
}

// Estimate realistic SOLD value from active ASKING prices (2026-07). Sellers list
// above what cards actually sell for, and the single lowest ask is unreliable —
// a lowball/damaged listing drags it under real value. Trimmed median of asks;
// the outlier trim stays, the 0.90 haircut does NOT (see note below),
// calibrated on real sold-vs-ask pairs (Umbreon VMAX #215 PSA10: asks median
// ~$5.1k, real solds $4,350–$5,000 → factor ≈0.87–0.92). Expects ASC-sorted prices.
// ── COST BASIS RESOLUTION (2026-08) ─────────────────────────────────────────
// A card's basis is what you PAID if you recorded it, otherwise what it was
// WORTH the day you added it (stamped once by stampLastValue). This lets a card
// added without a purchase price still show meaningful performance, measured
// from its add date rather than from zero.
//
// Returns { basis, source, at }:
//   source 'paid'     — you entered a real purchase price
//   source 'baseline' — no paid value; measuring since the card was added
//   source 'none'     — neither available (pre-existing card not yet re-priced)
// basis is null for 'none' so callers can keep showing a dash rather than
// inventing a 0 and reporting the whole market value as profit.
function costBasis(card){
  if (!card) return { basis: null, source: 'none', at: null };
  const paid = parseFloat(card.paid);
  if (paid > 0) return { basis: paid, source: 'paid', at: card.added || null };
  const base = parseFloat(card.baselineValue);
  if (base > 0) return { basis: base, source: 'baseline', at: card.baselineAt || card.added || null };
  return { basis: null, source: 'none', at: null };
}

function askSoldEstimate(sortedAsks){
  if (!sortedAsks || !sortedAsks.length) return null;
  const arr = sortedAsks.length >= 6 ? sortedAsks.slice(1, -1) : sortedAsks;
  const med = medianOf(arr);
  return med > 0 ? +med.toFixed(2) : null;
}

function medianOf(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a,b)=>a-b);
  const mid = Math.floor(s.length/2);
  return s.length % 2 ? s[mid] : (s[mid-1]+s[mid])/2;
}

// Keep bestPrice as a thin wrapper so all existing call sites still work
function bestPrice(p, isGraded) {
  return smartPrice(p, isGraded);
}
function worstPrice(p){const v=SOURCES.map(s=>p[s.k]).filter(v=>v!=null&&v>0);return v.length?Math.max(...v):0;}
// v15: eBay comps can be real SOLDS or active ASKS (scrape-failed fallback).
// Every UI surface that names the eBay source routes through this so asks
// are never presented as sold data.
function ebaySrcLabel(p){
  const src = p && p.ebaySource;
  const isSold = src === 'ebay-sold-scrape' || src === 'ebay-sold-cache';   // v21
  const ask = !!(src && !isSold);
  if (src === 'ebay-sold-cache') {
    const age = p.soldCachedAt ? Math.max(1, Math.round((Date.now()-p.soldCachedAt)/86400000)) : null;
    return {label:'eBay Sold', sub:'Recent sold listings'+(age?` \u00b7 cached ${age}d ago`:' \u00b7 cached'), ask:false};
  }
  return ask ? {label:'eBay Asks', sub:'Active asking prices \u2014 no recent solds', ask:true}
             : {label:'eBay Sold', sub:'Recent sold listings', ask:false};
}

// Legacy alias retained for existing call sites.
function getBestCached(card){return cardValue(card);}
