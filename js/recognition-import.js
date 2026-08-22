/* ════════════════════════════════════════════════════════════════════════════
   MyTCG Ledger V6 - recognition-import.js
   ────────────────────────────────────────────────────────────────────────────
   MyTCG VISION — BATCH B: real-set importer.

   ⚠ LICENSING AUDIT IS UNRESOLVED (see the Batch B report). The sandbox this was
   built in blocks all external hosts (x-deny-reason: host_not_allowed), so the
   published pokemontcg.io terms could NOT be read. No claim is made here about
   what that provider permits. The architecture therefore treats the provider as
   SWAPPABLE and stores only what an adapter chooses to emit — see SourceAdapter.
   Nothing in this file downloads images or derives fingerprints.

   PIPELINE
     source adapter -> normalized source card -> canonical identity
       -> recognition record -> STAGE -> VALIDATE -> COMMIT -> version metadata

   SAFETY PROPERTY (the point of Batch B)
     A failed or interrupted import must leave the previously working catalog
     usable. Records are staged in a SEPARATE store and only copied into the
     live store inside ONE IndexedDB transaction after validation passes. A
     crash before commit leaves the live store byte-identical; a crash during
     commit is rolled back by IndexedDB itself.

   DEVELOPMENT ONLY. Nothing here runs at load. importRecognitionSet() must be
   invoked explicitly by a developer or a test. Users do not build catalogs yet.
   ════════════════════════════════════════════════════════════════════════════ */

const RECOGNITION_STAGE_STORE = 'staging';

/* ── SOURCE ADAPTER BOUNDARY ─────────────────────────────────────────────────
   The rest of the catalog must never see provider field names. An adapter
   exposes exactly two things:
       id                      — provenance, recorded in catalog metadata
       fetchSet(setId)         — returns { setId, sourceVersion, cards:[raw] }
       normalizeCard(raw)      — provider shape -> our neutral shape
   Swapping providers means writing one adapter; nothing else changes. */

// Real provider adapter. Runs in a BROWSER where network is available — it was
// never executed in the build sandbox. Uses the existing centralized ptcgFetch
// so headers/base URL stay in one place (ptcg-api.js).
const ptcgSourceAdapter = {
  id: 'pokemontcg.io/v2',
  async fetchSet(setId, opts){
    const pageSize = (opts && opts.pageSize) || 250;
    const cards = [];
    let page = 1, total = null;
    // Paginated so a large set cannot silently truncate at 250.
    for(;;){
      const r = await ptcgFetchOk('/cards?q=' + encodeURIComponent('set.id:' + setId) +
                                  '&orderBy=number&pageSize=' + pageSize + '&page=' + page);
      const j = await r.json();
      const batch = (j && j.data) || [];
      cards.push.apply(cards, batch);
      total = (j && j.totalCount) != null ? j.totalCount : total;
      if (batch.length < pageSize) break;
      page++;
      if (page > 40) break;                       // hard stop; no runaway paging
    }
    // pagesFetched is reported so a caller can PROVE the paging loop ran and that
    // nothing was silently truncated at the page size.
    return { setId, sourceVersion: adapterSourceVersion(cards), cards,
             reportedTotal: total, pagesFetched: page, pageSize };
  },
  normalizeCard(raw){
    const c = raw || {};
    const set = c.set || {};
    return {
      cardId:   c.id,                              // EXISTING canonical id — not a new one
      name:     c.name,
      setId:    set.id,
      setName:  set.name,
      setAbbr:  set.ptcgoCode || '',
      // Provider gives number and total separately; our parser wants N/T.
      // Only build N/T when the provider actually gave a number. An empty
      // number must stay empty so validation rejects it — concatenating it
      // with the set total yields a bogus "/60" that looks valid.
      // DENOMINATOR SOURCE (found reviewing the provider contract, Gate 2):
      // v2 exposes BOTH set.printedTotal and set.total. printedTotal is what is
      // physically PRINTED on the card; total additionally counts secret rares.
      // OCR reads the printed value, so indexing on total would break denominator
      // matching on precisely the secret rares that need it most — e.g. Evolving
      // Skies cards read "215/203" (printedTotal 203) while total is 237.
      // Prefer printedTotal, fall back to total, then to a bare number.
      number:   (c.number != null && String(c.number).trim() !== '')
                  ? (_rcPrintedTotal(set) != null
                       ? (c.number + '/' + _rcPrintedTotal(set))
                       : String(c.number))
                  : '',
      year:     set.releaseDate ? parseInt(String(set.releaseDate).slice(0,4), 10) : null,
      rarity:   c.rarity || '',
      cardType: c.supertype || '',
      hp:       c.hp != null && c.hp !== '' ? Number(c.hp) : null,
      language: 'en',                              // v2 is English-only; ja needs another adapter
      variant:  inferVariant(c),
      imageRef: (c.images && c.images.small) || '',
      imageVersion: 1
    };
  }
};

// printedTotal is authoritative for the collector-number denominator; total is
// a fallback for sources that do not expose it. NOT yet verified against a live
// provider response — network was unavailable when this was written.
function _rcPrintedTotal(set){
  if (!set) return null;
  if (set.printedTotal != null && set.printedTotal !== '') return set.printedTotal;
  if (set.total != null && set.total !== '') return set.total;
  return null;
}

// Variant is presentation, not identity. The provider does not state it
// directly, so infer conservatively from rarity and fall back to 'normal'
// rather than guessing. Reverse/1st-edition printings are NOT inferable from
// v2 data and remain a known gap (see report).
function inferVariant(c){
  const r = String((c && c.rarity) || '').toLowerCase();
  if (r.includes('promo')) return 'promo';
  if (r.includes('secret') || r.includes('rainbow') || r.includes('hyper')) return 'alt_art';
  if (r.includes('holo')) return 'holo';
  return 'normal';
}

// Deterministic source version: a content hash, NOT a bare timestamp, so an
// unchanged source produces an unchanged version and re-imports are provably
// no-ops. FNV-1a over sorted card ids + their mutable fields.
function adapterSourceVersion(cards){
  const parts = (cards || []).map(function(c){
    const s = c.set || {};
    return [c.id, c.name, c.number, s.total, c.rarity, c.hp].join('~');
  }).sort();
  let h = 0x811c9dc5;
  const str = parts.join('|');
  for (let i = 0; i < str.length; i++){ h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return 'fnv1a-' + h.toString(16).padStart(8,'0') + '-' + (cards||[]).length;
}

/* ── VALIDATION ──────────────────────────────────────────────────────────────
   Malformed records are SKIPPED WITH A REASON, never silently ingested and
   never silently dropped. */
function validateRecognitionRecord(rec){
  const errs = [];
  if (!rec || typeof rec !== 'object') return ['record is not an object'];
  if (rec.schemaVersion !== RECOGNITION_SCHEMA_VERSION) errs.push('schemaVersion ' + rec.schemaVersion + ' != ' + RECOGNITION_SCHEMA_VERSION);
  if (!rec.cardId)                    errs.push('missing canonical cardId');
  if (rec.game !== 'pokemon')         errs.push('unsupported game "' + rec.game + '"');
  if (!rec.normalizedName)            errs.push('normalizedName is empty');
  if (!rec.setId)                     errs.push('missing setId');
  if (!rec.numberDisplay)             errs.push('collector number not preserved');
  else if (!rec.number)               errs.push('collector number has no numerator ("' + rec.numberDisplay + '")');
  if (!rec.language)                  errs.push('missing language');
  if (!RC_VARIANTS.includes(rec.variant)) errs.push('unknown variant "' + rec.variant + '"');
  const key = rcRecordKey(rec);
  if (!key || key.split('|').length !== 3 || key.startsWith('|')) errs.push('invalid idempotency key "' + key + '"');
  return errs;
}

/* ── STAGED / ATOMIC IMPORT ─────────────────────────────────────────────── */
function rcOpenWithStaging(){
  // The staging store is created by the same upgrade path as the live store, so
  // no second database and no second version scheme.
  return rcOpen();
}

async function _rcStageClear(){
  return new Promise(function(res){
    try { const r = _rcDB.transaction(RECOGNITION_STAGE_STORE,'readwrite').objectStore(RECOGNITION_STAGE_STORE).clear();
          r.onsuccess=function(){res(true);}; r.onerror=function(){res(false);}; } catch(_){ res(false); }
  });
}
async function _rcStageAll(records){
  return new Promise(function(res){
    try {
      const tx = _rcDB.transaction(RECOGNITION_STAGE_STORE,'readwrite');
      const os = tx.objectStore(RECOGNITION_STAGE_STORE);
      records.forEach(function(r){ os.put(Object.assign({}, r, { _key: rcRecordKey(r) })); });
      tx.oncomplete=function(){res(true);}; tx.onerror=function(){res(false);};
    } catch(_){ res(false); }
  });
}
async function _rcStageReadAll(){
  return new Promise(function(res){
    try { const r=_rcDB.transaction(RECOGNITION_STAGE_STORE,'readonly').objectStore(RECOGNITION_STAGE_STORE).getAll();
          r.onsuccess=function(){res(r.result||[]);}; r.onerror=function(){res([]);}; } catch(_){ res([]); }
  });
}
// The commit. ONE transaction: if anything throws, IndexedDB rolls the whole
// thing back and the live catalog is untouched.
async function _rcCommitStaged(staged){
  return new Promise(function(res){
    try {
      const tx = _rcDB.transaction(RECOGNITION_STORE,'readwrite');
      const os = tx.objectStore(RECOGNITION_STORE);
      staged.forEach(function(r){ os.put(r); });
      tx.oncomplete = function(){ res(true); };
      tx.onerror    = function(){ res(false); };
      tx.onabort    = function(){ res(false); };
    } catch(_){ res(false); }
  });
}

/* ── IMPORT ENTRY POINT ──────────────────────────────────────────────────── */
async function importRecognitionSet(setId, options){
  const opts    = options || {};
  const adapter = opts.adapter || ptcgSourceAdapter;
  const t0 = Date.now();
  const result = {
    setId, adapter: adapter.id, fetched:0, staged:0, inserted:0, updated:0,
    unchanged:0, skipped:0, errors:[], skippedDetail:[], committed:false,
    catalogVersion:null, sourceVersion:null,
    timing:{ fetchMs:0, normalizeMs:0, validateMs:0, commitMs:0, totalMs:0 }
  };

  await rcOpenWithStaging();
  if (!_rcOK){ result.errors.push('IndexedDB unavailable'); return result; }

  // 1. FETCH
  let src;
  try {
    const f0 = Date.now();
    src = await adapter.fetchSet(setId, opts);
    result.timing.fetchMs = Date.now() - f0;
  } catch(e){
    result.errors.push('fetch failed: ' + (e && e.message || e));
    return result;                                   // live catalog untouched
  }
  result.fetched = (src.cards || []).length;
  result.sourceVersion = src.sourceVersion || null;
  result.pagesFetched  = src.pagesFetched != null ? src.pagesFetched : null;
  result.reportedTotal = src.reportedTotal != null ? src.reportedTotal : null;
  // A mismatch here means the provider said N but we received M — silent
  // truncation is the single most damaging failure a catalog import can have.
  result.truncationSuspected = (result.reportedTotal != null) && (result.fetched < result.reportedTotal);

  // 2. NORMALIZE + VALIDATE  (nothing has touched the live store yet)
  const n0 = Date.now();
  const good = [], seen = new Map();
  (src.cards || []).forEach(function(raw){
    let rec;
    try {
      const norm = adapter.normalizeCard(raw);
      rec = makeRecognitionRecord(Object.assign({}, norm, {
        sourceVersion: src.sourceVersion, updatedAt: Date.now()
      }));
    } catch(e){
      result.skipped++; result.skippedDetail.push({ id:(raw&&raw.id)||'?', reasons:['normalize threw: '+(e&&e.message||e)] });
      return;
    }
    const errs = validateRecognitionRecord(rec);
    if (errs.length){
      result.skipped++; result.skippedDetail.push({ id:rec.cardId||'?', reasons:errs });
      return;
    }
    const key = rcRecordKey(rec);
    if (seen.has(key)){
      // A duplicate provider row must not become a duplicate local record.
      result.skipped++; result.skippedDetail.push({ id:rec.cardId, reasons:['duplicate provider record for key '+key] });
      return;
    }
    seen.set(key, true);
    good.push(rec);
  });
  result.timing.normalizeMs = Date.now() - n0;
  result.staged = good.length;

  if (opts.failAfterStage) {            // test hook: simulate a mid-import crash
    result.errors.push('aborted after staging (test hook)');
    return result;                       // live catalog still intact
  }
  if (!good.length){
    result.errors.push('no valid records — refusing to commit an empty catalog');
    return result;                       // never wipe a working catalog with nothing
  }

  // 3. DIFF against live so we can report insert/update/unchanged honestly
  const v0 = Date.now();
  const existing = new Map();
  (await new Promise(function(res){
    try { const r=_rcTx(RECOGNITION_STORE,'readonly').getAll();
          r.onsuccess=function(){res(r.result||[]);}; r.onerror=function(){res([]);}; } catch(_){res([]);}
  })).forEach(function(r){ existing.set(r._key, r); });

  good.forEach(function(rec){
    const key = rcRecordKey(rec);
    const prev = existing.get(key);
    if (!prev) result.inserted++;
    else if (_rcMaterialDiff(prev, rec)) result.updated++;
    else result.unchanged++;
  });
  result.timing.validateMs = Date.now() - v0;

  // 4. STAGE then COMMIT
  const c0 = Date.now();
  await _rcStageClear();
  const stagedOK = await _rcStageAll(good);
  if (!stagedOK){ result.errors.push('staging failed — live catalog untouched'); return result; }
  const staged = await _rcStageReadAll();
  if (staged.length !== good.length){
    result.errors.push('staging count mismatch ('+staged.length+' != '+good.length+') — refusing to commit');
    return result;
  }
  result.committed = await _rcCommitStaged(staged);
  result.timing.commitMs = Date.now() - c0;
  if (!result.committed){ result.errors.push('commit failed — live catalog rolled back by IndexedDB'); return result; }
  await _rcStageClear();

  // 5. VERSION METADATA — deterministic, derived from content
  result.catalogVersion = 'cat-' + RECOGNITION_SCHEMA_VERSION + '-' + (src.sourceVersion || 'unknown');
  await rcSetMeta('schemaVersion',  RECOGNITION_SCHEMA_VERSION);
  await rcSetMeta('catalogVersion', result.catalogVersion);
  await rcSetMeta('sourceProvider', adapter.id);
  await rcSetMeta('sourceVersion',  src.sourceVersion || null);
  await rcSetMeta('recordCount',    await rcCount());
  await rcSetMeta('importedAt',     Date.now());
  await rcSetMeta('importStatus',   'ok');
  const sets = (await rcGetMeta('importedSets')) || [];
  if (!sets.includes(setId)) sets.push(setId);
  await rcSetMeta('importedSets', sets);

  result.timing.totalMs = Date.now() - t0;
  return result;
}

// Compare only fields that come from the source. updatedAt always changes, so
// comparing whole records would report every re-import as an "update".
const _RC_MATERIAL = ['cardId','name','normalizedName','setId','setName','setAbbr','numberDisplay',
  'number','denominator','year','rarity','cardType','hp','variant','language','imageRef','schemaVersion'];
function _rcMaterialDiff(a, b){
  for (const f of _RC_MATERIAL){ if (a[f] !== b[f]) return true; }
  return false;
}
