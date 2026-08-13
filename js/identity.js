/* ════════════════════════════════════════════════════════════════════════════
   MyTCG Ledger V6 — identity.js
   ────────────────────────────────────────────────────────────────────────────
   LAYER 4 (IDENTITY). Depends on core.js only.

   OWNS — the rules that decide WHAT AN ITEM IS and WHAT MAY BE RETIRED:
     - normalization        normIdentityText/Set/Num/Grade/Edition/Cond/Lang/
                            CardId/Cert, variantToken, sealedQualifiers,
                            SEALED_TYPE_CANON, normSealedType, resolveCategory
     - profile registry     IdentityProfiles, registerIdentityProfile + the three
                            profile registrations
     - the engine           identityEngine, compareIdentity, findIdentityMatches
     - add-flow guard       dupWarnThenAdd  (WARNS ONLY - never merges or blocks)
     - deletion ledger      deletionLedger, LEDGER_VERSION, makeLedgerEntry,
                            ledgerKey, unionLedger, isDeleted, applyDeletions,
                            chooseKeeper
     - retirement + cleanup retire, runDuplicateCleanup (fold-before-drop)

   ARCHITECTURAL INVARIANT - identity performs identity work ONLY. It never
   renders and never persists. runDuplicateCleanup() returns `changed`; the CALLER
   (cleanupDuplicatesUI, still inline) decides whether to persist and redraw.
   Do not reintroduce those calls here.

   SEMANTIC INVARIANTS (contract - do not alter without a parity run):
     - A delete is the PRESENCE of a ledger entry, not the absence of a record.
     - unionLedger is monotonic: entries never disappear.
     - Suppression is id-exact. Identity NEVER deletes - it only warns.
     - A verified cert is the strongest, and only auto-safe, identity level.
     - Duplicate consolidation folds the freshest price onto the keeper BEFORE
       the stray is retired (fold-before-drop).

   OUTBOUND DEPENDENCIES:
     - core.js: showConfirm (dupWarnThenAdd only)
     - `collection`, read and reassigned AT CALL TIME by retire() /
       runDuplicateCleanup() / dupWarnThenAdd(). Declared in the main inline block,
       which loads AFTER this file; no load-time reference exists.

   LOAD-TIME EXECUTION: the three registerIdentityProfile(...) calls, and the
   deletionLedger initialiser. The registry declaration, its mutator and all
   registrations live together in this file so nothing depends on file order.
   ════════════════════════════════════════════════════════════════════════════ */

/* ════════════════════════════════════════════════════════════════════════════
   IDENTITY ENGINE — Phase 1 (pure, synchronous, deterministic, INERT)
   ----------------------------------------------------------------------------
   One engine answers "what is this record's identity?" at three separable levels
   so add/scan/sync/import/cleanup/Truth never invent their own matching logic.
     • Storage identity   — which ROW   (the record id)              — never actionable
     • Collectible/Product identity — which SKU/card                 — WARN / REVIEW only
     • Physical identity  — which exact OBJECT (verified cert)       — only AUTO-safe level
   PURE: no network, no storage writes, no record mutation, no async, no side
   effects. Frozen output. Same input → same output. Wired into NOTHING (Phase 1).
   Correctness over recall: prefer false negatives. Never fuse a legitimate 2nd copy.
   ════════════════════════════════════════════════════════════════════════════ */
const IDENTITY_VERSION = 'identity-v1';

// Action matrix (encoded as constants — callers read these; the engine never acts).
const IDENTITY_ACTIONS = Object.freeze({
  physical_verified:   'auto-safe',     // verified cert match → suppress/merge allowed
  physical_unverified: 'warn-review',   // cert present but unverified → never auto
  collectible:         'warn-review',   // same SKU → could be a legit 2nd copy → never auto
  product:             'warn-review',   // sealed SKU → never auto
  weak:                'review-only',   // loose name/set → never warn-on-add, never auto
  none:                'no-action',
});

/* ── Normalization (deterministic, conservative — when unsure, SPLIT) ────────*/
function normIdentityText(s){
  return String(s == null ? '' : s)
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')   // strip diacritics: Pokémon→Pokemon
    .toLowerCase().trim().replace(/\s+/g, ' ');
}
function normSet(s){
  const t = normIdentityText(s);
  const ALIAS = { '151':'pokemon 151', 'pokemon 151':'pokemon 151', 'sv':'scarlet violet' };
  return ALIAS[t] || t;
}
function normNum(s){
  // strip leading '#', drop the "/total" denominator; keep the printed number as-is otherwise
  return normIdentityText(s).replace(/^#/, '').split('/')[0].trim();
}
function normGrade(s){
  const t = normIdentityText(s);
  if(!t) return { grader:'', num:'', label:'' };
  const m = t.match(/^([a-z]+)\s*([0-9]+(?:\.[0-9]+)?)?/);
  const grader = m ? m[1] : t.replace(/[^a-z]/g,'');
  const num = m && m[2] ? m[2] : '';
  return { grader, num, label: (grader + (num?(' '+num):'')).trim() };
}
function normEdition(s){
  const t = normIdentityText(s);
  if(!t || t === 'unlimited') return 'unlimited';
  if(/1st|first/.test(t)) return '1st';
  if(/shadowless/.test(t)) return 'shadowless';
  return t;
}
function normCond(s){ const t = normIdentityText(s); return t || 'unspecified'; }
function normLang(s){
  const t = normIdentityText(s);
  if(!t || t === 'en' || t === 'english') return 'en';
  if(/jp|japan/.test(t)) return 'jp';
  if(/kr|korea/.test(t)) return 'kr';
  if(/de|german/.test(t)) return 'de';
  if(/fr|french/.test(t)) return 'fr';
  return t;
}
function normCardId(s){ return normIdentityText(s).replace(/\s+/g,''); }
function normCert(s){
  const digits = String(s == null ? '' : s).replace(/\D/g, '');
  return (digits && digits !== '0') ? digits : '';   // '', '0', whitespace → absent
}
function isCertVerified(c){
  // The PSA/scan enrichment pipeline (separate, async, NOT here) writes a boolean
  // `certVerified` after confirming the cert. The engine only READS it. Absent → false.
  return c && c.certVerified === true;
}
// Variant token: a reverse holo / 1st-ed / star is a DIFFERENT collectible than a plain holo.
function variantToken(c){
  const hay = normIdentityText((c && c.rarity) || '') + ' ' + normIdentityText((c && c.name) || '');
  const parts = [];
  if(/reverse/.test(hay)) parts.push('reverse');
  if(/gold star|\bstar\b|★|☆/.test(hay) || /★|☆/.test(String((c&&c.name)||''))) parts.push('star');
  if(/1st|first edition/.test(hay)) parts.push('1st');
  if(/promo/.test(hay)) parts.push('promo');
  return parts.length ? parts.sort().join('+') : 'base';
}
// Sealed special-release qualifiers (Pokémon Center exclusivity, etc.)
function sealedQualifiers(c){
  const hay = normIdentityText((c && c.name) || '') + ' ' + normIdentityText((c && c.set) || '');
  const parts = [];
  if(/pokemon center|pokemon-center/.test(hay)) parts.push('pc');
  return parts.length ? parts.sort().join('+') : 'std';
}
const SEALED_TYPE_CANON = {
  booster_box:'booster_box', booster_bundle:'booster_bundle', etb:'etb', pc_etb:'etb',
  collection_box:'collection_box', premium_collection:'premium_collection', upc:'upc',
  tin:'tin', blister:'blister', booster_pack:'booster_pack', build_battle:'build_battle', case:'case',
};
function normSealedType(s){ const t = normIdentityText(s).replace(/\s+/g,'_'); return SEALED_TYPE_CANON[t] || t || 'unknown'; }

/* ── Category resolution ─────────────────────────────────────────────────────*/
function resolveCategory(c){
  if(!c || typeof c !== 'object') return 'unknown';
  const t = normIdentityText(c.type);
  if(t === 'sealed') return 'sealed';
  // Pokémon is the default TCG card category for this app (graded + raw singles).
  return 'pokemon';
}

/* ── Profile registry (generic spine; core never changes when profiles added) ─*/
const IdentityProfiles = {};
function registerIdentityProfile(p){ if(p && p.category) IdentityProfiles[p.category] = p; return p; }

// ---- Pokémon profile (graded slabs + raw singles) ----
registerIdentityProfile({
  category: 'pokemon',
  identify(c){
    const cert = normCert(c.cert);
    const verified = isCertVerified(c);
    const grade = normGrade(c.grade);
    const edition = normEdition(c.edition);
    const variant = variantToken(c);
    const isGraded = normIdentityText(c.type) === 'graded' || !!grade.label || !!cert;

    const nf = {
      name: normIdentityText(c.name), set: normSet(c.set), num: normNum(c.num),
      cardId: normCardId(c.cardId), grade: grade.label, grader: grade.grader,
      edition, variant, cond: normCond(c.cond), cert, certVerified: verified,
      lang: normLang(c.lang || c.language),
    };
    const idPart = nf.cardId ? ('cid:' + nf.cardId)
                             : ('cs:' + nf.name + '|' + nf.set + '|' + nf.num);

    let physicalId = null, certState = 'none';
    if(cert){ physicalId = 'phys:' + (grade.grader || 'psa') + ':' + cert; certState = verified ? 'verified' : 'unverified'; }

    const collectibleId = isGraded
      ? ('col:pkmn:' + idPart + '|' + (grade.label || 'graded') + '|' + edition + '|' + variant + '|' + nf.lang)
      : ('col:pkmn:' + idPart + '|raw|' + nf.cond + '|' + edition + '|' + variant + '|' + nf.lang);

    const weakId = (nf.name) ? ('weak:' + nf.name + '|' + nf.set) : null;

    const missingFields = [];
    if(!cert) missingFields.push('cert');
    if(!nf.cardId) missingFields.push('cardId');
    if(!nf.set) missingFields.push('set');
    if(!nf.num) missingFields.push('num');
    if(isGraded && !grade.label) missingFields.push('grade');

    return { physicalId, collectibleId, productId: null, weakId, certState, normalizedFields: nf, missingFields };
  },
});

// ---- Sealed profile (identity only — NO pricing/eBay logic) ----
registerIdentityProfile({
  category: 'sealed',
  identify(c){
    const nf = {
      sealedType: normSealedType(c.type === 'sealed' ? c.sealedType || c.productType : c.type),
      name: normIdentityText(c.name), set: normSet(c.set),
      lang: normLang(c.lang || c.language), qualifiers: sealedQualifiers(c),
      edition: normEdition(c.edition),
    };
    const productId = 'prod:' + nf.sealedType + '|' + nf.set + '|' + nf.name + '|' + nf.lang + '|' + nf.qualifiers + '|' + nf.edition;
    const weakId = nf.name ? ('weak:' + nf.name + '|' + nf.set) : (nf.set ? ('weak:' + nf.sealedType + '|' + nf.set) : null);
    const missingFields = [];
    if(nf.sealedType === 'unknown') missingFields.push('sealedType');
    if(!nf.set) missingFields.push('set');
    // Sealed is fungible → never a physical identity.
    return { physicalId: null, collectibleId: productId, productId, weakId, certState: 'none', normalizedFields: nf, missingFields };
  },
});

// ---- Tiny sports STUB — proves the seam: a new profile needs ZERO core changes ----
registerIdentityProfile({
  category: 'sports',
  identify(c){
    const cert = normCert(c.cert), verified = isCertVerified(c);
    const grade = normGrade(c.grade);
    const nf = { player: normIdentityText(c.name || c.player), setYear: normIdentityText(c.set),
                 num: normNum(c.num), parallel: normIdentityText(c.parallel || ''), grade: grade.label, cert, certVerified: verified };
    let physicalId = null, certState = 'none';
    if(cert){ physicalId = 'phys:' + (grade.grader||'psa') + ':' + cert; certState = verified ? 'verified' : 'unverified'; }
    const collectibleId = 'col:sport:' + nf.player + '|' + nf.setYear + '|' + nf.num + '|' + (nf.parallel||'base') + '|' + (grade.label||'raw');
    const weakId = nf.player ? ('weak:' + nf.player + '|' + nf.setYear) : null;
    return { physicalId, collectibleId, productId: null, weakId, certState, normalizedFields: nf, missingFields: cert?[]:['cert'] };
  },
});

/* ── The engine: pure single-record identity ─────────────────────────────────*/
function identityEngine(record){
  const c = (record && typeof record === 'object') ? record : {};
  const category = resolveCategory(c);
  const profile = IdentityProfiles[category] || IdentityProfiles['pokemon'];
  const r = profile.identify(c);

  // Tier = strongest level establishable. certState distinguishes verified vs not.
  let tier, confidenceTier, confidenceScore, certVerified = (r.certState === 'verified');
  const reasons = [];
  if(r.physicalId && r.certState === 'verified'){
    tier = 'physical'; confidenceTier = 'definite'; confidenceScore = 100;
    reasons.push('verified cert present → physical identity');
  } else if(r.physicalId && r.certState === 'unverified'){
    tier = 'physical'; confidenceTier = 'strong'; confidenceScore = 80;
    reasons.push('cert present but UNVERIFIED → physical candidate, not auto-actionable');
  } else if(r.productId){
    tier = 'product';
    const full = r.missingFields.indexOf('set') === -1 && r.normalizedFields.sealedType !== 'unknown';
    confidenceTier = full ? 'strong' : 'probable';
    confidenceScore = full ? 75 : 55;
    reasons.push('sealed product identity from type+set+name+lang+qualifiers');
  } else if(r.collectibleId && (r.normalizedFields.cardId || (r.normalizedFields.set && r.normalizedFields.num))){
    tier = 'collectible';
    const viaCardId = !!r.normalizedFields.cardId;
    confidenceTier = viaCardId ? 'strong' : 'probable';
    confidenceScore = viaCardId ? 75 : 55;
    reasons.push(viaCardId ? 'collectible identity via cardId+grade/cond+edition+variant'
                           : 'collectible identity via name+set+num+grade/cond+edition+variant');
    if(!r.physicalId) reasons.push('no cert → cannot be physical → collectible is warn/review only');
  } else if(r.weakId){
    tier = 'weak'; confidenceTier = 'weak'; confidenceScore = 25;
    reasons.push('only loose name/set resolvable → review-only, never auto');
  } else {
    tier = 'unidentifiable'; confidenceTier = 'none'; confidenceScore = 0;
    reasons.push('insufficient fields to identify');
  }

  const actionKey = (tier === 'physical')
      ? (certVerified ? 'physical_verified' : 'physical_unverified')
      : (tier === 'product' ? 'product' : tier === 'collectible' ? 'collectible' : tier === 'weak' ? 'weak' : 'none');

  const evidence = Object.freeze({
    matchedOn: r.physicalId ? 'cert' : (r.collectibleId ? (r.normalizedFields.cardId ? 'cardId' : 'name+set+num') : 'name'),
    certState: r.certState,
    action: IDENTITY_ACTIONS[actionKey],
    actionKey,
  });

  return Object.freeze({
    identityVersion: IDENTITY_VERSION,
    storageId: (c.id != null ? c.id : null),
    category,
    physicalId: r.physicalId,
    collectibleId: r.collectibleId,
    productId: r.productId,
    weakId: r.weakId,
    tier,
    confidenceTier,
    confidenceScore,
    certVerified,
    reasons: Object.freeze(reasons),
    missingFields: Object.freeze(r.missingFields),
    normalizedFields: Object.freeze(r.normalizedFields),
    evidence,
  });
}

/* ── Comparison — strongest shared level between two records ──────────────────
   CRITICAL SAFETY RULE: a physical (cert) match is only AUTO-actionable when BOTH
   sides are verified. Everything else is warn/review. Never auto-fuse a 2nd copy. */
function compareIdentity(a, b){
  const ia = (a && a.identityVersion) ? a : identityEngine(a);
  const ib = (b && b.identityVersion) ? b : identityEngine(b);
  if(ia.physicalId && ia.physicalId === ib.physicalId){
    const bothVerified = ia.certVerified && ib.certVerified;
    return { level:'physical', confidenceTier: bothVerified?'definite':'strong',
             confidenceScore: bothVerified?100:80, autoActionable: bothVerified,
             action: bothVerified ? IDENTITY_ACTIONS.physical_verified : IDENTITY_ACTIONS.physical_unverified,
             reason: bothVerified ? 'verified cert match' : 'cert match but not both verified → warn/review' };
  }
  if(ia.productId && ia.productId === ib.productId)
    return { level:'product', confidenceTier:ia.confidenceTier, confidenceScore:ia.confidenceScore, autoActionable:false, action:IDENTITY_ACTIONS.product, reason:'same sealed product' };
  if(ia.collectibleId && ia.collectibleId === ib.collectibleId)
    return { level:'collectible', confidenceTier:ia.confidenceTier, confidenceScore:ia.confidenceScore, autoActionable:false, action:IDENTITY_ACTIONS.collectible, reason:'same collectible SKU — could be a legitimate 2nd copy → warn/review only' };
  if(ia.weakId && ia.weakId === ib.weakId){
    // CORRECTNESS GUARD: a weak (name+set) match is only meaningful when NEITHER side
    // resolved a stronger identity. If either side has a collectible/product/physical
    // id and they did NOT match above, the records are genuinely different cards
    // (e.g. 1st-ed vs unlimited, reverse vs holo, booster box vs bundle) — NOT a match.
    const aStrong = !!(ia.physicalId || ia.collectibleId || ia.productId);
    const bStrong = !!(ib.physicalId || ib.collectibleId || ib.productId);
    if(aStrong || bStrong)
      return { level:'none', confidenceTier:'none', confidenceScore:0, autoActionable:false, action:IDENTITY_ACTIONS.none, reason:'weak name/set overlap but stronger identities differ → different cards' };
    return { level:'weak', confidenceTier:'weak', confidenceScore:25, autoActionable:false, action:IDENTITY_ACTIONS.weak, reason:'loose name/set match — review only' };
  }
  return { level:'none', confidenceTier:'none', confidenceScore:0, autoActionable:false, action:IDENTITY_ACTIONS.none, reason:'no shared identity' };
}

// Find all records in `list` that share some identity level with `record` (excludes self by id).
function findIdentityMatches(record, list){
  const me = identityEngine(record);
  const out = [];
  for(const other of (list || [])){
    if(other === record) continue;
    if(other && record && other.id != null && other.id === record.id) continue;
    const cmp = compareIdentity(me, identityEngine(other));
    if(cmp.level !== 'none') out.push({ record: other, ...cmp });
  }
  // strongest first
  const rank = { physical:4, product:3, collectible:2, weak:1, none:0 };
  out.sort((x,y)=> (rank[y.level]-rank[x.level]) || (y.confidenceScore-x.confidenceScore));
  return out;
}

/* ═══════════════ end Identity Engine — Phase 1 ═══════════════ */

/* ─── Guard 1: add-flow duplicate warning (uses the Identity Engine) ─────────
   Before a NEW card is added (never on edit, never on deals), check the existing
   collection for an identity match. No match → proceed silently (zero change).
   Match → warn and let the user add anyway or cancel. Auto action is NEVER taken
   here — collectible/physical matches only WARN; nothing is merged or blocked. */
function dupWarnThenAdd(card, proceed){
  let matches = [];
  try { matches = findIdentityMatches(card, collection); } catch(e){ matches = []; }
  if(!matches.length){ proceed(); return; }
  const top = matches[0];
  const existing = top.record || {};
  const label = (card.name || 'This card') + (card.grade ? (' ' + card.grade) : '');
  const where = (top.level === 'physical')
    ? 'the exact same graded card (matching cert) is already in your collection'
    : (top.level === 'product')
      ? 'the same sealed product is already in your collection'
      : 'a card that looks the same is already in your collection';
  showConfirm(
    'Possible duplicate',
    `${label}: ${where}` + (existing.name ? ` (existing: ${existing.name}${existing.set ? ' · ' + existing.set : ''}).` : '.') + ' Add another copy anyway?',
    () => proceed()
  );
}

/* ════════════════════════════════════════════════════════════════════════════
   DELETION LEDGER — core primitives (pure, additive, INERT when ledger empty)
   A delete is the PRESENCE of a ledger entry, not the absence of a record.
   Suppression is id-exact (identity NEVER deletes — it only warns). Monotonic
   (union, never shrinks), forever (no GC), generic over entityType.
   ════════════════════════════════════════════════════════════════════════════ */
let deletionLedger = [];
const LEDGER_VERSION = 'ledger-v2';
function makeLedgerEntry(entityType, entityId, opts){
  opts = opts || {};
  return Object.freeze({
    entityType: String(entityType||''),
    entityId:   (entityId!=null ? String(entityId) : ''),
    identityKey: opts.identityKey || null,
    reason:     opts.reason || 'user-delete',
    mergedInto: opts.mergedInto || null,
    retiredAt:  opts.retiredAt || new Date().toISOString(),
    version:    LEDGER_VERSION,
  });
}
function ledgerKey(e){ return (e && e.entityType + '|' + e.entityId) || ''; }
function unionLedger(a, b){
  const map = new Map();
  const add = (e) => {
    if(!e || e.entityId==null || e.entityId==='') return;
    const k = ledgerKey(e), prev = map.get(k);
    if(!prev) map.set(k, e);
    else if(String(e.retiredAt) < String(prev.retiredAt)) map.set(k, e);   // earliest wins
  };
  (a||[]).forEach(add); (b||[]).forEach(add);
  return [...map.values()];
}
function isDeleted(ledger, entityType, id){
  if(id==null) return false;
  const k = entityType + '|' + String(id);
  return (ledger||[]).some(e => ledgerKey(e) === k);
}
// Generic suppression with FOLD-BEFORE-DROP. Returns the SAME array reference when
// inert (no entries for this entityType) → byte-identical merge output when empty.
function applyDeletions(list, ledger, entityType){
  if(!Array.isArray(list) || !list.length) return list || [];
  const dead = new Map();
  for(const e of (ledger||[])) if(e && e.entityType===entityType) dead.set(String(e.entityId), e);
  if(dead.size===0) return list;
  const byId = new Map();
  for(const r of list) if(r && r.id!=null) byId.set(String(r.id), r);
  for(const r of list){
    if(!r || r.id==null) continue;
    const e = dead.get(String(r.id));
    if(e && e.mergedInto){
      const keeper = byId.get(String(e.mergedInto));
      if(keeper && (r.lastPricedAt||0) > (keeper.lastPricedAt||0)){
        keeper.lastMarketValue     = r.lastMarketValue;
        keeper.lastPricedAt        = r.lastPricedAt;
        keeper.lastPriceConfidence = r.lastPriceConfidence;
        keeper.lastPriceSource     = r.lastPriceSource;
      }
    }
  }
  return list.filter(r => !(r && r.id!=null && dead.has(String(r.id))));
}
// Deterministic keeper: pure fn of identity-stable fields → concurrent cleanups
// on different devices pick the SAME keeper (can't annihilate a card).
function chooseKeeper(records){
  if(!records || !records.length) return null;
  return [...records].sort((x,y)=>{
    const ax=String(x.id||''), ay=String(y.id||'');
    if(ax!==ay) return ax<ay?-1:1;
    const dx=String(x.added||''), dy=String(y.added||'');
    if(dx!==dy) return dx<dy?-1:1;
    return 0;
  })[0];
}
/* ═══════════════ end Deletion Ledger ═══════════════ */

/* ─── retire(): the deletion path — appends a ledger entry, removes the record
   locally, saves (which syncs the ledger up). The reusable delete primitive. ─── */
function retire(entityType, id, opts){
  if(id==null) return false;
  opts = opts || {};
  deletionLedger = unionLedger(deletionLedger, [makeLedgerEntry(entityType, id, opts)]);
  if(entityType === 'card' && Array.isArray(collection)){
    collection = collection.filter(c => !(c && String(c.id) === String(id)));
  }
  return true;
}

/* ─── runDuplicateCleanup(): one-shot, deliberate (NOT auto-run). Recomputes the
   plan live with the deterministic keeper, folds the best/newest price onto each
   keeper, retires the strays via retire(). Safe to re-run: it no-ops when no
   identity duplicates remain. Returns a before/after report.

   ARCHITECTURAL INVARIANT: identity/cleanup performs identity work ONLY. It used
   to call save() + renderAll() itself, which made the identity subsystem depend on
   persistence AND the UI — the last edge stopping identity.js from being extracted
   standalone. It now reports `changed` in its result and the CALLER decides whether
   to persist and redraw. Detection, tiers, cert matching, keeper choice,
   fold-before-drop and ledger semantics are all unchanged. ─── */
function runDuplicateCleanup(opts){
  opts = opts || {};
  const dryRun = !!opts.dryRun;
  const groups = {};
  collection.forEach(c => { const k = identityEngine(c).collectibleId; (groups[k] ??= []).push(c); });
  const before = collection.reduce((s,c)=>s+((typeof c.lastMarketValue==='number')?c.lastMarketValue:0),0);
  const actions = [];
  for(const k in groups){
    const recs = groups[k];
    if(recs.length < 2) continue;
    const keeper = chooseKeeper(recs);
    const strays = recs.filter(r => r.id !== keeper.id);
    // fold best/newest price onto keeper
    const priced = recs.filter(r=>r.lastPricedAt).sort((a,b)=>(b.lastPricedAt||0)-(a.lastPricedAt||0));
    const best = priced[0];
    if(!dryRun && best && (best.lastPricedAt||0) > (keeper.lastPricedAt||0)){
      keeper.lastMarketValue=best.lastMarketValue; keeper.lastPricedAt=best.lastPricedAt;
      keeper.lastPriceConfidence=best.lastPriceConfidence; keeper.lastPriceSource=best.lastPriceSource;
    }
    actions.push({ group:(keeper.name||'')+' '+(keeper.set||'')+' '+(keeper.grade||''), keeperId:keeper.id, retireIds:strays.map(s=>s.id) });
    if(!dryRun){
      strays.forEach(s => retire('card', s.id, { reason:'duplicate-cleanup', mergedInto:keeper.id, identityKey:k }));
    }
  }
  const after = collection.reduce((s,c)=>s+((typeof c.lastMarketValue==='number')?c.lastMarketValue:0),0);
  const report = { groups:actions.length, retired:actions.reduce((s,a)=>s+a.retireIds.length,0),
                   before:+before.toFixed(2), after:+after.toFixed(2), removed:+(before-after).toFixed(2),
                   records:collection.length, dryRun, actions,
                   // true when the collection was actually modified — the caller's
                   // signal to persist and redraw. Always false for a dry run.
                   changed: !dryRun && actions.length > 0 };
  try { console.log('[cleanup]', JSON.stringify(report)); } catch(e){}
  return report;
}
