/* ════════════════════════════════════════════════════════════════════════════
   MyTCG Ledger V6 - recognition-catalog.js
   ────────────────────────────────────────────────────────────────────────────
   MyTCG VISION — BATCH A: Recognition Catalog foundation.

   PURPOSE (and only this): given imperfect metadata read off a photograph,
   return a SMALL, RANKED, EXPLAINABLE set of known Pokémon cards it could be.
   It answers "which known card is this?" — nothing else.

   THIS IS NOT A SECOND IDENTITY SYSTEM. identityEngine() in identity.js stays
   authoritative. A recognition record carries `cardId` (the pokemontcg id the
   rest of the app already uses as canonical) and the candidate ranker returns
   that id. Recognition proposes; identity disposes. No new canonical ID format
   is introduced, and nothing here writes to `collection`.

   NOT AN INVENTORY DATABASE. It stores catalog reference data only — never a
   user's holdings, never quantities, never prices.

   SEPARATE FROM PRICING. No pcache, no valuation, no network pricing.

   ── STORAGE ───────────────────────────────────────────────────────────────
   A THIRD IndexedDB database, deliberately separate from the two that exist:
       mytcg_collection v1  (store 'kv')      — user holdings
       mytcg_pcache     v1  (store 'pcache')  — price cache
       mytcg_recognition v1 (this file)       — catalog reference data
   Separate because its lifecycle is different: it is disposable, rebuildable
   from source, and may be cleared without touching user data. Deleting it can
   never lose anything the user owns.

   ── VERSIONING ────────────────────────────────────────────────────────────
   RECOGNITION_SCHEMA_VERSION is stamped on every record, so a later batch can
   migrate or re-ingest selectively. CATALOG_META holds catalogVersion and
   sourceVersion for incremental updates in Batch B/C.

   ── SCOPE (Batch A) ───────────────────────────────────────────────────────
   Pokémon only. Fixtures only. No importer, no OCR, no hashing, no camera, no
   Claude changes. The fingerprint fields exist in the schema but are null —
   reserved for Batch D so the schema does not have to change under real data.
   ════════════════════════════════════════════════════════════════════════════ */

const RECOGNITION_SCHEMA_VERSION = 1;
const RECOGNITION_DB_NAME        = 'mytcg_recognition';
const RECOGNITION_DB_VERSION     = 2;   // v2 adds the 'staging' store (Batch B atomic import)
const RECOGNITION_STORE          = 'records';
const RECOGNITION_META_STORE     = 'meta';

/* ── NORMALIZATION ──────────────────────────────────────────────────────────
   Deterministic and lossless: every normalizer keeps the original display
   value alongside structured parts, because the display value is what the user
   sees and the structured parts are what we index on. */

// "  Giratina  V " / "GIRATINA V" -> "giratina v".  Diacritics folded (Pokémon
// -> pokemon) so OCR that drops an accent still matches. Meaningful separators
// are kept as spaces rather than deleted, so "Mr. Mime" != "MrMime".
function rcNormalizeName(name){
  if (name == null) return '';
  return String(name)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')  // fold accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Collector numbers are NOT numeric. Handles 186/196, TG23/TG30, GG44/GG70,
// SV107/SV122, SWSH123, 199/165 (denominator smaller than number — real for
// secret rares, so never "corrected"). Returns display + structured parts.
function rcNormalizeNumber(raw){
  const display = raw == null ? '' : String(raw).trim();
  if (!display) return { display:'', number:'', denominator:'', prefix:'', digits:'', hasDenominator:false };
  const parts = display.split('/');
  const left  = (parts[0] || '').trim().toUpperCase();
  const right = (parts[1] || '').trim().toUpperCase();
  const m = left.match(/^([A-Z]*)(\d*)([A-Z]*)$/) || [];
  return {
    display,
    number: left,
    denominator: right,
    prefix: (m[1] || ''),
    digits: (m[2] || ''),
    hasDenominator: parts.length > 1 && right !== ''
  };
}

function rcNormalizeSetId(setId){
  return setId == null ? '' : String(setId).trim().toLowerCase();
}

// Explicit and extensible — not hardcoded to two languages forever.
function rcNormalizeLanguage(lang){
  const v = (lang == null ? '' : String(lang)).trim().toLowerCase();
  if (!v) return 'en';
  if (v === 'english'  || v === 'eng') return 'en';
  if (v === 'japanese' || v === 'jpn' || v === 'jp') return 'ja';
  return v;
}

// Presentation, NOT identity. name+set+number does not always resolve a single
// printing, so variant is preserved as its own axis.
const RC_VARIANTS = ['normal','holo','reverse','promo','stamped_promo','alt_art','first_edition','unlimited','reprint'];
function rcNormalizeVariant(v){
  const s = (v == null ? '' : String(v)).trim().toLowerCase().replace(/[\s-]+/g,'_');
  return RC_VARIANTS.includes(s) ? s : (s || 'normal');
}

/* ── RECOGNITION RECORD ─────────────────────────────────────────────────── */
function makeRecognitionRecord(src){
  const s = src || {};
  const num = rcNormalizeNumber(s.number);
  const name = String(s.name == null ? '' : s.name);
  return {
    schemaVersion:   RECOGNITION_SCHEMA_VERSION,
    // canonical link — the id the REST of the app already treats as canonical.
    cardId:          s.cardId == null ? '' : String(s.cardId),
    game:            'pokemon',                      // Pokémon only in Batch A
    language:        rcNormalizeLanguage(s.language),
    name,
    normalizedName:  rcNormalizeName(name),
    setId:           rcNormalizeSetId(s.setId),
    setName:         s.setName == null ? '' : String(s.setName),
    setAbbr:         s.setAbbr == null ? '' : String(s.setAbbr),
    numberDisplay:   num.display,
    number:          num.number,
    denominator:     num.denominator,
    numberPrefix:    num.prefix,
    numberDigits:    num.digits,
    year:            s.year == null ? null : Number(s.year),
    rarity:          s.rarity == null ? '' : String(s.rarity),
    cardType:        s.cardType == null ? '' : String(s.cardType),
    hp:              s.hp == null || s.hp === '' ? null : Number(s.hp),
    variant:         rcNormalizeVariant(s.variant),
    imageRef:        s.imageRef == null ? '' : String(s.imageRef),
    imageVersion:    s.imageVersion == null ? 1 : Number(s.imageVersion),
    // Reserved for Batch D. Present so the schema is stable before real data.
    fullCardHash:    null,
    artworkHash:     null,
    sourceVersion:   s.sourceVersion == null ? 'fixture-a' : String(s.sourceVersion),
    updatedAt:       s.updatedAt == null ? 0 : Number(s.updatedAt)
  };
}

// Idempotency key. Same printing ingested twice must not duplicate: identity is
// (cardId, language, variant) — cardId alone is not enough because the same
// printing exists in multiple languages.
function rcRecordKey(rec){
  return [rec.cardId, rec.language, rec.variant].join('|');
}

/* ── LOCAL STORE ─────────────────────────────────────────────────────────── */
let _rcDB = null, _rcOK = false;

// Indexes are chosen from the queries the scanner will actually issue (see
// findRecognitionCandidates), NOT speculatively — every one below is used.
function rcOpen(){
  return new Promise(function(resolve){
    try {
      if (!window.indexedDB) return resolve(null);
      if (_rcDB) return resolve(_rcDB);
      const req = indexedDB.open(RECOGNITION_DB_NAME, RECOGNITION_DB_VERSION);
      req.onupgradeneeded = function(e){
        const db = e.target.result;
        if (!db.objectStoreNames.contains(RECOGNITION_STORE)) {
          const os = db.createObjectStore(RECOGNITION_STORE, { keyPath: '_key' });
          os.createIndex('byCardId',       'cardId',                        { unique:false });
          os.createIndex('byNumber',       'number',                        { unique:false });
          os.createIndex('byNumDenom',     ['number','denominator'],        { unique:false });
          os.createIndex('bySetNumber',    ['setId','number'],              { unique:false });
          os.createIndex('byNameNumber',   ['normalizedName','number'],     { unique:false });
          os.createIndex('byNormalizedName','normalizedName',               { unique:false });
          os.createIndex('byLangNumber',   ['language','number'],           { unique:false });
        }
        if (!db.objectStoreNames.contains(RECOGNITION_META_STORE)) {
          db.createObjectStore(RECOGNITION_META_STORE);
        }
        // Batch B: staging store for atomic imports. Records land here first and
        // are copied into `records` in ONE transaction only after validation, so
        // an interrupted import cannot corrupt a working catalog.
        if (!db.objectStoreNames.contains('staging')) {
          db.createObjectStore('staging', { keyPath: '_key' });
        }
      };
      req.onsuccess = function(e){ _rcDB = e.target.result; _rcOK = true; resolve(_rcDB); };
      req.onerror   = function(){ resolve(null); };
    } catch(_) { resolve(null); }
  });
}
function _rcTx(store, mode){ return _rcDB.transaction(store, mode).objectStore(store); }

// Idempotent by construction: keyPath '_key' + put() means re-ingesting the
// same printing overwrites rather than duplicating.
async function rcPutRecords(records){
  await rcOpen();
  if (!_rcOK) return { written:0, skipped:(records||[]).length, ok:false };
  const list = (records || []).filter(Boolean);
  return new Promise(function(resolve){
    try {
      const tx = _rcDB.transaction(RECOGNITION_STORE, 'readwrite');
      const os = tx.objectStore(RECOGNITION_STORE);
      let written = 0;
      list.forEach(function(r){
        const rec = Object.assign({}, r, { _key: rcRecordKey(r) });
        os.put(rec); written++;
      });
      tx.oncomplete = function(){ resolve({ written, skipped:0, ok:true }); };
      tx.onerror    = function(){ resolve({ written:0, skipped:list.length, ok:false }); };
    } catch(_) { resolve({ written:0, skipped:list.length, ok:false }); }
  });
}
async function rcCount(){
  await rcOpen();
  if (!_rcOK) return 0;
  return new Promise(function(resolve){
    try { const r = _rcTx(RECOGNITION_STORE,'readonly').count();
          r.onsuccess = function(){ resolve(r.result||0); }; r.onerror = function(){ resolve(0); }; }
    catch(_) { resolve(0); }
  });
}
async function rcClear(){
  await rcOpen();
  if (!_rcOK) return false;
  return new Promise(function(resolve){
    try { const r = _rcTx(RECOGNITION_STORE,'readwrite').clear();
          r.onsuccess = function(){ resolve(true); }; r.onerror = function(){ resolve(false); }; }
    catch(_) { resolve(false); }
  });
}
async function rcSetMeta(k,v){
  await rcOpen(); if(!_rcOK) return false;
  return new Promise(function(res){ try{ const r=_rcTx(RECOGNITION_META_STORE,'readwrite').put(v,k);
    r.onsuccess=function(){res(true);}; r.onerror=function(){res(false);}; }catch(_){res(false);} });
}
async function rcGetMeta(k){
  await rcOpen(); if(!_rcOK) return null;
  return new Promise(function(res){ try{ const r=_rcTx(RECOGNITION_META_STORE,'readonly').get(k);
    r.onsuccess=function(){res(r.result==null?null:r.result);}; r.onerror=function(){res(null);}; }catch(_){res(null);} });
}
function _rcIndexGetAll(indexName, key){
  return new Promise(function(resolve){
    try {
      const r = _rcTx(RECOGNITION_STORE,'readonly').index(indexName).getAll(key);
      r.onsuccess = function(){ resolve(r.result || []); };
      r.onerror   = function(){ resolve([]); };
    } catch(_) { resolve([]); }
  });
}

/* ── OCR ERROR TOLERANCE ─────────────────────────────────────────────────── */
// Bounded on purpose. These are the confusions a segmentation-based OCR
// actually makes on card fonts; the list is NOT a general edit-distance, so
// unrelated cards cannot become strong candidates.
const RC_OCR_CONFUSIONS = { '0':'O','O':'0','1':'I','I':'1','L':'1','5':'S','S':'5','6':'G','G':'6','8':'B','B':'8','2':'Z','Z':'2' };
function rcOcrVariants(token){
  const t = (token == null ? '' : String(token)).toUpperCase();
  if (!t || t.length > 8) return t ? [t] : [];   // bounded: no combinatorial blowup
  const out = new Set([t]);
  for (let i = 0; i < t.length; i++){
    const alt = RC_OCR_CONFUSIONS[t[i]];
    if (alt) out.add(t.slice(0,i) + alt + t.slice(i+1));   // ONE substitution only
  }
  return [...out];
}
function rcNameCloseness(a, b){
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (b.startsWith(a) || a.startsWith(b)) return 0.8;
  const at = a.split(' '), bt = b.split(' ');
  const shared = at.filter(function(x){ return bt.includes(x); }).length;
  if (!shared) return 0;
  return Math.min(0.7, shared / Math.max(at.length, bt.length));
}

/* ── CANDIDATE GENERATION + EXPLAINABLE RANKING ──────────────────────────── */
// Weights encode ONE rule: exact structured evidence outranks fuzzy evidence.
// A fuzzy name can never outweigh an exact number+denominator+set agreement.
const RC_EVIDENCE = {
  numberExact:      40,
  denominatorExact: 25,
  setExact:         30,
  nameExact:        30,
  languageExact:    10,
  hpExact:          10,
  numberOcrVariant: 15,   // deliberately < numberExact
  nameClose:        18,   // deliberately < nameExact
  variantExact:      5
};

async function findRecognitionCandidates(query, opts){
  const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  const q = query || {};
  const limit = (opts && opts.limit) || 20;

  await rcOpen();
  if (!_rcOK) return { candidates:[], ms:0, unavailable:true };

  const num   = rcNormalizeNumber(q.number);
  const nName = rcNormalizeName(q.name);
  const setId = rcNormalizeSetId(q.setId);
  const lang  = q.language == null ? '' : rcNormalizeLanguage(q.language);

  // Narrow via INDEXES — never a full scan when an index can answer.
  const pool = new Map();
  const add  = function(rows){ (rows||[]).forEach(function(r){ if(r && r._key) pool.set(r._key, r); }); };

  if (num.number && setId)      add(await _rcIndexGetAll('bySetNumber', [setId, num.number]));
  if (num.number && nName)      add(await _rcIndexGetAll('byNameNumber', [nName, num.number]));
  if (num.number)               add(await _rcIndexGetAll('byNumber', num.number));
  if (nName)                    add(await _rcIndexGetAll('byNormalizedName', nName));
  if (q.cardId)                 add(await _rcIndexGetAll('byCardId', String(q.cardId)));
  // OCR fallback ONLY when exact lookups found nothing — keeps the common path fast
  // and stops misread-tolerance from polluting good results.
  if (pool.size === 0 && num.number){
    const vars = rcOcrVariants(num.number);
    for (const v of vars){ if (v !== num.number) add(await _rcIndexGetAll('byNumber', v)); }
  }
  if (pool.size === 0 && nName){
    const first = nName.split(' ')[0];
    if (first && first.length >= 3) add(await _rcIndexGetAll('byNormalizedName', nName));
  }

  const scored = [];
  pool.forEach(function(rec){
    let score = 0; const evidence = [];
    if (num.number && rec.number === num.number){ score += RC_EVIDENCE.numberExact; evidence.push('collector number exact'); }
    else if (num.number && rcOcrVariants(num.number).includes(rec.number)){ score += RC_EVIDENCE.numberOcrVariant; evidence.push('collector number matches an OCR-confusable variant'); }
    if (num.hasDenominator && rec.denominator && rec.denominator === num.denominator){ score += RC_EVIDENCE.denominatorExact; evidence.push('denominator exact'); }
    if (setId && rec.setId === setId){ score += RC_EVIDENCE.setExact; evidence.push('set exact'); }
    if (nName && rec.normalizedName === nName){ score += RC_EVIDENCE.nameExact; evidence.push('name exact'); }
    else if (nName){
      const close = rcNameCloseness(nName, rec.normalizedName);
      if (close > 0){ score += Math.round(RC_EVIDENCE.nameClose * close); evidence.push('name close (' + close.toFixed(2) + ')'); }
    }
    if (lang && rec.language === lang){ score += RC_EVIDENCE.languageExact; evidence.push('language exact'); }
    if (q.hp != null && q.hp !== '' && rec.hp != null && Number(q.hp) === rec.hp){ score += RC_EVIDENCE.hpExact; evidence.push('HP exact'); }
    if (q.variant && rcNormalizeVariant(q.variant) === rec.variant){ score += RC_EVIDENCE.variantExact; evidence.push('variant exact'); }
    if (score > 0) scored.push({ cardId:rec.cardId, record:rec, score, evidence });
  });

  // Deterministic ordering: score, then cardId — never arbitrary insertion order.
  scored.sort(function(a,b){ return b.score - a.score || String(a.cardId).localeCompare(String(b.cardId)); });
  const top = scored.slice(0, limit);
  const t1 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

  // ambiguous = the leader is not clearly ahead. Reported, never resolved by
  // guessing — Batch G's confidence engine turns this into CONFIRM.
  const ambiguous = top.length > 1 && (top[0].score - top[1].score) < RC_EVIDENCE.setExact;
  return { candidates: top, ms: +(t1 - t0).toFixed(2), ambiguous, poolSize: pool.size };
}
