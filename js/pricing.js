/* ════════════════════════════════════════════════════════════════════════════
   MyTCG Ledger V6 - pricing.js
   ────────────────────────────────────────────────────────────────────────────
   LAYER 8 (PRICING). Market-data ACQUISITION and live-price orchestration.

   The boundary this file holds:
     pricing   asks "what is this collectible currently worth?"  <- here
     valuation asks "how does that affect this portfolio?"       <- valuation.js

   OWNS:
     - price stamping     _stampSaveTimer, stampLastValue
     - per-card entry     getPrices, getPricesShared, _priceInflightShared
     - Worker calls       fetchEbaySold      -> /graded, /sold
                          testEbayWorker     -> /health
                          fetchPokePrice     -> /pokeprice
                          fetchLivePrices    -> orchestrates the above + TCGPlayer
                          fetchLivePricesFromData, lookupCardId
     - bulk orchestration buildPriceStrip, loadPricesForCards, _priceInflight,
                          getAllPriceableItems, loadAllPrices, _loadingPrices

   DOES NOT OWN: the pure price MATH (analyzeRaw / analyzeGraded / bestPrice /
   medianOf / askSoldEstimate live in valuation.js), the Universal Valuation
   Engine, NRV, portfolio history, identity, the deletion ledger, Supabase sync,
   IndexedDB primitives, or any page renderer.

   DOCUMENTED UI COUPLING (pre-existing, deliberately NOT refactored in this
   extraction): loadPricesForCards patches the per-card `#ps-<id>` strips, and
   loadAllPrices drives `#port-loading` / `#port-updated` and then calls the page
   renderers plus captureHistorySnapshot() and calculateMarketSignal(). All of it
   happens at CALL time against globals declared later in the inline block.

   OUTBOUND DEPENDENCIES (all call-time; nothing runs at load):
     - core       STORAGE_KEYS  (no toast/UI helper is called from this file)
     - valuation  cacheKey, cardEdition, editionSearchTerm, cardVariant,
                  pickTcgTier, analyzeRaw/analyzeGraded via analyzePriceRouted,
                  bestPrice
     - storage    idbPut, recordCardPrice, idbColSave, captureHistorySnapshot
     - analytics  flushPriceAnalytics
     - inline     keys, collection, pcache, wishlist, sealed, the UVE
                  (analyzePriceRouted / FLAGS), the page renderers, and
                  calculateMarketSignal

   LOAD-TIME EXECUTION: three declarations only - _stampSaveTimer,
   _priceInflightShared, _priceInflight, _loadingPrices. No fetch, no cache
   write, no repricing, no render occurs from loading this file.
   ════════════════════════════════════════════════════════════════════════════ */

// Price-cache freshness window. Moved here from index.html in Batch 8: pricing
// is its only consumer. Value unchanged.
// ── POST-PRICING HOOK (Batch 31 — dependency inversion) ────────────────────
// pricing.js used to name six UI/domain modules directly (renderPortfolio,
// renderPSA, renderSingles, renderWishlist, renderAnalyzer, renderDashboard)
// plus captureHistorySnapshot and calculateMarketSignal. That made the pricing
// layer responsible for knowing which parts of the application must react to a
// price change.
//
// It now announces completion instead. The application shell registers a single
// handler at boot (see app.js -> onPricingPhase) and owns every downstream
// decision. Pricing has ZERO outbound references to UI or domain modules.
//
// Two phases, because the original tail was genuinely two-phase: renders fired
// BEFORE pricing's own progress-chrome/analytics/in-flight-flag statements, and
// history+signals fired AFTER them. Preserving that ordering exactly is the
// whole point, so the split is faithful to the old code, not a redesign.
//
//   'render'  — prices are in state; refresh the views for this scope
//   'settled' — the pricing run is finished; do follow-up work
//
// scope is 'all' (loadAllPrices) or 'cards' (loadPricesForCards).
let _onPricingPhase = null;
function setPricingPhaseHandler(fn){ _onPricingPhase = fn; }
function _pricingPhase(phase, ctx){
  // Guarded: if no handler is registered the pricing path still completes and
  // returns normally, exactly as it would if a renderer were absent.
  if (typeof _onPricingPhase === 'function') _onPricingPhase(phase, ctx);
}

const CACHE_TTL = 60*60*1000;

// ═══ PRICING ═══
// Stamp a device-independent "last known value" onto the OWNED collection record
// so a freshly-synced device shows the same value before its own fetch completes.
// Never touches pcache or the pricing engine; just persists a fallback number.
let _stampSaveTimer = null;
function stampLastValue(card, data){
  try {
    if (!card || !card.id) return;
    const rec = collection.find(c => c.id === card.id);   // only owned cards
    if (!rec) return;                                      // ignore wishlist/pseudo cards
    const a = analyzePriceRouted(data, card.type==='graded');
    if (!a || !(a.price > 0)) return;
    rec.lastMarketValue     = +a.price.toFixed(2);
    rec.lastPricedAt        = Date.now();
    rec.lastPriceConfidence = a.confidence || 'medium';
    rec.lastPriceSource     = a.sources ? Object.keys(a.sources).join('+') : '';
    // Debounced save so a batch refresh doesn't spam sync.
    clearTimeout(_stampSaveTimer);
    _stampSaveTimer = setTimeout(() => { save(); }, 1200);
  } catch(e) { /* non-critical */ }
}

async function getPrices(card){
  const ck=cacheKey(card);const hit=pcache[ck];
  if(hit&&(Date.now()-hit.ts)<CACHE_TTL){
    recordCardPrice(card, bestPrice(hit.data, card.type==='graded')); saveCardHistory();
    stampLastValue(card, hit.data);
    return hit.data;
  }
  const data=await fetchLivePrices(card);
  pcache[ck]={ts:Date.now(),data};idbPut(ck,pcache[ck]);
  recordCardPrice(card, bestPrice(data, card.type==='graded')); saveCardHistory();
  stampLastValue(card, data);
  return data;
}

// Shared in-flight choke point — both loaders use this so the same card key
// is never fetched twice at once (fixes mobile slowdown on Refresh).
async function getPricesShared(card){
  const ck = cacheKey(card);
  const hit = pcache[ck];
  if (hit && (Date.now()-hit.ts) < CACHE_TTL) return hit.data;
  if (_priceInflightShared[ck]) return await _priceInflightShared[ck];
  const req = getPrices(card);
  _priceInflightShared[ck] = req;
  try { return await req; }
  finally { delete _priceInflightShared[ck]; }
}
const _priceInflightShared = {};
async function fetchEbaySold(card) {
  try {
    let endpoint;
    if (card.type === 'graded' && card.grade) {
      // Edition matters enormously for vintage slabs (1st-Ed PSA 10 ≫ Unlimited PSA 10),
      // so fold it into the search name AND pass it explicitly to the worker.
      const edTerm = editionSearchTerm(card);
      const varTerm = variantSearchTerm(card);
      const jpTerm = card.lang === 'JP' ? 'Japanese' : '';   // JP cards: comp against Japanese listings
      const gradedName = [card.name, edTerm, varTerm, jpTerm].filter(Boolean).join(' ');
      endpoint = `${EBAY_WORKER}/graded?name=${encodeURIComponent(gradedName)}&number=${encodeURIComponent(card.num||'')}&set=${encodeURIComponent(card.set||'')}&grade=${encodeURIComponent(card.grade||'')}&rarity=${encodeURIComponent(card.rarity||'')}&edition=${encodeURIComponent(edTerm)}&variant=${encodeURIComponent(cardVariant(card))}`;
      console.log('[eBay] Graded query:', gradedName, card.grade, 'set:', card.set, 'num:', card.num, 'ed:', edTerm || 'unlimited');
    } else {
      // Build a precise, contextual query using everything we know about the card
      const numClean = (card.num || '').split('/')[0]; // strip "/94" from "125/94"
      const rarity   = (card.rarity || card.type || '').toLowerCase();
      const setName  = (card.set || '');

      // Detect card characteristics — explicit variant selector wins over rarity sniff.
      const _v         = cardVariant(card);
      const isReverse  = _v ? _v === 'reverse' : rarity.includes('reverse');
      const isVintage  = /base set|jungle|fossil|team rocket|gym heroes|gym challenge|neo genesis|neo discovery|neo destiny|neo revelation|e-card|skyridge|aquapolis|expedition|wizards|wotc|legend/i.test(setName);
      const is1st       = card.edition === '1stEdition' || (card.notes && /1st|first edition/i.test(card.notes));
      const isShadowless= card.edition === 'shadowless' || (card.notes && /shadowless/i.test(card.notes));
      const isHolo     = _v ? _v === 'holo' : (rarity.includes('holo') && !isReverse);

      // Detect premium cards by BOTH rarity field AND card number
      // Cards numbered above their set total (e.g. 125/094) are always secret/special
      const numVal     = parseInt(numClean) || 0;
      const totalVal   = parseInt((card.num||'').split('/')[1]) || 999;
      const isAboveTotal = numVal > totalVal; // e.g. 125 > 94

      const isAltArt      = rarity.includes('special illustration') || rarity.includes('alt art');
      const isIllustration= rarity.includes('illustration rare') && !rarity.includes('special');
      const isHyper       = rarity.includes('hyper') || rarity.includes('rainbow');
      const isFullArt     = rarity.includes('full art') || rarity.includes('ultra rare');
      const isSecret      = rarity.includes('secret') || rarity.includes('gold');

      // If card number is above set total and no rarity set, treat as Special Illustration Rare
      // (most above-total cards in modern sets are SIRs or Illustration Rares)
      const isPremium = isAltArt || isIllustration || isHyper || isFullArt || isSecret || isAboveTotal;

      // Build query parts — card name + number is the anchor
      const parts = [card.name];
      // Build clean number — strip undefined/null parts
      const numTotal = (card.num||'').split('/')[1];
      const numFormatted = numClean && numTotal && numTotal !== 'undefined'
        ? numClean + '/' + numTotal
        : numClean || '';
      if (numFormatted) parts.push(numFormatted);

      // Add rarity descriptor so eBay knows which version
      if (is1st)                parts.push('1st Edition');
      else if (isShadowless)    parts.push('Shadowless');
      if (isAltArt)             parts.push('Special Illustration Rare');
      else if (isIllustration)  parts.push('Illustration Rare');
      else if (isHyper)         parts.push('Hyper Rare');
      else if (isFullArt)       parts.push('Full Art');
      else if (isSecret)        parts.push('Secret Rare');
      else if (isReverse)       parts.push('Reverse Holo');
      else if (isHolo && isVintage) parts.push('Holo');
      else if (isAboveTotal)    parts.push('Special Illustration Rare'); // fallback for unnumbered SIRs

      // Always include the set name — critical for disambiguation
      if (setName) parts.push(setName);
      if (card.lang === 'JP') parts.push('japanese');
      parts.push('pokemon card');

      const q = parts.filter(Boolean).join(' ');
      console.log('[eBay] Raw sold query:', q);
      endpoint = `${EBAY_WORKER}/sold?q=${encodeURIComponent(q)}&limit=12`;
    }
    const r = await fetch(endpoint);
    if (!r.ok) { fetchEbaySold._fail = 'http' + r.status; return null; }
    const data = await r.json();
    if (data.error) { fetchEbaySold._fail = 'worker-error'; return null; }
    fetchEbaySold._fail = null;
    return data;
  } catch(e) { fetchEbaySold._fail = (e && e.name === 'AbortError') ? 'timeout' : 'net'; return null; }
}

async function testEbayWorker() {
  const el = document.getElementById('ebay-worker-status');
  el.textContent = 'Testing…';
  try {
    const r = await fetch(EBAY_WORKER + '/health');
    const d = await r.json();
    if (d.hasToken) {
      el.textContent = '✓ Connected — real eBay prices active';
      el.style.color = 'var(--green)';
    } else {
      el.textContent = '⚠ Worker reachable but no token';
      el.style.color = 'var(--gold)';
    }
  } catch(e) {
    el.textContent = '✗ Worker unreachable';
    el.style.color = 'var(--red)';
  }
}

// Extract TCGPlayer prices from already-fetched card data (used by verification retry)
function fetchLivePricesFromData(d, card, result) {
  const prices = d?.tcgplayer?.prices;
  if (prices) { result.tcg = pickTcgTier(prices, card); }
  result.img = result.img || d?.images?.large || d?.images?.small || null;
  // Save the corrected cardId
  const f = collection.find(x=>x.id===card.id);
  if (f && d?.id) { f.cardId = d.id; if(d.number) f.num = f.num||d.number; save(); }
  return result;
}

// PokePrice = PokemonPriceTracker aggregated market price → fills the "ppt" slot.
// Prefers the resolved pokemontcg.io id (their tcgPlayerId); else searches by name and
// matches on card number. 6s timeout, returns a positive number or null, never throws —
// so a CORS block or rate-limit just leaves the PokePrice row empty.
async function fetchPokePrice(card, tcgKey){
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  const parse = (rows) => {
    if (!rows || !rows.length) return null;
    let row = rows[0];
    if (card.num) { const want = String(card.num).split('/')[0].trim(); row = rows.find(x => String(x.cardNumber||'').trim() === want) || rows[0]; }
    const mk  = row && row.prices ? row.prices.market : null;
    const p10 = row && row.ebay && row.ebay.psa10 ? row.ebay.psa10.avg : null;
    return {
      market: (typeof mk  === 'number' && mk  > 0) ? parseFloat(mk.toFixed(2))  : null,
      psa10:  (typeof p10 === 'number' && p10 > 0) ? parseFloat(p10.toFixed(2)) : null,
    };
  };
  try {
    // Routed through the eBay worker (/pokeprice) so the PokePrice token stays
    // server-side — this removes the browser CORS block that left ppt empty.
    // One request: the worker tries tcgPlayerId first, then a name search.
    const params = [];
    if (tcgKey)    params.push('tcgPlayerId=' + encodeURIComponent(tcgKey));
    if (card.name) params.push('search=' + encodeURIComponent(card.name));
    if (!params.length) return { market:null, psa10:null, _reason:'no-id' };
    const r = await fetch(`${EBAY_WORKER}/pokeprice?${params.join('&')}&limit=8`, { signal:ctrl.signal });
    if (!r.ok) return { market:null, psa10:null, _reason:'http'+r.status };
    const j = await r.json();
    const got = parse(Array.isArray(j.data) ? j.data : []);
    if (got && (got.market || got.psa10)) return { market:got.market, psa10:got.psa10, _reason:'ok' };
    return { market:null, psa10:null, _reason:'empty' };
  } catch(e) {
    return { market:null, psa10:null, _reason:(e && e.name==='AbortError') ? 'timeout' : 'net' };
  } finally {
    clearTimeout(timer);
  }
}
async function fetchLivePrices(card){
  let result={tcg:null,ebay:null,ppt:null,psa:null,img:card.img||null,trend7:null,trend30:null,ebay_sales:[]};
  const tcgKey=card.cardId||await lookupCardId(card);
  if(tcgKey){
    try{
      const r=await ptcgFetch(`/cards/${tcgKey}`);
      if(r.ok){
        const d=(await r.json()).data;
        // ── VERIFY THE MATCH — does the resolved card's number match what we expect? ──
        const wantNum = (card.num||'').split('/')[0].trim().toLowerCase().replace(/^0+/,'');
        const gotNum  = (d?.number||'').trim().toLowerCase().replace(/^0+/,'');
        if (wantNum && gotNum && wantNum !== gotNum) {
          // Mismatch! The cardId points to the wrong card. Clear it and re-resolve.
          console.warn(`[Verify] Card number mismatch for ${card.name}: wanted #${wantNum}, got #${gotNum}. Re-resolving.`);
          const f = collection.find(x=>x.id===card.id);
          if (f) { f.cardId = ''; }
          const freshId = await lookupCardId(card);
          if (freshId && freshId !== tcgKey) {
            // Retry once with the correct ID
            const r2 = await ptcgFetch(`/cards/${freshId}`);
            if (r2.ok) {
              const d2 = (await r2.json()).data;
              if (d2) { return fetchLivePricesFromData(d2, card, result); }
            }
          }
          // Mark as unverified if we still couldn't fix it
          result.unverified = true;
        }
        const prices=d?.tcgplayer?.prices;
        if(prices){ result.tcg = pickTcgTier(prices, card); }
        // Also grab PriceCharting-style data if the API has it
        result.img=result.img||d?.images?.large||d?.images?.small||null;
        // Store the resolved card metadata
        if(d?.number && !card.num){ const f=collection.find(x=>x.id===card.id); if(f){f.num=d.number;save();} }
      }
    }catch(e){ console.error('[TCG price] failed:', e); }
  }

  // ── Real eBay sold prices via Cloudflare Worker ──
  const ebayData = await fetchEbaySold(card);
  // Debug: log the raw response so we can see what the worker returns
  if (ebayData) {
    console.log('[eBay] Response for', card.name, card.grade||card.cond, '→ query:', ebayData.query, '| stats:', JSON.stringify(ebayData.stats), '| items:', ebayData.items?.length, ebayData.items?.slice(0,3).map(i=>i.title+'='+i.price));
  }
  if (ebayData && !ebayData.error) {
    const stats = ebayData.stats;
    // Use median as the most reliable price point (removes outliers)
    // But if stats came from contaminated items, recalculate from clean items
    let pricePoint = stats?.median || stats?.avg || null;
    if (ebayData.items?.length) {
      const cleanPrices = ebayData.items
        .filter(i => (!(/factory sealed|booster pack|booster box|booster bundle|elite trainer|etb|sealed box|sealed pack|lot of|set of|bundle|collection box|tin|blister/i.test(i.title || '')) && !(/factory sealed|new.*sealed|sealed/i.test(i.condition || ''))))
        .map(i => i.price)
        .filter(p => p > 0)
        .sort((a,b) => a-b);
      result.ebayN = cleanPrices.length;
      // v15: the worker tells us whether comps are real SOLDS or active ASKING prices
      // (scrape failed → Browse-API fallback). Asks are ceilings, not market — the
      // median of asks is meaningless and badly inflates slabs (Alakazam: ask-median
      // $12.5k vs real solds $4.8-6.2k). Stamp the source so analyzeGraded can label
      // honestly, and price asks at the LOWEST ask (the tightest defensible ceiling).
      const _SOLD_SOURCES = ['ebay-sold-scrape','ebay-sold-cache'];   // v21: cached solds are SOLDS
      const _ebayIsAsk = !!(ebayData.source && !_SOLD_SOURCES.includes(ebayData.source));
      if (ebayData.cachedAt) result.soldCachedAt = ebayData.cachedAt;   // v21: age of cached comps
      result.ebaySource = ebayData.source || '';
      // v16 Worker evidence fields — display-only passthrough for the Pricing Evidence card
      if (Array.isArray(ebayData.rejected) && ebayData.rejected.length) result.rejected = ebayData.rejected.slice(0,10);
      if (ebayData.counts) result.counts = ebayData.counts;
      if (cleanPrices.length) {
        if (card.type === 'graded') {
          if (_ebayIsAsk) {
            // ASKS → SOLD ESTIMATE (2026-07 accuracy fix). The old heuristic took the
            // single LOWEST ask, which a lowball/damaged listing drags under real value
            // (Umbreon VMAX #215 PSA10: lowest ask $3,500 vs REAL solds $4,350–$5,000).
            // Sellers list above what cards sell for, so: trimmed median of asks × 0.90,
            // calibrated against real sold-vs-ask pairs. Labeled LOW confidence + ASKS.
            pricePoint = askSoldEstimate(cleanPrices);
          } else {
          // GRADED: MEDIAN of sold comps on the eBay "{grade} Sold" page.
          // Median (not average) so a few inflated/wrong-variant comps can't drag the
          // headline up — e.g. Latias&Latios #170 PSA10 real solds cluster ~$18-20k but
          // a couple high mislistings pushed the average to ~$23k. With 6+ comps we also
          // trim the lowest & highest before taking the median for extra robustness.
          const arr = cleanPrices.length >= 6 ? cleanPrices.slice(1, -1) : cleanPrices;
          pricePoint = medianOf(arr);
          }
        } else {
          // RAW: median is the robust eBay cross-check (raw headline leads on TCGPlayer).
          pricePoint = medianOf(cleanPrices);
        }
      }
    }

    if (card.type === 'graded') {
      // For graded cards, eBay data IS the PSA market price
      if (pricePoint) {
        result.psa  = pricePoint;
        result.ebay = pricePoint; // also use as eBay price
      }
    } else {
      if (pricePoint) result.ebay = pricePoint;
    }

    if (ebayData.items?.length) {
      // Filter out factory sealed / booster pack listings before displaying
      const cleanItems = ebayData.items.filter(i =>
        (!(/factory sealed|booster pack|booster box|booster bundle|elite trainer|etb|sealed box|sealed pack|lot of|set of|bundle|collection box|tin|blister/i.test(i.title || '')) && !(/factory sealed|new.*sealed|sealed/i.test(i.condition || '')))
      );
      const displayItems = cleanItems.length ? cleanItems : ebayData.items;
      result.ebay_sales = displayItems.slice(0,6).map(i => ({
        date:      i.soldDate ? new Date(i.soldDate).toLocaleDateString('en-US',{month:'short',day:'numeric'}) : 'Recent',
        price:     i.price,
        condition: i.condition || card.cond,
        url:       i.url,
        title:     i.title || '',   // retained for the Pricing Evidence card (2026-07) — display only
      }));
      // Compute trend from real sales
      if (ebayData.items.length >= 3) {
        const sorted = [...ebayData.items].sort((a,b) => new Date(b.soldDate)-new Date(a.soldDate));
        const recent = sorted.slice(0,3).map(i=>i.price);
        const older  = sorted.slice(-3).map(i=>i.price);
        const avgR = recent.reduce((a,b)=>a+b,0)/recent.length;
        const avgO = older.reduce((a,b)=>a+b,0)/older.length;
        if (avgO > 0) result.trend7 = parseFloat(((avgR-avgO)/avgO*100).toFixed(1));
      }
    }
  }

  // Anchor: premium vintage editions (1st Ed / Shadowless) get their real value from
  // eBay SOLD comps — pokemontcg.io's TCGPlayer edition feed is thin/stale. So we
  // anchor to eBay and, crucially, do NOT fabricate PriceCharting/eBay figures from a
  // thin TCG number: a fake low source would cluster with TCG and make the consensus
  // engine discard the true (higher) 1st-edition sale as an "outlier".
  const _ed = cardEdition(card);
  const _premiumVintage = (_ed === '1stEdition' || _ed === 'shadowless');
  result.premiumVintage = _premiumVintage;
  // Provenance (Stage 1): never fabricate. Every source value shown is REAL
  // (TCGPlayer tier or eBay sold comps) or absent — a missing source renders blank
  // rather than a synthesized number, so portfolio totals reflect only real data.
  // If nothing resolved, the (empty) result returns and the UI shows "—".
  // PriceCharting (ppt) stays null until a real fetch is wired up (Stage 2).
  // A missing TCGPlayer price falls back to the eBay sold average inside analyzeRaw.
  if (!result.psa && card.type==='graded') result.psa = result.ebay; // real eBay comp avg only; null stays null
  if (card.type==='graded' || card.grade) result._diag = '/graded:' + (result.psa!=null ? '$'+Math.round(result.psa) : ('empty' + (fetchEbaySold._fail ? '('+fetchEbaySold._fail+')' : '')));
  // A PSA-10 comp below the raw price is a bad match (raw sales leaked into the query).
  // Drop it so the broader /sold keyword search and PokePrice get a chance at a real number.
  if (result.psa && result.tcg && result.psa < result.tcg * 0.9) { result._diag += '(bad<raw,drop)'; result.psa = null; result.ebayN = 0; result.ebay_sales = []; }

  // ── Graded fallback: when /graded returns no comps, use the broad eBay keyword sold
  //    search (the SAME query the "Sold →" link opens) and average those sales — this is
  //    why the link is full of sales but the card was blank (/graded was too strict). ──
  if ((card.type === 'graded' || card.grade) && !result.psa && card.name) {
    try {
      const gq = [card.name, card.num, card.set, card.grade].filter(Boolean).join(' ');
      const gr = await fetch(`${EBAY_WORKER}/sold?q=${encodeURIComponent(gq)}&limit=12`);
      if (gr.ok) {
        const gd = await gr.json();
        // v16 Worker evidence fields — display-only passthrough (fallback path)
        if (!result.rejected && Array.isArray(gd.rejected) && gd.rejected.length) result.rejected = gd.rejected.slice(0,10);
        if (!result.counts && gd.counts) result.counts = gd.counts;
        const gprices = (gd.items||[]).map(i=>i.price).filter(v=>typeof v==='number'&&v>0);
        let gpp = (gd.stats && (gd.stats.median||gd.stats.avg)) || (gprices.length ? gprices.reduce((a,b)=>a+b,0)/gprices.length : null);
        const gradedOK = gpp > 0 && (!result.tcg || gpp >= result.tcg * 0.9);
        result._diag = (result._diag||'') + ' /sold:'+gprices.length+'i'+(gpp>0?'=$'+Math.round(gpp)+(gradedOK?'':'(bad<raw)'):'');
        if (gradedOK) {
          result.psa = parseFloat(gpp.toFixed(2));
          if (gprices.length) result.ebayN = gprices.length;
          if ((gd.items||[]).length && (!result.ebay_sales || !result.ebay_sales.length)) {
            result.ebay_sales = gd.items.slice(0,6).map(i=>({
              date: i.soldDate ? new Date(i.soldDate).toLocaleDateString('en-US',{month:'short',day:'numeric'}) : 'Recent',
              price: i.price, condition: card.grade || 'Graded', url: i.url,
              title: i.title || '',   // retained for the Pricing Evidence card (2026-07) — display only
            }));
          }
        }
      } else { result._diag = (result._diag||'') + ' /sold:http'+gr.status; }
    } catch(e) { result._diag = (result._diag||'') + ' /sold:err'; }
  }

  // ── For raw singles, fetch real PSA 10 comps from eBay worker ──
  if (card.type !== 'graded' && !result.psa && card.name) {
    try {
      const psaEndpoint = `${EBAY_WORKER}/graded?name=${encodeURIComponent(card.name)}&number=${encodeURIComponent(card.num||'')}&set=${encodeURIComponent(card.set||'')}&grade=PSA+10&rarity=${encodeURIComponent(card.rarity||'')}`;
      const pr = await fetch(psaEndpoint);
      if (pr.ok) {
        const pd = await pr.json();
        const ps = pd.stats?.median || pd.stats?.avg || null;
        if (ps) result.psa = ps;
      }
    } catch(e) {}
  }

  // PokePrice (PokemonPriceTracker): fills the "ppt" comparison slot with the aggregated
  // market price, and supplies a real eBay PSA-10 sold average. fetchPokePrice is fully
  // isolated (timeout + try/catch → null), so this never blocks or breaks the load.
  if (keys.ppt) {
    const pp = await fetchPokePrice(card, tcgKey);
    result._diag = (result._diag||'') + ' pp:' + (pp && (pp.market||pp.psa10) ? ('mkt'+(pp.market!=null?pp.market:'-')+'/psa10:'+(pp.psa10!=null?pp.psa10:'-')) : ('none('+((pp&&pp._reason)||'null')+')'));
    if (pp) {
      if (pp.market > 0) result.ppt = pp.market;
      // PSA 10 value: only when we have no card-specific comp yet, and only for a PSA-10
      // slab or a raw card (psa10.avg is PSA-10 specific — never apply it to a PSA 9, etc.).
      if (!result.psa && pp.psa10 > 0) {
        const gradeNum = parseFloat(((card.grade||'').match(/[\d.]+/)||['0'])[0]);
        const isGradedPsa10 = card.type==='graded' && gradeNum === 10;
        const isRaw = card.type !== 'graded';
        if (isGradedPsa10 || isRaw) result.psa = pp.psa10;
      }
    }
  }

  return result;
}
async function lookupCardId(card){
  if(!card.name) return null;
  try{
    // Build the most precise query possible — number is the key to exact match
    const numShort = (card.num||'').split('/')[0].trim();
    let candidates = [];

    // Query 1: name + number + set (most precise)
    if (numShort && card.set) {
      const q1 = `name:"${card.name}" number:"${numShort}" set.name:"${card.set}"`;
      const r1 = await ptcgFetch(`/cards?q=${encodeURIComponent(q1)}&pageSize=10`);
      if(r1.ok){ const j1=await r1.json(); candidates = j1.data||[]; }
    }

    // Query 2: name + number (if set didn't match)
    if (!candidates.length && numShort) {
      const q2 = `name:"${card.name}" number:"${numShort}"`;
      const r2 = await ptcgFetch(`/cards?q=${encodeURIComponent(q2)}&pageSize=10`);
      if(r2.ok){ const j2=await r2.json(); candidates = j2.data||[]; }
    }

    // Query 3: name + set (fallback)
    if (!candidates.length && card.set) {
      const q3 = `name:"${card.name}" set.name:"${card.set}"`;
      const r3 = await ptcgFetch(`/cards?q=${encodeURIComponent(q3)}&pageSize=10`);
      if(r3.ok){ const j3=await r3.json(); candidates = j3.data||[]; }
    }

    // Query 4: name only (last resort)
    if (!candidates.length) {
      const q4 = `name:"${card.name}"`;
      const r4 = await ptcgFetch(`/cards?q=${encodeURIComponent(q4)}&pageSize=10`);
      if(r4.ok){ const j4=await r4.json(); candidates = j4.data||[]; }
    }

    if(!candidates.length) return null;

    // Pick the BEST match — prefer exact number match
    let best = candidates[0];
    if (numShort) {
      const exactNum = candidates.find(c2 => (c2.number||'').toLowerCase() === numShort.toLowerCase());
      if (exactNum) best = exactNum;
    }

    // Save the resolved cardId AND update the card's metadata
    const found = collection.find(x=>x.id===card.id);
    if(found){
      found.cardId = best.id;
      if(!found.num && best.number) found.num = best.number;
      if(!found.set && best.set?.name) found.set = best.set.name;
      if(!found.rarity && best.rarity) found.rarity = best.rarity;
      save();
    }
    return best.id;
  }catch(e){ console.error('[lookupCardId] failed:', e); }
  return null;
}
// REMOVED (2026-08): simulate(card) — generated a complete fake price object
// (tcg/ebay/ppt/psa) from a hash of the card name. Caller analysis found ZERO
// callers anywhere in the file; the live pricing path is fetchLivePrices() →
// analyzePriceRouted(). Deleted rather than kept dormant because an accidental
// re-wiring would silently inject invented prices into the portfolio.

function buildPriceStrip(p,card){
  const best=bestPrice(p,card?.type==='graded'),worst=worstPrice(p);
  const rows=SOURCES.map(s=>{const v=p[s.k];if(!v)return'';const cls=v===best?'ps-best':v===worst?'ps-high':'';return `<div class="ps-row"><span class="ps-lbl"><span class="ps-bullet" style="background:${s.color}"></span>${s.k==='ebay'?ebaySrcLabel(p).label:s.label}</span><span class="ps-val ${cls}">${fmtPrice(v)}</span></div>`;}).join('');
  const trend=p.trend7!=null?`<span class="ps-trend ${trendClass(p.trend7)}">${fmtTrend(p.trend7)} 7d</span>`:'';
  return rows+`<hr class="ps-divider"><div class="ps-summary"><span>Best: <b style="color:var(--green);font-family:var(--mono)">${fmtPrice(best)}</b></span>${trend}</div>`;
}

// In-flight guard keyed by cacheKey: if the same card is already being priced
// (by a concurrent caller or a re-render that fires during loading), callers await
// the one shared request instead of starting a duplicate. The entry is deleted on
// success OR failure, so a failed card stays uncached and is retried on next render.
const _priceInflight = {};
async function loadPricesForCards(cards){
  if(!Array.isArray(cards) || !cards.length) return;
  // Filter invalid/missing cards, skip already-cached, dedupe by cacheKey.
  const seen = new Set();
  const toFetch = [];
  for(const card of cards){
    if(!card || !card.id) continue;
    const ck = cacheKey(card);
    if(pcache[ck]) continue;
    if(seen.has(ck)) continue;
    seen.add(ck);
    toFetch.push({ card, ck });
  }
  if(!toFetch.length) return;

  let imagesChanged = false;
  const priced = [];   // {card, data} pairs → structured analytics flush at end
  const BATCH = 5; // same safe batch size loadAllPrices() uses

  for(let i=0; i<toFetch.length; i+=BATCH){
    const batch = toFetch.slice(i, i+BATCH);
    await Promise.all(batch.map(async ({ card, ck }) => {
      try{
        const data = await getPricesShared(card);   // shared in-flight dedupe (both loaders)
        if(data){ pcache[ck] = { ts: Date.now(), data }; idbPut(ck, pcache[ck]); }
        if(data) priced.push({ card, data });
        if(!data) return;
        // Patch this card's visible price strip in place.
        const ps = document.getElementById('ps-'+card.id);
        if(ps) ps.innerHTML = buildPriceStrip(data, card);
        // Image enrichment → write to the real collection record (persisted once at end).
        if(data.img){
          const rec = collection.find(c => c.id === card.id);
          if(rec && !rec.img){ rec.img = data.img; imagesChanged = true; }
        }
      }catch(e){
        console.warn('[loadPricesForCards] price failed for', card && card.name, e);
        // Clear the spinner so the card is never stuck on "Fetching…"; leave it
        // uncached so the next render retries it. No simulated price is created here.
        const ps = document.getElementById('ps-'+card.id);
        if(ps) ps.innerHTML = '<div style="font-size:11px;color:var(--muted);padding:4px 0;">Price unavailable</div>';
      }
    }));
    // Persistence is now per-key via idbPut above (IndexedDB).
  }

  // Persist any discovered images to the collection once.
  if(imagesChanged) save();

  // One final state + render cycle. Per-card strips were already patched above, so
  // we refresh only the views that show aggregate totals (Portfolio + Dashboard).
  // We deliberately do NOT re-render Singles/PSA/Wishlist here — those call
  // loadPricesForCards again; the in-flight guard + cached-skip make that a no-op,
  // but skipping the call avoids the loop entirely. renderAll() is never called.
  _pricingPhase('render', { scope: 'cards' });
  flushPriceAnalytics(priced);
  _pricingPhase('settled', { scope: 'cards', priced });
}

// Build a flat list of every card/slab/wishlist item that needs a price
// Owned holdings only. Watchlist items are deliberately NOT included.
//
// They used to be pushed in here as pseudo-cards { id:'wish_'+id, type:'holo',
// cond:'NM' }, which loadAllPrices() then cached under cacheKey(pseudo) =
// 'wish_<id>_NM_unlimited'. The watchlist UI reads 'wish_<id>' (wishPriceData), so
// that entry was never read by anything: every watchlist item cost TWO price
// fetches per cold refresh, and the wasted one used a worse query (the pseudo-card
// carried no cardId / set / num / grade). renderWishlist() owns watchlist pricing
// with the full probe — see the lazy loader at the bottom of that function.
function getAllPriceableItems(){
  const items = [];
  collection.forEach(c => items.push(c));
  return items;
}

let _loadingPrices = false;
// INVARIANT: the price loaders own `pcache` and the per-card price strips
// (`#ps-<id>`), and nothing else. They must never mutate `collection` beyond
// backfilling a missing `img`, and they must not be called from a renderer —
// the dependency runs pricing → UI, never the reverse.
async function loadAllPrices(){
  if(_loadingPrices) return; // prevent concurrent runs
  const all = getAllPriceableItems();
  if(!all.length) return;
  const updEl  = document.getElementById('port-updated');
  const loadEl = document.getElementById('port-loading');
  if(updEl)  updEl.textContent = '';

  // Only fetch cards not already cached
  const toFetch = all.filter(c => !pcache[cacheKey(c)]);
  if(!toFetch.length){ if(loadEl) loadEl.style.display='none'; return; }

  _loadingPrices = true;
  if(loadEl) loadEl.style.display = 'flex';

  let loaded = 0;
  const total = toFetch.length;
  let cacheDirty = false;
  const priced = [];   // {card, data} pairs → structured analytics flush at end

  // Fetch in PARALLEL batches of 5 for speed (instead of one-at-a-time)
  const BATCH = 5;
  for(let i=0; i<toFetch.length; i+=BATCH){
    const batch = toFetch.slice(i, i+BATCH);
    await Promise.all(batch.map(async card => {
      const ck = cacheKey(card);
      try{
        const data = await getPricesShared(card);
        pcache[ck] = {ts:Date.now(),data}; idbPut(ck, pcache[ck]);
        if(data) priced.push({ card, data });
        cacheDirty = true;
        // Update just this card's price strip (cheap, targeted)
        const ps = document.getElementById('ps-'+card.id);
        if(ps) ps.innerHTML = buildPriceStrip(data,card);
        if(data.img&&!card.img){
          const cc=collection.find(c=>c.id===card.id);
          if(cc){cc.img=data.img;}
        }
      }catch(e){ console.error('[price] failed for',card.name,e); }
      loaded++;
      if(loadEl){
        const sp = loadEl.querySelector('span');
        if(sp) sp.textContent = `Loading prices… ${loaded}/${total}`;
      }
    }));
    // Save cache once per batch (not per card)
    if(cacheDirty){ /* persistence now per-key via idbPut above (IndexedDB) */ }
  }

  // Re-render everything ONCE at the end (not per card). The application shell
  // decides WHICH views that means; pricing only announces the phase.
  _pricingPhase('render', { scope: 'all' });

  if(loadEl) loadEl.style.display = 'none';
  if(updEl)  updEl.textContent = 'Updated '+new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
  flushPriceAnalytics(priced);
  _loadingPrices = false;
  // History capture + intelligence signals are application follow-up work, not
  // pricing. Fires at exactly the same point in the sequence as before.
  _pricingPhase('settled', { scope: 'all', priced });
}
