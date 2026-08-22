/* ════════════════════════════════════════════════════════════════════════════
   MyTCG Ledger V6 - recognition-gate2.js
   ────────────────────────────────────────────────────────────────────────────
   MyTCG VISION — GATE 2: real-provider browser validation. DEVELOPER ONLY.

   HOW TO RUN
     1. Deploy this repo and open MyTCG in a normal browser.
     2. Open DevTools -> Console.
     3. Run:   runRecognitionGate2()
     4. Copy the whole [MYTCG VISION - GATE 2 REPORT] block back to Claude.

   Nothing here runs at load. No UI button is added. Calling the function is the
   only way it executes.

   WHAT IT TOUCHES
     Writes ONLY to the disposable `mytcg_recognition` IndexedDB database.
     It never reads or writes collection, pricing, sync or user settings, and it
     never modifies the scanner. Your card collection cannot be affected.

   IT USES THE PRODUCTION PATH — no shortcut:
     ptcgSourceAdapter -> normalizeCard -> makeRecognitionRecord -> validation
       -> staging store -> single-transaction commit -> mytcg_recognition
   That is the exact code Batch C would depend on, which is the point.

   SECRETS: no key is embedded. If you have set a Pokémon TCG API key in
   Settings, ptcgHeaders() picks it up from the app's existing configuration.
   The public API also serves this request unauthenticated.
   ════════════════════════════════════════════════════════════════════════════ */

// Gate 2 imports MULTIPLE sets, because one set cannot prove what Batch C needs:
//   base1  Base Set 1999 - small, vintage, uniform N/102. printedTotal === total,
//          so it CANNOT validate the printedTotal fix. One page: no pagination.
//   swsh7  Evolving Skies - secret rares, so printedTotal (203) != total. This is
//          the set that actually proves the denominator fix, and at ~237 cards it
//          also crosses the 250 page boundary closely enough to exercise paging.
//   swsh9  Brilliant Stars - Trainer Gallery subset gives real alphanumeric
//          collector numbers (TG01..TG30) from the provider, not from a fixture.
// Importing them in sequence also proves INCREMENTAL import: set 2 must not
// destroy set 1, which nothing has tested until now.
const GATE2_SETS = ['base1', 'swsh7', 'swsh9'];
const GATE2_SET_ID = GATE2_SETS[0];   // back-compat for single-set runs

function _g2num(n){ return (n == null || isNaN(n)) ? 'n/a' : (Math.round(n * 10) / 10); }
function _g2type(v){ return v === null ? 'null' : (v === undefined ? 'missing' : Array.isArray(v) ? 'array' : typeof v); }

// Classify a failure precisely rather than collapsing everything into "network failed".
function _g2classify(err, resp){
  const m = String((err && err.message) || err || '');
  // ptcgFetchOk() rejects with Error('API ' + status) on any non-2xx, so the
  // status arrives in the MESSAGE, not as a Response. Recover it before the
  // generic checks, otherwise every HTTP failure looks like an app bug.
  const sm = m.match(/\bAPI\s+(\d{3})\b/);
  const code = (resp && resp.status) || (sm ? Number(sm[1]) : null);
  if (code === 401) return { kind:'AUTH', detail:'HTTP 401 - API key rejected or required' };
  if (code === 403) return { kind:'AUTH_OR_BLOCKED', detail:'HTTP 403 - forbidden (key, or a network/proxy block)' };
  if (code === 429) return { kind:'RATE_LIMIT', detail:'HTTP 429 - rate limited by the provider' };
  if (code && code >= 500) return { kind:'PROVIDER_5XX', detail:'HTTP ' + code + ' - provider-side failure' };
  if (code && code >= 400) return { kind:'PROVIDER_HTTP', detail:'HTTP ' + code };
  if (resp && resp.status === 401) return { kind:'AUTH', detail:'HTTP 401 — API key rejected or required' };
  if (resp && resp.status === 403) return { kind:'AUTH_OR_BLOCKED', detail:'HTTP 403 — forbidden (key, or a network/proxy block)' };
  if (resp && resp.status === 429) return { kind:'RATE_LIMIT', detail:'HTTP 429 — rate limited by the provider' };
  if (resp && resp.status >= 500)  return { kind:'PROVIDER_5XX', detail:'HTTP ' + resp.status + ' — provider-side failure' };
  if (resp && !resp.ok)            return { kind:'PROVIDER_HTTP', detail:'HTTP ' + resp.status };
  if (/Failed to fetch|NetworkError|Load failed/i.test(m)) {
    return { kind:'NETWORK_OR_CORS',
             detail:'Request never completed. Browser reports this identically for DNS failure, offline, and a CORS rejection. ' +
                    'Check the Network tab: a CORS block shows the request as completed-but-blocked, DNS failure shows as failed.' };
  }
  if (/JSON|Unexpected token/i.test(m))       return { kind:'MALFORMED_RESPONSE', detail:m };
  if (/IndexedDB|transaction|object store/i.test(m)) return { kind:'INDEXEDDB', detail:m };
  return { kind:'APPLICATION_ERROR', detail:m };
}

// ORCHESTRATOR. Runs the per-set gate across several sets in sequence, then adds
// the checks that only make sense ACROSS sets: incremental import, cross-set
// integrity, and growth in query time as the catalog gets bigger.
async function runRecognitionGate2(options){
  const opts = options || {};
  if (opts.setId) return runRecognitionGate2Set(opts);      // single-set escape hatch
  const sets = opts.sets || GATE2_SETS;
  const MULTI = { ranAt:new Date().toISOString(), sets, perSet:[], problems:[] };

  if (typeof rcClear === 'function') await rcClear();       // start from empty ONCE

  let cumulative = 0;
  for (const setId of sets){
    const before = await rcCount();
    const r = await runRecognitionGate2Set(Object.assign({}, opts, { setId, _multi:true, _skipClear:true }));
    const after = await rcCount();
    MULTI.perSet.push({
      setId,
      pass: r.gate2Pass,
      fetched: r.firstImport && r.firstImport.fetched,
      inserted: r.firstImport && r.firstImport.inserted,
      pagesFetched: r.firstImport && r.firstImport.pagesFetched,
      reportedTotal: r.firstImport && r.firstImport.reportedTotal,
      truncationSuspected: r.firstImport && r.firstImport.truncationSuspected,
      printedTotal: r.printedTotal,
      recordsBefore: before, recordsAfter: after,
      addedThisSet: after - before,
      variantAudit: r.variantAudit,
      queryMedianMs: r.performance && r.performance.queryMedianMs,
      perRecordBytes: r.performance && r.performance.perRecordBytes,
      problems: r.problems
    });
    if (!r.gate2Pass) MULTI.problems.push('set ' + setId + ' failed: ' + r.problems.join(' | '));
    // INCREMENTAL INTEGRITY: adding a set must never shrink the catalog.
    if (after < before) MULTI.problems.push('CATALOG SHRANK importing ' + setId + ' (' + before + ' -> ' + after + ')');
    cumulative = after;
  }

  // CROSS-SET INTEGRITY: every earlier set must still be queryable after the
  // later ones landed. This is the check that would have caught a commit that
  // wiped instead of merged.
  MULTI.crossSet = [];
  for (const setId of sets){
    const rows = await new Promise(res => { const q = _rcTx(RECOGNITION_STORE,'readonly').getAll();
      q.onsuccess = () => res((q.result||[]).filter(r => r.setId === setId)); q.onerror = () => res([]); });
    const probe = rows[0];
    const found = probe
      ? (await findRecognitionCandidates({ name:probe.name, number:probe.numberDisplay, setId })).candidates.length > 0
      : false;
    MULTI.crossSet.push({ setId, recordsPresent: rows.length, stillQueryable: found });
    if (!rows.length) MULTI.problems.push('set ' + setId + ' has NO records after all imports');
    if (rows.length && !found) MULTI.problems.push('set ' + setId + ' present but NOT queryable');
  }

  // Cross-set ambiguity is the real-world version of the Umbreon case: the same
  // collector number legitimately exists in several sets.
  const sample = MULTI.crossSet[0] && MULTI.crossSet[0].recordsPresent ? null : null;
  const numOnly = await findRecognitionCandidates({ number:'1' });
  MULTI.crossSetAmbiguity = { query:'number "1" only', returned:numOnly.candidates.length,
    ambiguous:numOnly.ambiguous, distinctSets:[...new Set(numOnly.candidates.map(c => c.record && c.record.setId))] };

  MULTI.totals = { records: cumulative, catalogVersion: await rcGetMeta('catalogVersion'),
                   importedSets: await rcGetMeta('importedSets') };
  MULTI.gate2Pass = MULTI.problems.length === 0 && MULTI.perSet.every(p => p.pass);
  return _g2printMulti(MULTI);
}

async function runRecognitionGate2Set(options){
  const opts   = options || {};
  const setId  = opts.setId || GATE2_SET_ID;
  const R      = { setId, ranAt:new Date().toISOString(), problems:[] };
  const line   = [];
  const say    = s => { line.push(s); };
  const clone  = o => JSON.parse(JSON.stringify(o));

  // ── 0. preconditions ───────────────────────────────────────────────────
  const missing = ['importRecognitionSet','ptcgSourceAdapter','findRecognitionCandidates','rcCount','ptcgFetchOk']
    .filter(n => typeof window[n] === 'undefined' && typeof eval('typeof '+n) === 'undefined');
  R.env = {
    importerPresent: typeof importRecognitionSet === 'function',
    adapterPresent:  typeof ptcgSourceAdapter === 'object',
    apiKeyConfigured: !!(typeof keys !== 'undefined' && keys && keys.ptcg),
    catalogRecordsBefore: (typeof rcCount === 'function') ? await rcCount() : null
  };
  if (!R.env.importerPresent || !R.env.adapterPresent){
    R.problems.push('Recognition modules not loaded — deploy the current js/ folder first.');
    return _g2print(R, ['Recognition modules missing. Deploy the current js/ and reload.']);
  }

  // ── 1. LIVE PROVIDER SHAPE, captured BEFORE normalization ─────────────
  let probeCards = null, probeResp = null;
  try {
    probeResp = await ptcgFetchOk('/cards?q=' + encodeURIComponent('set.id:' + setId) + '&pageSize=3&page=1');
    const pj  = await probeResp.json();
    probeCards = (pj && pj.data) || [];
    // Response headers inform BOTH the licensing question (attribution/terms
    // links) and Batch C throughput (rate-limit budget). Only CORS-exposed
    // headers are readable from a browser; absence is not proof of absence.
    const hdrs = {};
    try { probeResp.headers.forEach(function(v,k){ hdrs[k] = v; }); } catch(_){}
    R.network = { ok:true, httpStatus:probeResp.status, totalCount:(pj && pj.totalCount),
                  returned:probeCards.length, exposedHeaders:hdrs,
                  headerNote:'Browsers expose only CORS-whitelisted headers; rate-limit headers may exist but be hidden.' };
  } catch(e){
    R.network = { ok:false, failure:_g2classify(e, probeResp) };
    R.problems.push('Provider fetch failed: ' + R.network.failure.kind + ' — ' + R.network.failure.detail);
    return _g2print(R, ['Could not reach the provider. See Network/API below.']);
  }
  if (!probeCards.length){
    R.problems.push('Provider returned zero cards for set.id:' + setId + ' — the set identifier may be invalid.');
    return _g2print(R, ['Set "' + setId + '" returned no cards. Report this rather than substituting another set.']);
  }

  const FIELDS = ['id','name','number','rarity','hp','supertype'];
  const SETF   = ['id','name','printedTotal','total','releaseDate','ptcgoCode'];
  R.providerShape = {
    topLevelKeys: Object.keys(probeCards[0]).sort(),
    setKeys: probeCards[0].set ? Object.keys(probeCards[0].set).sort() : null,
    fieldTypes: {},
    samples: probeCards.slice(0,3).map(c => ({
      id:c.id, name:c.name, number:c.number, rarity:c.rarity, hp:c.hp, supertype:c.supertype,
      imagesSmall: !!(c.images && c.images.small), imagesLarge: !!(c.images && c.images.large)
    })),
    nullOrMissing: []
  };
  FIELDS.forEach(f => { R.providerShape.fieldTypes[f] = _g2type(probeCards[0][f]); });
  SETF.forEach(f  => { R.providerShape.fieldTypes['set.'+f] = _g2type(probeCards[0].set ? probeCards[0].set[f] : undefined); });
  probeCards.forEach(c => {
    FIELDS.forEach(f => { if (c[f] === null || c[f] === undefined) R.providerShape.nullOrMissing.push(c.id + '.' + f); });
    SETF.forEach(f  => { if (!c.set || c.set[f] === null || c.set[f] === undefined) R.providerShape.nullOrMissing.push(c.id + '.set.' + f); });
    if (!c.images || !c.images.small) R.providerShape.nullOrMissing.push(c.id + '.images.small');
  });

  // ── 2. printedTotal validation (mandatory) ────────────────────────────
  const s0 = probeCards[0].set || {};
  const normalizedProbe = ptcgSourceAdapter.normalizeCard(probeCards[0]);
  const parsedProbe     = rcNormalizeNumber(normalizedProbe.number);
  R.printedTotal = {
    livePrintedTotal: s0.printedTotal,
    liveTotal:        s0.total,
    valuesDiffer:     s0.printedTotal !== s0.total,
    helperReturns:    (typeof _rcPrintedTotal === 'function') ? _rcPrintedTotal(s0) : 'helper missing',
    normalizedNumber: normalizedProbe.number,
    storedDenominator: parsedProbe.denominator,
    usesPrintedTotal:  String(parsedProbe.denominator) === String(s0.printedTotal),
    incorrectlyUsesTotal: (s0.printedTotal !== s0.total) && String(parsedProbe.denominator) === String(s0.total),
    note: (s0.printedTotal === s0.total)
      ? 'printedTotal === total in this set, so the two cannot be distinguished by outcome here. The code path is confirmed to READ printedTotal, but secret-rare behaviour is NOT live-validated by this set.'
      : 'printedTotal differs from total in this set — the preference is genuinely exercised.'
  };
  if (R.printedTotal.incorrectlyUsesTotal) R.problems.push('DENOMINATOR DEFECT: normalization used set.total instead of set.printedTotal.');

  // ── 3. FIRST REAL IMPORT (full production path) ───────────────────────
  const before = await rcCount();
  let r1;
  try {
    const t0 = Date.now();
    r1 = await importRecognitionSet(setId);          // ptcgSourceAdapter by default
    r1.wallClockMs = Date.now() - t0;
  } catch(e){
    R.problems.push('Import threw: ' + _g2classify(e).kind + ' — ' + (e && e.message));
    return _g2print(R, ['First import threw before completing.']);
  }
  R.firstImport = clone(r1);
  R.firstImport.liveRecordCount = await rcCount();
  if (!r1.committed) R.problems.push('First import did not commit: ' + JSON.stringify(r1.errors));

  // ── 4. SECOND IDENTICAL IMPORT — idempotency ──────────────────────────
  const r2 = await importRecognitionSet(setId);
  R.secondImport = clone(r2);
  R.secondImport.liveRecordCount = await rcCount();
  R.idempotency = {
    countStable:       R.firstImport.liveRecordCount === R.secondImport.liveRecordCount,
    zeroInserts:       r2.inserted === 0,
    zeroSpuriousUpdates: r2.updated === 0,
    unchangedMatches:  r2.unchanged === r1.staged,
    versionDeterministic: r1.catalogVersion === r2.catalogVersion,
    pass: false
  };
  R.idempotency.pass = R.idempotency.countStable && R.idempotency.zeroInserts &&
                       R.idempotency.zeroSpuriousUpdates && R.idempotency.versionDeterministic;
  if (!R.idempotency.pass) R.problems.push('IDEMPOTENCY FAILED: ' + JSON.stringify(R.idempotency));

  // ── 5. FAILURE SAFETY (recognition catalog only) ──────────────────────
  const safeBefore = await rcCount();
  const fFetch = await importRecognitionSet(setId, { adapter:{ id:'g2-failing',
      fetchSet: async () => { throw new Error('simulated fetch failure'); }, normalizeCard: c => c } });
  const afterFetch = await rcCount();
  const fStage = await importRecognitionSet(setId, { failAfterStage:true });
  const afterStage = await rcCount();
  const fEmpty = await importRecognitionSet(setId, { adapter:{ id:'g2-empty',
      fetchSet: async () => ({ setId, sourceVersion:'v0', cards:[] }), normalizeCard: c => c } });
  const afterEmpty = await rcCount();
  // Probe with an INDEXED field. A setId-only query matches no index by design,
  // so it would return zero even on a perfectly healthy catalog.
  const probeRec = await new Promise(res => { const q = _rcTx(RECOGNITION_STORE,'readonly').getAll();
    q.onsuccess = () => res((q.result || [])[0] || null); q.onerror = () => res(null); });
  const stillQueryable = probeRec
    ? (await findRecognitionCandidates({ name: probeRec.name, number: probeRec.numberDisplay, setId: probeRec.setId })).candidates.length > 0
    : false;
  R.failureSafety = {
    fetchFailureCommitted: fFetch.committed, countAfterFetchFailure: afterFetch,
    stageFailureCommitted: fStage.committed, countAfterStageFailure: afterStage,
    emptySourceCommitted:  fEmpty.committed, countAfterEmptySource:  afterEmpty,
    catalogIntact: afterFetch === safeBefore && afterStage === safeBefore && afterEmpty === safeBefore,
    stillQueryable,
    pass: !fFetch.committed && !fStage.committed && !fEmpty.committed &&
          afterFetch === safeBefore && afterStage === safeBefore && afterEmpty === safeBefore && stillQueryable
  };
  if (!R.failureSafety.pass) R.problems.push('FAILURE SAFETY FAILED: ' + JSON.stringify(R.failureSafety));

  // ── 6. REAL CANDIDATE QUERIES ─────────────────────────────────────────
  const all = await new Promise(res => { const q = _rcTx(RECOGNITION_STORE,'readonly').getAll();
    q.onsuccess = () => res(q.result || []); q.onerror = () => res([]); });
  const ref = all[0] || {};
  const shortName = (ref.name || '').length > 4 ? (ref.name || '').slice(0, (ref.name||'').length - 2) : (ref.name || '');
  const ask = async (label, query) => {
    const r = await findRecognitionCandidates(query);
    return { label, query, ambiguous:r.ambiguous, returned:r.candidates.length, ms:r.ms,
      top: r.candidates.slice(0,3).map(c => ({ cardId:c.cardId, score:c.score, variant:c.record && c.record.variant, evidence:c.evidence })) };
  };
  R.queries = [
    await ask('exact name + number + set', { name:ref.name, number:ref.numberDisplay, setId:ref.setId, language:'en' }),
    await ask('number + denominator only', { number:ref.numberDisplay }),
    await ask('similar name (truncated)',  { name:shortName, setId:ref.setId }),
    await ask('language evidence (ja)',    { number:ref.numberDisplay, language:'ja' }),
    await ask('deliberate no-match',       { name:'Zzzznotacard', number:'9999/9999', setId:'nosuchset' })
  ];

  // ── 7. PERFORMANCE + STORAGE ──────────────────────────────────────────
  const runs = [];
  for (let i=0;i<50;i++){
    const r = await findRecognitionCandidates({ name:ref.name, number:ref.numberDisplay, setId:ref.setId });
    runs.push(r.ms);
  }
  runs.sort((a,b)=>a-b);
  let usage = null, quota = null, estimateAvailable = false;
  try { if (navigator.storage && navigator.storage.estimate){ const e = await navigator.storage.estimate();
        usage = e.usage; quota = e.quota; estimateAvailable = true; } } catch(_){}
  const jsonBytes = new Blob([JSON.stringify(all)]).size;
  R.performance = {
    fetchMs: r1.timing.fetchMs, normalizeMs: r1.timing.normalizeMs,
    validateStageMs: r1.timing.validateMs, commitMs: r1.timing.commitMs,
    totalImportMs: r1.timing.totalMs, wallClockMs: r1.wallClockMs,
    queryMedianMs: runs[25], queryP95Ms: runs[47], queryMaxMs: runs[49],
    recordCount: all.length,
    jsonBytes, perRecordBytes: all.length ? Math.round(jsonBytes/all.length) : null,
    storageEstimateAvailable: estimateAvailable,
    storageEstimateUsageBytes: usage, storageQuotaBytes: quota,
    storageNote: estimateAvailable
      ? 'navigator.storage.estimate() is origin-wide and includes ALL app data, not just the recognition catalog. jsonBytes is the reliable per-catalog figure.'
      : 'Browser did not expose navigator.storage.estimate(); only jsonBytes is reported.'
  };

  // ── 7b. VARIANT INFERENCE AUDIT on REAL data ──────────────────────────
  // inferVariant() guesses from rarity because the provider does not state
  // variant. This measures how coarse that guess actually is: reverse-holo and
  // 1st-edition printings are NOT representable, so any set where most cards
  // collapse to 'normal' is telling us the variant axis is unusable for now.
  const variantCounts = {}, rarityToVariant = {};
  all.forEach(function(r){
    variantCounts[r.variant] = (variantCounts[r.variant] || 0) + 1;
    const k = (r.rarity || '(none)') + ' -> ' + r.variant;
    rarityToVariant[k] = (rarityToVariant[k] || 0) + 1;
  });
  const collapsed = (variantCounts['normal'] || 0) / (all.length || 1);
  R.variantAudit = {
    counts: variantCounts,
    rarityMapping: rarityToVariant,
    fractionCollapsedToNormal: Math.round(collapsed * 100) / 100,
    distinctVariants: Object.keys(variantCounts).length,
    note: 'Provider does not expose variant. Reverse-holo and 1st-edition are NOT inferable ' +
          'from this source, so printings that differ only by presentation share one record key.'
  };

  // ── 8. metadata + isolation ───────────────────────────────────────────
  R.catalogMeta = { schemaVersion: await rcGetMeta('schemaVersion'), catalogVersion: await rcGetMeta('catalogVersion'),
    sourceProvider: await rcGetMeta('sourceProvider'), sourceVersion: await rcGetMeta('sourceVersion'),
    recordCount: await rcGetMeta('recordCount'), importedSets: await rcGetMeta('importedSets') };
  R.isolation = { collectionLength: (typeof collection !== 'undefined') ? collection.length : null,
                  note:'Gate 2 writes only to mytcg_recognition. Collection length shown to confirm it was untouched.' };
  R.skippedDetail = (r1.skippedDetail || []).slice(0, 20);

  R.gate2Pass = R.problems.length === 0 && !!r1.committed && R.idempotency.pass && R.failureSafety.pass;
  return _g2print(R, null);
}

/* ── MULTI-SET REPORT ─────────────────────────────────────────────────── */
function _g2printMulti(M){
  const L = [];
  L.push('==============================');
  L.push('MYTCG VISION - GATE 2 REPORT (MULTI-SET)');
  L.push('==============================');
  L.push('sets: ' + M.sets.join(', ') + '   ran: ' + M.ranAt);
  L.push('');
  L.push('Per-set results:');
  M.perSet.forEach(function(p){
    L.push('  [' + p.setId + '] ' + (p.pass ? 'PASS' : 'FAIL'));
    L.push('     fetched ' + p.fetched + '  inserted ' + p.inserted +
           '  pages ' + p.pagesFetched + '  providerTotal ' + p.reportedTotal +
           '  truncationSuspected ' + p.truncationSuspected);
    L.push('     catalog ' + p.recordsBefore + ' -> ' + p.recordsAfter + '  (+' + p.addedThisSet + ')');
    if (p.printedTotal){
      L.push('     printedTotal ' + p.printedTotal.livePrintedTotal +
             '  total ' + p.printedTotal.liveTotal +
             '  differ ' + p.printedTotal.valuesDiffer +
             '  storedDenominator ' + p.printedTotal.storedDenominator +
             '  usesPrintedTotal ' + p.printedTotal.usesPrintedTotal +
             '  incorrectlyUsedTotal ' + p.printedTotal.incorrectlyUsesTotal);
    }
    if (p.variantAudit){
      L.push('     variants ' + JSON.stringify(p.variantAudit.counts) +
             '  collapsedToNormal ' + p.variantAudit.fractionCollapsedToNormal);
    }
    L.push('     queryMedian ' + p.queryMedianMs + 'ms  perRecord ~' + p.perRecordBytes + 'B');
    if (p.problems && p.problems.length) p.problems.forEach(function(x){ L.push('     PROBLEM: ' + x); });
  });
  L.push('');
  L.push('Cross-set integrity (after ALL imports):');
  M.crossSet.forEach(function(c){
    L.push('  ' + c.setId + ': records ' + c.recordsPresent + '  stillQueryable ' + c.stillQueryable);
  });
  L.push('');
  if (M.crossSetAmbiguity){
    L.push('Cross-set ambiguity:');
    L.push('  ' + M.crossSetAmbiguity.query + ' -> ' + M.crossSetAmbiguity.returned +
           ' candidates, ambiguous ' + M.crossSetAmbiguity.ambiguous);
    L.push('  spanning sets: ' + JSON.stringify(M.crossSetAmbiguity.distinctSets));
    L.push('');
  }
  L.push('Totals:');
  L.push('  records ' + M.totals.records);
  L.push('  catalogVersion ' + M.totals.catalogVersion);
  L.push('  importedSets ' + JSON.stringify(M.totals.importedSets));
  L.push('');
  if (M.problems.length){ L.push('Problems:'); M.problems.forEach(function(p){ L.push('  - ' + p); }); L.push(''); }
  L.push('Gate 2 overall:');
  L.push('  ' + (M.gate2Pass ? 'PASS' : 'FAIL'));
  L.push('');
  L.push('Licensing status:');
  L.push('  UNRESOLVED / REQUIRES REVIEW - this technical test is not licensing approval.');
  L.push('');
  L.push('Recommended next step:');
  L.push('  Send this whole report to Claude. Batch C stays blocked until licensing is resolved.');
  L.push('==============================');
  const text = L.join('\n');
  console.log(text);
  try { M.reportText = text; window.__gate2Report = M; } catch(_){}
  console.log('(full object also available as window.__gate2Report)');
  return M;
}

/* ── ONE clearly delimited, copy-pasteable report ─────────────────────── */
function _g2print(R, fatal){
  const L = [];
  const P = b => b ? 'PASS' : 'FAIL';
  L.push('==============================');
  L.push('MYTCG VISION - GATE 2 REPORT');
  L.push('==============================');
  L.push('set: ' + R.setId + '   ran: ' + R.ranAt);
  L.push('');
  L.push('Network/API:');
  if (R.network && R.network.ok){
    L.push('  reachable: yes   http ' + R.network.httpStatus + '   provider totalCount ' + R.network.totalCount);
    L.push('  api key configured: ' + (R.env && R.env.apiKeyConfigured));
  } else if (R.network){
    L.push('  reachable: NO');
    L.push('  failure kind: ' + R.network.failure.kind);
    L.push('  detail: ' + R.network.failure.detail);
  } else { L.push('  not reached'); }
  L.push('');
  if (fatal){ fatal.forEach(m => L.push('  ' + m)); }

  if (R.providerShape){
    L.push('Provider shape:');
    L.push('  top-level keys: ' + R.providerShape.topLevelKeys.join(', '));
    L.push('  set keys: ' + (R.providerShape.setKeys || []).join(', '));
    L.push('  field types: ' + JSON.stringify(R.providerShape.fieldTypes));
    R.providerShape.samples.forEach(s => L.push('  sample: ' + JSON.stringify(s)));
    L.push('  null/missing: ' + (R.providerShape.nullOrMissing.length ? R.providerShape.nullOrMissing.join(', ') : 'none'));
    L.push('');
  }
  if (R.printedTotal){
    L.push('printedTotal validation:');
    L.push('  live printedTotal: ' + R.printedTotal.livePrintedTotal + '   live total: ' + R.printedTotal.liveTotal +
           '   differ: ' + R.printedTotal.valuesDiffer);
    L.push('  _rcPrintedTotal() returned: ' + R.printedTotal.helperReturns);
    L.push('  normalized number: ' + R.printedTotal.normalizedNumber + '   stored denominator: ' + R.printedTotal.storedDenominator);
    L.push('  uses printedTotal: ' + R.printedTotal.usesPrintedTotal + '   incorrectly used total: ' + R.printedTotal.incorrectlyUsesTotal);
    L.push('  ' + R.printedTotal.note);
    L.push('');
  }
  if (R.firstImport){
    const a = R.firstImport;
    L.push('First import:');
    L.push('  fetched ' + a.fetched + '  inserted ' + a.inserted + '  updated ' + a.updated +
           '  unchanged ' + a.unchanged + '  skipped ' + a.skipped);
    L.push('  committed ' + a.committed + '  durationMs ' + a.timing.totalMs + '  liveRecords ' + a.liveRecordCount);
    L.push('  catalogVersion ' + a.catalogVersion);
    L.push('  provider ' + a.adapter + '  sourceVersion ' + a.sourceVersion);
    L.push('  errors ' + JSON.stringify(a.errors));
    L.push('');
  }
  if (R.secondImport){
    const b = R.secondImport;
    L.push('Second import:');
    L.push('  fetched ' + b.fetched + '  inserted ' + b.inserted + '  updated ' + b.updated +
           '  unchanged ' + b.unchanged + '  skipped ' + b.skipped);
    L.push('  committed ' + b.committed + '  durationMs ' + b.timing.totalMs + '  liveRecords ' + b.liveRecordCount);
    L.push('  catalogVersion ' + b.catalogVersion);
    L.push('');
  }
  if (R.idempotency){
    L.push('Idempotency:');
    L.push('  ' + P(R.idempotency.pass) + '  ' + JSON.stringify(R.idempotency));
    L.push('');
  }
  if (R.failureSafety){
    L.push('Failure safety:');
    L.push('  ' + P(R.failureSafety.pass) + '  ' + JSON.stringify(R.failureSafety));
    L.push('');
  }
  if (R.queries){
    L.push('Candidate queries:');
    R.queries.forEach(q => {
      L.push('  [' + q.label + '] returned ' + q.returned + '  ambiguous ' + q.ambiguous + '  ' + _g2num(q.ms) + 'ms');
      q.top.forEach(c => L.push('     ' + c.cardId + '  score ' + c.score + '  ' + JSON.stringify(c.evidence)));
      if (!q.top.length) L.push('     (no candidates)');
    });
    L.push('');
  }
  if (R.performance){
    const p = R.performance;
    L.push('Performance:');
    L.push('  fetch ' + p.fetchMs + 'ms  normalize ' + p.normalizeMs + 'ms  validate/stage ' + p.validateStageMs +
           'ms  commit ' + p.commitMs + 'ms  total ' + p.totalImportMs + 'ms');
    L.push('  query median ' + _g2num(p.queryMedianMs) + 'ms  p95 ' + _g2num(p.queryP95Ms) + 'ms  max ' + _g2num(p.queryMaxMs) + 'ms');
    L.push('  records ' + p.recordCount + '  jsonBytes ' + p.jsonBytes + '  perRecord ~' + p.perRecordBytes + 'B');
    L.push('  storage estimate available: ' + p.storageEstimateAvailable +
           (p.storageEstimateUsageBytes != null ? ('  originUsage ' + p.storageEstimateUsageBytes + 'B') : ''));
    L.push('  ' + p.storageNote);
    L.push('');
  }
  if (R.skippedDetail && R.skippedDetail.length){
    L.push('Skipped records (with reasons):');
    R.skippedDetail.forEach(s => L.push('  ' + s.id + ': ' + s.reasons.join('; ')));
    L.push('');
  }
  if (R.catalogMeta){ L.push('Catalog metadata:'); L.push('  ' + JSON.stringify(R.catalogMeta)); L.push(''); }
  if (R.isolation){ L.push('Isolation:'); L.push('  collection length ' + R.isolation.collectionLength + ' (must be unchanged)'); L.push(''); }
  if (R.problems && R.problems.length){ L.push('Problems:'); R.problems.forEach(p => L.push('  - ' + p)); L.push(''); }
  L.push('Gate 2 overall:');
  L.push('  ' + (R.gate2Pass ? 'PASS' : 'FAIL'));
  L.push('');
  L.push('Licensing status:');
  L.push('  UNRESOLVED / REQUIRES REVIEW - this technical test is not licensing approval.');
  L.push('');
  L.push('Recommended next step:');
  L.push('  ' + (R.gate2Pass
      ? 'Send this whole report to Claude. Batch C remains blocked until the licensing audit is resolved.'
      : 'Send this whole report to Claude. Do NOT proceed to Batch C.'));
  L.push('==============================');
  const text = L.join('\n');
  console.log(text);
  try { R.reportText = text; window.__gate2Report = R; } catch(_){}
  console.log('(full object also available as window.__gate2Report)');
  return R;
}
