/* ════════════════════════════════════════════════════════════════════════════
   MyTCG Ledger V6 - ptcg-api.js
   ────────────────────────────────────────────────────────────────────────────
   SHARED POKÉMON TCG API ADAPTER. The deliberately minimal layer under the six
   feature modules that talk to api.pokemontcg.io.

       feature module  ->  ptcgFetch()  ->  fetch()

   WHY THIS EXISTS: before this batch the base URL was repeated at 18 call sites
   and the API-key header expression was duplicated in 8 places across 6 modules
   (search, wishlist, scanner, pricing, deal-log, deal-search). Adding a header,
   changing the base URL or introducing rate-limiting meant editing all of them.

   WHAT IT OWNS - only what is genuinely common:
     - the base URL
     - API-key header construction (keys.ptcg -> X-Api-Key, omitted when unset)
     - request execution

   WHAT IT DELIBERATELY DOES NOT OWN:
     - query construction   every caller builds its own q=, orderBy=, pageSize=,
                            page= exactly as before. Query semantics are feature
                            knowledge, not transport.
     - response parsing     callers keep their own .json() handling.
     - ERROR HANDLING       this is the important one. Only 2 of the 6 modules
                            check response.ok today (search.doModalSearch throws
                            on !ok; pricing.lookupCardId gates on r1.ok). The
                            other four go straight to .json(). Unifying that
                            would CHANGE BEHAVIOUR in four modules, so the
                            adapter returns the raw Response untouched and every
                            caller keeps the exact handling it had.
     - retries, caching, rate-limiting - none existed; none is added here.

   It is not a networking framework. It is three lines of shared transport.

   LOAD ORDER: after app-state.js, because ptcgHeaders() reads the `keys` global.
   That read happens at CALL time, so any position before first use is safe.
   LOAD-TIME EXECUTION: one const declaration.
   ════════════════════════════════════════════════════════════════════════════ */

const PTCG_BASE = 'https://api.pokemontcg.io/v2';

// API-key header, byte-equivalent to the 8 duplicated expressions it replaces:
//   keys.ptcg ? {'X-Api-Key':keys.ptcg} : {}
function ptcgHeaders(){
  return (typeof keys !== 'undefined' && keys && keys.ptcg) ? {'X-Api-Key': keys.ptcg} : {};
}

// `pathAndQuery` is everything after /v2, e.g. '/cards?q=...&pageSize=60'.
// The caller owns the query string verbatim, so the resulting URL is identical
// to the one it built before. Returns the raw Response - no .ok check, no parse.
// ── HTTP STATUS SEMANTICS (Batch 33) ───────────────────────────────────────
// A request that returns zero cards and a request that returns HTTP 500 are not
// the same event. Four consumers (wishlist, deal-search, deal-log picker,
// scanner) went straight from ptcgFetch() to .json(), so a 4xx/5xx parsed to an
// object with no .data and rendered the SAME "No results." as a genuine empty
// 200. Only a transport rejection reached their "Search failed." branch.
//
// ptcgFetchOk() closes that gap: it rejects on a non-2xx status so an HTTP error
// lands in the caller's EXISTING catch, alongside transport failure. Callers keep
// their own query construction, parsing and UI copy - nothing else changes.
//
// WHY THIS IS A SEPARATE FUNCTION rather than a change to ptcgFetch():
// pricing.js deliberately GATES on r.ok instead of throwing. lookupCardId() runs
// a four-attempt fallback cascade (`if(r1.ok){...}` then tries q2, q3, q4) and
// fetchLivePrices() retries once with a corrected id. If ptcgFetch() threw, a 500
// on the first attempt would abort the whole cascade and skip the retry - a real
// change to pricing behaviour, which this batch forbids. So ptcgFetch() keeps its
// raw-Response contract for the 14 call sites that already handle status
// correctly, and only the four that never did opt into the throwing variant.
function ptcgFetchOk(pathAndQuery){
  return ptcgFetch(pathAndQuery).then(r=>{
    if(!r.ok) throw new Error('API ' + r.status);   // same idiom search.js already uses
    return r;
  });
}

function ptcgFetch(pathAndQuery){
  return fetch(PTCG_BASE + pathAndQuery, { headers: ptcgHeaders() });
}
