/* ════════════════════════════════════════════════════════════════════════════
   MyTCG Ledger V6 - sealed.js
   ────────────────────────────────────────────────────────────────────────────
   DOMAIN MODULE (sealed products). The first non-infrastructure extraction.

   OWNS - everything specific to a sealed PRODUCT:
     - catalogue      SEALED_TYPES, SEALED_CATALOG
     - image resolver SEALED_IMAGE_BASE/_CATEGORIES/_TYPE_TO_CATEGORY/
                      _CATEGORY_FALLBACK_IMG/_GENERIC_FALLBACK_IMG/_IMAGE_CATALOG,
                      normalizeSealedName, _sealedByCanonical, _sealedByAlias,
                      _sealedImgUrl, resolveSealedImageEx, sealedImageFor,
                      debugSealedImage, resolveSealedOfficialImage
     - photo upload   _shrinkImage, uploadSealedPhoto  (Supabase Storage bucket
                      'sealed-images' - NOT the sync layer's user_app_state)
     - sealed pricing sealedPriceCache, _sealedPricesLoading, SEALED_PRICE_TTL,
                      loadSealedPrices, refreshSealedPrices  (Worker /sealed)
     - evidence/UI    _sealedConfBadge, renderSealedEvidence,
                      _syncSealedSourceButtons, setSealedValueSource,
                      openSealedDetail
     - CRUD + render  openSealedModal, selectSealedType, updateSealedPreview,
                      saveSealed, deleteSealed, renderSealed, renderSealedSets,
                      filterSealedSets, selectSealedSet, clearSealedSetFilter,
                      renderSealedQuickAdd, quickAddSealed

   DOES NOT OWN - deliberately left where they were:
     - sealedEffectiveValue / sealedValueSource  -> valuation.js. They are read by
       AppState, the portfolio, the dashboard and the inventory panel, so they are
       portfolio-valuation vocabulary, not sealed-domain internals.
     - buildSealedQuery + the sealed CategoryProfile -> part of the dormant
       Universal Valuation Engine, which must move as ONE unit in a later batch.
     - generic pricing acquisition (pricing.js), storage primitives (storage.js),
       the modal framework, navigation, and every portfolio/dashboard renderer
       that merely happens to include sealed totals.

   OUTBOUND DEPENDENCIES (all CALL-time; nothing but declarations run at load):
     - core       esc, money, moneyFull, toast, openModal, showConfirm, newId
     - valuation  sealedEffectiveValue, sealedValueSource
     - identity   retire('sealed', id)  - deleteSealed() MUST write a deletion
                  tombstone or the product resurrects on the next cloud merge
     - storage    save
     - inline     sealed (the state array it mutates), allSets, sealedFilter,
                  sealedSetFilter, editingSealedId, EBAY_WORKER, supa/currentUser
                  (photo upload only), buildSealedQuery, renderPortfolio,
                  AppState, and the shared #detail-modal / #sealed-modal markup.

   LOAD-TIME EXECUTION: the const/let declarations plus ONE IIFE,
   _indexSealedCatalog(), which builds the canonical/alias lookup maps from
   SEALED_IMAGE_CATALOG declared directly above it. No network, no persistence,
   no render - identical to its previous inline position.
   ════════════════════════════════════════════════════════════════════════════ */


// ════════════════════════════════════════════════════════════════════════════
// ── SEALED TYPES + QUICK-ADD CATALOGUE ──
// ════════════════════════════════════════════════════════════════════════════
const SEALED_TYPES={
  booster_box:{label:'Booster Box',icon:'📦'},etb:{label:'Elite Trainer Box',icon:'🎁'},
  tin:{label:'Tin',icon:'🥫'},blister:{label:'Blister Pack',icon:'💊'},
  bundle:{label:'Bundle',icon:'🎀'},other:{label:'Other',icon:'📫'},
};
const SEALED_CATALOG=[
  {type:'booster_box',label:'Booster Box',icon:'📦',suffix:'Booster Box',note:'36 packs'},
  {type:'etb',label:'Elite Trainer Box',icon:'🎁',suffix:'Elite Trainer Box',note:'8 packs'},
  {type:'etb',label:'Premium Trainer Box',icon:'🎁',suffix:'Premium Trainer Box',note:'Premium'},
  {type:'bundle',label:'Booster Bundle',icon:'🎀',suffix:'Booster Bundle',note:'6 packs'},
  {type:'tin',label:'Tin',icon:'🥫',suffix:'Tin',note:'3 packs + promo'},
  {type:'blister',label:'3-Pack Blister',icon:'💊',suffix:'3 Pack Blister',note:'3 packs'},
  {type:'other',label:'Collection Box',icon:'📫',suffix:'Collection Box',note:'Packs + promos'},
  {type:'other',label:'Special Collection',icon:'📫',suffix:'Special Collection',note:'Packs + promos'},
];

/* ════════════════════════════════════════════════════════════════════════════
   SEALED PRODUCT IMAGE CATALOG — production framework (fully local, no API).
   Resolves sealed product images from our OWN catalog. No scraping, no live
   third-party image APIs. Works even when image files are missing (status flag).
   ────────────────────────────────────────────────────────────────────────────
   RESOLUTION PRIORITY (see resolveSealedImage):
     1. Manual image URL (item.imgManual + item.img) — ALWAYS wins.
     2. Exact canonicalName match.
     3. Alias match.
     4. Normalized product-name match.
     5. Category fallback image.
     6. Generic sealed fallback image.
   ────────────────────────────────────────────────────────────────────────────
   FOLDER STRUCTURE (ship images under /public so they deploy with the app):
     /images/sealed/booster-box/        /images/sealed/etb/
     /images/sealed/pc-etb/             /images/sealed/booster-bundle/
     /images/sealed/upc/                /images/sealed/collection-box/
     /images/sealed/premium-collection/ /images/sealed/tin/
     /images/sealed/mini-tin/           /images/sealed/build-battle/
     /images/sealed/build-battle-stadium/ /images/sealed/blister/
     /images/sealed/fallback/           ← category + generic fallbacks
   ────────────────────────────────────────────────────────────────────────────
   HOW TO ADD A NEW PRODUCT (see SEALED_IMAGE_CATALOG below):
     • Add an entry object with id, canonicalName, category, setName, era,
       imagePath, aliases[], status, sourceNotes.
     • canonicalName is the human name; the resolver normalizes it for matching.
     • imagePath follows the folder structure, e.g.
         /images/sealed/booster-box/phantasmal-flames-booster-box.webp
     • Name the image file as the normalized canonicalName + .webp.
     • status: 'available' once the file exists, else 'missing' (resolver will
       fall back to a category/generic image so nothing breaks).
   HOW ALIASES WORK:
     • aliases[] are alternate names users might type ("sv151", "151 bundle").
       They are normalized and matched the same way as canonicalName.
   MOVING TO CLOUDFLARE R2 LATER:
     • Keep imagePath values relative ('/images/sealed/...'). When you move to
       R2, set SEALED_IMAGE_BASE to your R2 public URL (e.g.
       'https://cdn.mytcgledger.com') and every path resolves to R2 with no
       per-entry edits. Leave '' to serve from your own /public deploy.
   ════════════════════════════════════════════════════════════════════════════ */

// Prefix for all catalog image paths. '' = serve from app's /public folder.
// Set to an R2/CDN base later (no trailing slash) to migrate without edits.
const SEALED_IMAGE_BASE = '';

// Supported categories (used for fallbacks + validation).
const SEALED_CATEGORIES = [
  'booster-box','etb','pc-etb','booster-bundle','upc','collection-box',
  'premium-collection','tin','mini-tin','build-battle','build-battle-stadium',
  'checklane-blister','three-pack-blister','blister','other'
];

// Map the app's internal `type` values → catalog category keys (tolerant).
const SEALED_TYPE_TO_CATEGORY = {
  booster_box:'booster-box', etb:'etb', bundle:'booster-bundle',
  blister:'blister', tin:'tin', other:'collection-box',
};

// Normalize a product name for matching:
// lowercase · & → "and" · strip punctuation · collapse spaces · trim · spaces→hyphens
function normalizeSealedName(s){
  return String(s||'')
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')   // strip accents (é→e, ó→o)
    .toLowerCase()
    .replace(/&/g,' and ')
    .replace(/[^a-z0-9\s]/g,' ')   // strip punctuation/specials
    .replace(/\s+/g,' ')           // collapse duplicate spaces
    .trim()
    .replace(/\s/g,'-');           // spaces → hyphens
}

// Category fallback images. Files live under /images/sealed/fallback/.
// Safe even if the files don't exist yet (img onerror hides → emoji shows).
const SEALED_CATEGORY_FALLBACK_IMG = {
  'booster-box':           '/images/sealed/fallback/booster-box.webp',
  'etb':                   '/images/sealed/fallback/etb.webp',
  'pc-etb':                '/images/sealed/fallback/pc-etb.webp',
  'booster-bundle':        '/images/sealed/fallback/booster-bundle.webp',
  'upc':                   '/images/sealed/fallback/upc.webp',
  'collection-box':        '/images/sealed/fallback/collection-box.webp',
  'premium-collection':    '/images/sealed/fallback/premium-collection.webp',
  'tin':                   '/images/sealed/fallback/tin.webp',
  'mini-tin':              '/images/sealed/fallback/mini-tin.webp',
  'build-battle':          '/images/sealed/fallback/build-battle.webp',
  'build-battle-stadium':  '/images/sealed/fallback/build-battle-stadium.webp',
  'checklane-blister':     '/images/sealed/fallback/blister.webp',
  'three-pack-blister':    '/images/sealed/fallback/blister.webp',
  'blister':               '/images/sealed/fallback/blister.webp',
  'other':                 '/images/sealed/fallback/generic-sealed.webp',
};
const SEALED_GENERIC_FALLBACK_IMG = '/images/sealed/fallback/generic-sealed.webp';

/* ─── THE CATALOG. Add new sealed products here. ────────────────────────────
   Each entry:
     id           unique slug (normalized canonicalName)
     canonicalName human-readable product name
     category      one of SEALED_CATEGORIES
     setName       the set/expansion
     era           rough era grouping (e.g. 'Scarlet & Violet', 'Sword & Shield')
     imagePath     /images/sealed/<category>/<file>.webp
     aliases       alternate names users might type (normalized at match time)
     status        'available' (file exists) | 'missing' (use fallback)
     sourceNotes   where the art came from / licensing note
   ─────────────────────────────────────────────────────────────────────────── */
const SEALED_IMAGE_CATALOG = [
  {
    id:'scarlet-and-violet-151-booster-bundle',
    canonicalName:'Scarlet & Violet 151 Booster Bundle',
    category:'booster-bundle', setName:'151', era:'Scarlet & Violet',
    imagePath:'/images/sealed/booster-bundle/sv151-booster-bundle.webp',
    aliases:['sv151 booster bundle','151 booster bundle','sv 151 bundle'],
    status:'missing', sourceNotes:'placeholder — add official product image'
  },
  {
    id:'prismatic-evolutions-super-premium-collection',
    canonicalName:'Prismatic Evolutions Super Premium Collection',
    category:'premium-collection', setName:'Prismatic Evolutions', era:'Scarlet & Violet',
    imagePath:'/images/sealed/premium-collection/prismatic-evolutions-super-premium-collection.webp',
    aliases:['prismatic evolutions spc','prismatic spc','prismatic super premium'],
    status:'missing', sourceNotes:'placeholder — add official product image'
  },
  {
    id:'surging-sparks-booster-box',
    canonicalName:'Surging Sparks Booster Box',
    category:'booster-box', setName:'Surging Sparks', era:'Scarlet & Violet',
    imagePath:'/images/sealed/booster-box/surging-sparks-booster-box.webp',
    aliases:['surging sparks bb'],
    status:'missing', sourceNotes:'placeholder — add official product image'
  },
  {
    id:'crown-zenith-elite-trainer-box',
    canonicalName:'Crown Zenith Elite Trainer Box',
    category:'etb', setName:'Crown Zenith', era:'Sword & Shield',
    imagePath:'/images/sealed/etb/crown-zenith-elite-trainer-box.webp',
    aliases:['crown zenith etb','cz etb'],
    status:'missing', sourceNotes:'placeholder — add official product image'
  },
  {
    id:'obsidian-flames-elite-trainer-box',
    canonicalName:'Obsidian Flames Elite Trainer Box',
    category:'etb', setName:'Obsidian Flames', era:'Scarlet & Violet',
    imagePath:'/images/sealed/etb/obsidian-flames-elite-trainer-box.webp',
    aliases:['obsidian flames etb','obf etb'],
    status:'missing', sourceNotes:'placeholder — add official product image'
  },
  {
    id:'arceus-vstar-ultra-premium-collection',
    canonicalName:'Arceus VSTAR Ultra-Premium Collection',
    category:'upc', setName:'Brilliant Stars', era:'Sword & Shield',
    imagePath:'/images/sealed/upc/arceus-vstar-ultra-premium-collection.webp',
    aliases:['arceus vstar upc','arceus upc','arceus ultra premium'],
    status:'missing', sourceNotes:'placeholder — add official product image'
  },
  {
    id:'phantasmal-flames-booster-box',
    canonicalName:'Phantasmal Flames Booster Box',
    category:'booster-box', setName:'Phantasmal Flames', era:'Mega Evolution',
    imagePath:'/images/sealed/booster-box/phantasmal-flames-booster-box.webp',
    aliases:['phantasmal flames bb','me02 booster box','phantasmal flames booster'],
    status:'missing', sourceNotes:'placeholder — add official product image'
  },
  // ⬇⬇⬇ ADD NEW SEALED PRODUCTS BELOW (copy an entry above as a template) ⬇⬇⬇

  // ⬆⬆⬆ ADD NEW SEALED PRODUCTS ABOVE ⬆⬆⬆
];

// Build fast lookup indexes once (canonical + alias → entry).
const _sealedByCanonical = {};
const _sealedByAlias = {};
(function _indexSealedCatalog(){
  try{
    for(const e of SEALED_IMAGE_CATALOG){
      if(!e) continue;
      const cn = normalizeSealedName(e.canonicalName||e.id||'');
      if(cn) _sealedByCanonical[cn] = e;
      const al = Array.isArray(e.aliases) ? e.aliases : [];
      for(const a of al){ const na = normalizeSealedName(a); if(na) _sealedByAlias[na] = e; }
    }
  }catch(_){}
})();

// Apply the base prefix (for future R2 migration) to a path. Safe on null.
function _sealedImgUrl(path){
  if(!path) return '';
  if(/^https?:\/\//i.test(path)) return path;     // already absolute
  return (SEALED_IMAGE_BASE||'') + path;
}

/* Resolve the best image for a sealed item. Pure, synchronous, never throws.
   Returns { url, method } — method ∈ manual|canonical|alias|normalized|
   category-fallback|generic-fallback. Caller may show emoji if url is ''. */
function resolveSealedImageEx(item){
  try{
    item = item || {};
    // 1) Manual image URL always wins.
    if(item.imgManual && item.img) return { url:item.img, method:'manual' };
    // legacy manual images (set before imgManual flag existed) still honored
    if(item.img && item.imgManual!==false && !item._catalogImg && /^https?:\/\//i.test(item.img))
      return { url:item.img, method:'manual' };

    const key = normalizeSealedName(item.name);


    // 2) exact canonicalName match (local static catalog)
    if(key && _sealedByCanonical[key]){
      const e = _sealedByCanonical[key];
      if(e.imagePath) return { url:_sealedImgUrl(e.imagePath), method:'canonical' };
    }
    // 3) alias match
    if(key && _sealedByAlias[key]){
      const e = _sealedByAlias[key];
      if(e.imagePath) return { url:_sealedImgUrl(e.imagePath), method:'alias' };
    }
    // 4) normalized fuzzy match (key contains / contained by a canonical key)
    if(key){
      for(const ck in _sealedByCanonical){
        if(ck===key) continue;
        if(ck.includes(key) || key.includes(ck)){
          const e = _sealedByCanonical[ck];
          if(e.imagePath) return { url:_sealedImgUrl(e.imagePath), method:'normalized' };
        }
      }
    }
    // 5) category fallback
    const cat = SEALED_TYPE_TO_CATEGORY[item.type] || (SEALED_CATEGORIES.indexOf(item.type)>=0 ? item.type : 'other');
    if(SEALED_CATEGORY_FALLBACK_IMG[cat])
      return { url:_sealedImgUrl(SEALED_CATEGORY_FALLBACK_IMG[cat]), method:'category-fallback' };
    // 6) generic fallback
    return { url:_sealedImgUrl(SEALED_GENERIC_FALLBACK_IMG), method:'generic-fallback' };
  }catch(_){
    // never throw — always return a valid generic fallback
    return { url:_sealedImgUrl(SEALED_GENERIC_FALLBACK_IMG), method:'generic-fallback' };
  }
}

// Thin wrapper used by the UI: returns just the URL string.
function sealedImageFor(item){ return resolveSealedImageEx(item).url; }

/* DEBUG HELPER (development only). Logs name, normalized name, resolved path,
   and which method produced it. Call from the console: debugSealedImage(item)
   or debugSealedImage('Phantasmal Flames Booster Box'). */
function debugSealedImage(itemOrName){
  const item = (typeof itemOrName==='string') ? { name:itemOrName } : (itemOrName||{});
  const r = resolveSealedImageEx(item);
  const out = { product:item.name||'(none)', normalized:normalizeSealedName(item.name), resolvedPath:r.url||'(empty)', method:r.method };
  try{ console.table ? console.table(out) : console.log(out); }catch(_){ console.log(out); }
  return out;
}

/* ─── Rich sealed DETAIL view (read-first). Opens in the shared detail-modal.
   Hero image · big value + confidence + source · P&L · full pricing evidence ·
   product details · actions (Edit / TCGPlayer / eBay / Refresh / Delete). ─── */
function openSealedDetail(id){
  const p = sealed.find(s=>s.id===id);
  if(!p){ return; }
  const c = sealedPriceCache[p.id] || null;
  const val = sealedEffectiveValue(p);
  const vsrc = sealedValueSource(p);
  const paid = parseFloat(p.paid||0);
  const qty = p.qty||1;
  const info = (typeof SEALED_TYPES!=='undefined' && SEALED_TYPES[p.type]) || {icon:'📦',label:p.type||'Sealed'};
  const totalVal = val*qty, totalPaid = paid*qty;
  const roi = (val>0&&paid>0) ? totalVal-totalPaid : null;
  const roiPct = (roi!=null&&totalPaid>0) ? ((roi/totalPaid)*100).toFixed(1) : null;
  const mv = c ? c.marketValue : (typeof p.marketValue==='number'?p.marketValue:null);
  const low = c?c.low:p.marketLow, high = c?c.high:p.marketHigh;
  const conf = (c?c.confidence:p.lastPriceConfidence)||'';
  const source = (c?c.source:p.lastPriceSource)||'';
  const acc = c?c.acceptedCount:p.compCount, rej = c?c.rejectedCount:p.rejectedCount;
  const disp = c?c.dispersion:null, recency = c?c.recencyDays:null;
  const when = c?c.lastPricedAt:p.lastPricedAt;
  const isAsking = /browse/i.test(source);
  const sourceLbl = isAsking ? 'Active listings (asking)' : (/sold/i.test(source) ? 'Recent solds' : (source||'—'));
  const whenStr = when ? (typeof when==='number' ? new Date(when).toLocaleDateString() : new Date(Date.parse(when)||Date.now()).toLocaleDateString()) : '';
  const tcgQ = encodeURIComponent(p.name+(p.set?' '+p.set:''));
  const ebayQ = encodeURIComponent(p.name+(p.set?' '+p.set:'')+' sealed');
  const _sealedImg = sealedImageFor(p);
  const img = _sealedImg ? `<img src="${esc(_sealedImg)}" alt="${esc(p.name)}" loading="lazy" style="width:100%;height:100%;object-fit:cover;" onerror="this.style.display='none'">` : '';
  const row = (lbl,v,col) => `<div style="display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid var(--border);font-size:12.5px;"><span style="color:var(--muted2);">${lbl}</span><span style="font-family:var(--mono);${col?`color:${col};`:''}text-align:right;">${v}</span></div>`;

  document.getElementById('detail-inner').innerHTML = `
    <div class="modal-hd"><h2 style="font-size:18px;">${esc(p.name)}</h2><button class="modal-close" onclick="closeModal('detail-modal')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:18px;height:18px"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></div>
    <div class="modal-body">
      <div style="display:flex;gap:16px;margin-bottom:18px;align-items:flex-start;">
        <div style="width:128px;height:128px;flex-shrink:0;border-radius:12px;overflow:hidden;background:var(--bg3);display:flex;align-items:center;justify-content:center;font-size:54px;position:relative;">
          <span style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;">${info.icon}</span>${img}
        </div>
        <div style="flex:1;min-width:0;">
          <div style="display:flex;gap:5px;flex-wrap:wrap;margin-bottom:8px;">
            <span class="ct-badge type-standard">${info.label}</span>
            <span class="ct-badge" style="background:${p.cond==='sealed'?'rgba(46,204,128,.18)':'rgba(255,140,66,.18)'};color:${p.cond==='sealed'?'#4ade80':'var(--orange)'};">${p.cond==='sealed'?'SEALED':(p.cond||'').toUpperCase()}</span>
            ${p.lang&&p.lang!=='EN'?`<span class="ct-badge type-reverse">${esc(p.lang)}</span>`:''}
            ${qty>1?`<span class="ct-badge" style="background:var(--bg4);color:var(--muted);">×${qty}</span>`:''}
          </div>
          <div style="font-size:11px;color:var(--muted2);margin-bottom:6px;">${esc(p.set||'')}</div>
          <div style="display:flex;align-items:baseline;gap:9px;flex-wrap:wrap;">
            <span style="font-family:var(--disp);font-size:26px;font-weight:800;color:var(--green);">${val>0?money(totalVal):'—'}</span>
            ${val>0?`<span style="font-size:9px;font-weight:700;padding:2px 6px;border-radius:5px;background:${vsrc==='market'?'rgba(46,204,128,.16)':'rgba(245,200,66,.16)'};color:${vsrc==='market'?'var(--green)':'var(--gold)'};">${vsrc==='market'?'LIVE':'MANUAL'}</span>`:''}
          </div>
          ${qty>1&&val>0?`<div style="font-size:10.5px;color:var(--muted);margin-top:1px;">${money(val)} each</div>`:''}
          ${roi!=null?`<div style="font-size:13px;font-weight:600;margin-top:5px;color:${roi>=0?'var(--green)':'var(--red)'};">${roi>=0?'▲':'▼'} ${money(Math.abs(roi))} (${roiPct}%)</div>`:''}
        </div>
      </div>

      ${mv!=null?`
      <div style="background:var(--bg3);border-radius:var(--r2);padding:13px 15px;margin-bottom:14px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
          <span style="font-family:var(--mono);font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:1.5px;">Market Evidence</span>
          ${_sealedConfBadge(conf)}
        </div>
        ${row('Market estimate', money(mv)+(whenStr?` <span style="color:var(--muted);font-size:10px;">· ${whenStr}</span>`:''), 'var(--green)')}
        ${(low!=null&&high!=null)?row('Range (10–90%)', `${money(low)} – ${money(high)}`):''}
        ${(acc!=null)?row('Comps used', `${acc} accepted${rej!=null?` · ${rej} filtered`:''}`):''}
        ${(disp!=null)?row('Spread', (disp*100).toFixed(0)+'%'):''}
        ${(recency!=null)?row('Sold window', recency+' days'):''}
        <div style="display:flex;justify-content:space-between;align-items:center;padding:7px 0 0;font-size:12.5px;"><span style="color:var(--muted2);">Source</span><span style="color:${isAsking?'var(--orange)':'var(--green)'};text-align:right;font-size:11.5px;">${sourceLbl}</span></div>
        ${isAsking?`<div style="font-size:10px;color:var(--orange);line-height:1.4;border-top:1px solid var(--border);margin-top:8px;padding-top:8px;">⚠ Based on current asking prices, not confirmed sales — a market ceiling, not a sold value.</div>`:''}
      </div>`:`
      <div style="background:var(--bg3);border-radius:var(--r2);padding:13px 15px;margin-bottom:14px;font-size:12px;color:var(--muted);">
        No market data yet. <span onclick="closeModal('detail-modal');refreshSealedPrices()" style="color:var(--gold);cursor:pointer;">Refresh prices</span> or set a manual value via Edit.
      </div>`}

      <div style="margin-bottom:16px;">
        <div style="font-family:var(--mono);font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:1.5px;margin-bottom:4px;">Details</div>
        ${row('Set', esc(p.set||'—'))}
        ${row('Type', info.label)}
        ${row('Condition', p.cond==='sealed'?'Factory Sealed':esc(p.cond||'—'))}
        ${row('Language', esc(p.lang||'EN'))}
        ${row('Quantity', String(qty))}
        ${paid>0?row('Paid', money(paid)+(qty>1?` (${money(totalPaid)} total)`:'')):''}
        ${p.date?row('Purchase date', new Date(Date.parse(p.date)||Date.now()).toLocaleDateString()):''}
        ${p.added?row('Added', new Date(Date.parse(p.added)||Date.now()).toLocaleDateString()):''}
        ${p.notes?`<div style="padding:8px 0;font-size:12px;color:var(--muted2);"><span style="color:var(--muted);">Notes:</span> ${esc(p.notes)}</div>`:''}
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px;">
        <a href="https://www.tcgplayer.com/search/pokemon/product?q=${tcgQ}" target="_blank" class="btn btn-ghost btn-sm" style="justify-content:center;">TCGPlayer</a>
        <a href="https://www.ebay.com/sch/i.html?_nkw=${ebayQ}&LH_Sold=1&LH_Complete=1" target="_blank" class="btn btn-ghost btn-sm" style="justify-content:center;">eBay Sold</a>
        <button class="btn btn-ghost btn-sm" onclick="closeModal('detail-modal');refreshSealedPrices()" style="justify-content:center;grid-column:1/-1;">🔄 Refresh Price</button>
      </div>
    </div>
    <div class="modal-ft" style="gap:8px;">
      <button class="btn btn-danger btn-sm" onclick="closeModal('detail-modal');deleteSealed('${p.id}')" style="margin-right:auto;">🗑 Delete</button>
      <button class="btn btn-ghost btn-sm" onclick="closeModal('detail-modal')">Close</button>
      <button class="btn btn-primary btn-sm" onclick="closeModal('detail-modal');openSealedModal('${p.id}')">✏️ Edit</button>
    </div>`;
  openModal('detail-modal');
}

/* ─── Resolve a CLEAN official product image for a sealed item.
   Tries TCGPlayer's product CDN (clean studio render) by resolving a product id
   via pokemontcg.io, then sets obj.imgTcg. Falls back silently to the upscaled
   eBay image already on obj.img. Network-dependent; degrades gracefully. ─── */
async function resolveSealedOfficialImage(it){
  return; /* no-op: TCGCSV domain dead + eBay images disabled; images are set manually */
}

/* ─── Find-image helper: opens an image search for the exact product so the user
   can copy a stock image URL and paste it into the field. ─── */
function findSealedImage(){
  const name = (document.getElementById('sp-name')?document.getElementById('sp-name').value:'').trim();
  const set  = (document.getElementById('sp-set') ?document.getElementById('sp-set').value :'').trim();
  const type = document.getElementById('sp-type') ? (document.getElementById('sp-type').value||'').replace(/_/g,' ') : '';
  const q = [name, set, type, 'sealed product'].filter(Boolean).join(' ');
  if(!q.trim()){ toast('Enter a product name first','red'); return; }
  // Google Images for that exact product — user taps an image, copies its URL, pastes back.
  window.open('https://www.google.com/search?tbm=isch&q='+encodeURIComponent(q), '_blank');
  toast('Find a clean image, copy its address, paste it above','blue');
}

/* ─── Upload a sealed product photo to Supabase Storage (bucket: sealed-images).
   Shrinks/compresses in-browser to keep files small, uploads, then writes the
   public URL into the sp-img field. The URL (not the image data) is stored on
   the item, so it syncs to every device with no bloat. ─── */
async function _shrinkImage(file, maxDim, quality){
  maxDim = maxDim||800; quality = quality||0.82;
  try{
    const bmp = await createImageBitmap(file);
    let w = bmp.width, h = bmp.height;
    const scale = Math.min(1, maxDim/Math.max(w,h));
    w = Math.round(w*scale); h = Math.round(h*scale);
    const canvas = document.createElement('canvas'); canvas.width=w; canvas.height=h;
    canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
    const blob = await new Promise(res=>canvas.toBlob(res, 'image/webp', quality));
    return blob || file;
  }catch(e){ return file; }
}
async function uploadSealedPhoto(inputEl){
  const status = (t,c)=>{ const el=document.getElementById('sp-photo-status'); if(el){ el.textContent=t; el.style.color=c||'var(--muted)'; } };
  const file = inputEl && inputEl.files && inputEl.files[0];
  if(!file) return;
  if(!supa){ status('Storage not available — paste a URL instead','var(--red)'); return; }
  if(!currentUser){ status('Sign in to upload photos','var(--red)'); return; }
  try{
    status('Optimizing photo…');
    const blob = await _shrinkImage(file, 800, 0.82);
    const base = (document.getElementById('sp-name') && document.getElementById('sp-name').value || 'product').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,60) || 'product';
    const path = base + '-' + Date.now() + '.webp';
    status('Uploading…');
    const up = await supa.storage.from('sealed-images').upload(path, blob, { contentType:'image/webp', upsert:true });
    if(up.error){ status('Upload failed: '+up.error.message,'var(--red)'); return; }
    const pub = supa.storage.from('sealed-images').getPublicUrl(path);
    const url = pub && pub.data && pub.data.publicUrl;
    if(!url){ status('Could not get image URL','var(--red)'); return; }
    const field = document.getElementById('sp-img');
    if(field){ field.value = url; if(typeof updateSealedPreview==='function') updateSealedPreview(); }
    status('Photo added ✓','var(--green)');
  }catch(e){ status('Error: '+(e.message||e),'var(--red)'); }
  finally{ try{ inputEl.value=''; }catch(_){} }
}

/* ─── Sealed market pricing: calls Worker /sealed, stamps marketValue, re-renders.
   Calls /sealed directly (not gated by FLAGS.sealedEngine, which also affects
   singles/graded). Per-item cache; graceful when worker returns null. ─── */
let sealedPriceCache = {};        // id → { ts, marketValue, confidence, source, lastPricedAt }
let _sealedPricesLoading = false;
const SEALED_PRICE_TTL = 6 * 60 * 60 * 1000;   // 6h
async function loadSealedPrices(force){
  if(_sealedPricesLoading || !Array.isArray(sealed) || !sealed.length) return;
  const now = Date.now();
  // price items that have no fresh cache AND no manual override
  const toFetch = sealed.filter(it=>{
    if(!it || !it.id) return false;
    if((it.valueSource||'')==='manual' && parseFloat(it.value||0)>0) return false;  // user set it manually
    const c = sealedPriceCache[it.id];
    return force || !c || (now - c.ts) > SEALED_PRICE_TTL;
  });
  if(!toFetch.length) return;
  _sealedPricesLoading = true;
  let changed = false;
  try{
    const BATCH = 4;
    for(let i=0;i<toFetch.length;i+=BATCH){
      const batch = toFetch.slice(i,i+BATCH);
      await Promise.all(batch.map(async it=>{
        try{
          const q = buildSealedQuery(it);
          const url = `${EBAY_WORKER}/sealed?q=${encodeURIComponent(q)}&type=${encodeURIComponent(it.type||'')}&lang=${encodeURIComponent(it.lang||'EN')}&limit=20`;
          const r = await fetch(url);
          if(!r.ok) return;
          const d = await r.json();
          if(d && typeof d.marketValue==='number' && d.marketValue>0){
            const acc = Array.isArray(d.acceptedComps) ? d.acceptedComps.length : 0;
            const rej = Array.isArray(d.rejectedComps) ? d.rejectedComps.length : 0;
            sealedPriceCache[it.id] = { ts:Date.now(), marketValue:d.marketValue, low:(typeof d.low==='number'?d.low:null), high:(typeof d.high==='number'?d.high:null), dispersion:(typeof d.dispersion==='number'?d.dispersion:null), confidence:d.confidence||'preliminary', source:d.source||'', acceptedCount:acc, rejectedCount:rej, recencyDays:(typeof d.recencyDays==='number'?d.recencyDays:null), lastPricedAt:d.lastPricedAt||new Date().toISOString(), _hasComps:(Array.isArray(d.acceptedComps)&&d.acceptedComps.length>0), _hasImgField:!!(Array.isArray(d.acceptedComps)&&d.acceptedComps.find(c=>c&&(c.imageUrl||c.image))) };
            const obj = sealed.find(s=>s.id===it.id);
            if(obj){
              obj.marketValue = d.marketValue;
              obj.lastMarketValue = d.marketValue;
              obj.marketLow = (typeof d.low==='number') ? d.low : null;
              obj.marketHigh = (typeof d.high==='number') ? d.high : null;
              obj.lastPricedAt = Date.parse(d.lastPricedAt||'') || Date.now();
              obj.lastPriceConfidence = d.confidence||'preliminary';
              obj.lastPriceSource = d.source||'sealed';
              obj.compCount = acc;
              obj.rejectedCount = rej;
              if(!obj.valueSource) obj.valueSource = 'market';   // default to market unless user chose manual
              // capture a representative product image (only if user hasn't set one).
              // Prefer a CLEAN render: try TCGPlayer official image first (resolved
              // separately), fall back to the eBay comp image UPSCALED to high-res.
              if(!obj.img && !obj.imgTcg){
                const pickImg = (arr) => {
                  if(!Array.isArray(arr)) return '';
                  const c = arr.find(x => x && (x.imageUrl || x.image));
                  return c ? (c.imageUrl || c.image) : '';
                };
                let img = pickImg(d.acceptedComps) || pickImg(d.comps) || pickImg(d.rejectedComps);
                if(!img && (d.imageUrl || d.image)) img = d.imageUrl || d.image;
                if(img){
                  // store the eBay image but DO NOT display it (user wants stock pics only).
                  obj.imgEbay = img.replace(/\/s-l\d+\./, '/s-l1600.');
                  // obj.img is only ever a manual or TCGCSV stock image — never eBay.
                }
              }
              changed = true;
            }
          }
        }catch(e){ /* skip this item */ }
      }));
    }
  } finally {
    _sealedPricesLoading = false;
    if(changed){ try{ save(); }catch(e){} if(typeof renderSealed==='function') renderSealed(); }
    // after pricing, try to upgrade each item to a CLEAN official render (async, non-blocking)
    // TCGCSV auto-image resolution removed (domain dead); stock images are manual now.
  }
}

/* ─── "Explain my price" evidence panel for the sealed modal ─── */
let _sealedModalId = null;       // the sealed item currently open in the modal (edit mode)
function _sealedConfBadge(conf){
  const c = (conf||'').toLowerCase();
  const map = { high:['var(--green)','High'], medium:['var(--gold)','Medium'], low:['var(--orange)','Low'], preliminary:['var(--gold)','Preliminary'] };
  const [col,lbl] = map[c] || ['var(--muted)', conf||'—'];
  return `<span style="font-size:9px;font-weight:700;padding:2px 6px;border-radius:5px;background:${col};color:#0a0a0a;letter-spacing:.3px;">${lbl.toUpperCase()}</span>`;
}
function renderSealedEvidence(id){
  const wrap = document.getElementById('sp-evidence');
  const srcWrap = document.getElementById('sp-valuesource-wrap');
  const item = id ? sealed.find(s=>s.id===id) : null;
  const c = item ? sealedPriceCache[item.id] : null;
  const mv = item && (c ? c.marketValue : (typeof item.marketValue==='number'?item.marketValue:null));
  if(!wrap) return;
  if(!item || mv==null){ wrap.hidden = true; if(srcWrap) srcWrap.hidden = true; return; }
  // value-source toggle visible whenever a market value exists
  if(srcWrap){ srcWrap.hidden = false; _syncSealedSourceButtons(item.valueSource || 'market'); }
  const low = c?c.low:item.marketLow, high = c?c.high:item.marketHigh;
  const acc = c?c.acceptedCount:item.compCount, rej = c?c.rejectedCount:item.rejectedCount;
  const source = (c?c.source:item.lastPriceSource)||'';
  const conf = (c?c.confidence:item.lastPriceConfidence)||'';
  const when = c?c.lastPricedAt:item.lastPricedAt;
  const isAsking = /browse/i.test(source);
  const sourceLbl = isAsking ? 'Active listings (asking prices)' : (/sold/i.test(source) ? 'Recent sold listings' : (source||'—'));
  const whenStr = when ? (typeof when==='number' ? new Date(when).toLocaleDateString() : new Date(Date.parse(when)||Date.now()).toLocaleDateString()) : '';
  const img = item.img ? `<img src="${esc(item.img)}" alt="" loading="lazy" style="width:54px;height:54px;border-radius:8px;object-fit:cover;flex-shrink:0;" onerror="this.style.display='none'">` : '';
  wrap.hidden = false;
  wrap.innerHTML = `
    <div style="background:var(--bg3);border-radius:var(--r2);padding:12px 14px;display:flex;flex-direction:column;gap:10px;">
      <div style="display:flex;align-items:center;gap:12px;">
        ${img}
        <div style="flex:1;min-width:0;">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
            <span style="font-family:var(--disp);font-size:20px;font-weight:800;color:var(--green);">$${mv.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
            ${_sealedConfBadge(conf)}
          </div>
          <div style="font-size:10.5px;color:var(--muted);margin-top:2px;">Market estimate${whenStr?` · ${whenStr}`:''}</div>
        </div>
      </div>
      ${(low!=null&&high!=null)?`<div style="display:flex;justify-content:space-between;font-size:11px;color:var(--muted2);"><span>Range</span><span style="font-family:var(--mono);color:var(--text);">$${low.toFixed(0)} – $${high.toFixed(0)}</span></div>`:''}
      ${(acc!=null)?`<div style="display:flex;justify-content:space-between;font-size:11px;color:var(--muted2);"><span>Comps used</span><span style="font-family:var(--mono);color:var(--text);">${acc} accepted${rej!=null?` · ${rej} filtered out`:''}</span></div>`:''}
      <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--muted2);"><span>Source</span><span style="color:${isAsking?'var(--orange)':'var(--green)'};text-align:right;">${sourceLbl}</span></div>
      ${isAsking?`<div style="font-size:10px;color:var(--orange);line-height:1.4;border-top:1px solid var(--border);padding-top:8px;">⚠ Based on current asking prices, not confirmed sales — treat as a market ceiling, not a sold value.</div>`:''}
      ${c?`<div style="font-size:9px;color:var(--muted);border-top:1px solid var(--border);padding-top:6px;font-family:var(--mono);">diag: comps=${c._hasComps?'yes':'NO'} · img-field=${c._hasImgField?'yes':'NO'} · saved-img=${item.img?'yes':'NO'}</div>`:''}
    </div>`;
}
function _syncSealedSourceButtons(src){
  const m = document.getElementById('sp-src-market'), n = document.getElementById('sp-src-manual');
  if(!m||!n) return;
  const on = 'btn-primary', off = 'btn-ghost';
  m.classList.remove(on,off); n.classList.remove(on,off);
  m.classList.add(src==='market'?on:off); n.classList.add(src==='manual'?on:off);
}
function setSealedValueSource(src){
  _syncSealedSourceButtons(src);
  // remember choice for save; if switching to market, mirror market value into the field for clarity
  window._sealedPendingSource = src;
  if(src==='market' && _sealedModalId){
    const item = sealed.find(s=>s.id===_sealedModalId);
    const c = item && sealedPriceCache[item.id];
    const mv = c ? c.marketValue : (item && typeof item.marketValue==='number' ? item.marketValue : null);
    if(mv!=null) document.getElementById('sp-value').value = '';   // clear manual so market wins
  }
}

/* ─── Manual refresh of sealed market prices (force re-fetch + spin state) ─── */
async function refreshSealedPrices(){
  const btn = document.getElementById('sealed-refresh-btn');
  if(btn){ btn.disabled = true; btn.style.opacity = '0.6'; }
  try {
    sealedPriceCache = {};                 // drop cache so all items re-price
    await loadSealedPrices(true);
    if(typeof renderSealed==='function') renderSealed();
    toast('Prices refreshed','green');
  } catch(e){ toast('Refresh failed','red'); }
  finally { if(btn){ btn.disabled = false; btn.style.opacity = ''; } }
}

// ════════════════════════════════════════════════════════════════════════════
// ── SEALED CRUD · MODAL · RENDERERS ──
// ════════════════════════════════════════════════════════════════════════════
// ═══ SEALED ═══
function openSealedModal(id){
  editingSealedId=id||null;document.getElementById('sealed-modal-title').textContent=id?'Edit Product':'Add Sealed Product';
  if(id){const p=sealed.find(x=>x.id===id);if(!p)return;document.getElementById('sp-name').value=p.name||'';document.getElementById('sp-set').value=p.set||'';document.getElementById('sp-lang').value=p.lang||'EN';document.getElementById('sp-cond').value=p.cond||'sealed';document.getElementById('sp-qty').value=p.qty||1;document.getElementById('sp-paid').value=p.paid||'';document.getElementById('sp-value').value=p.value||'';document.getElementById('sp-date').value=p.date||'';document.getElementById('sp-notes').value=p.notes||'';if(document.getElementById('sp-img'))document.getElementById('sp-img').value=(p.imgManual?p.img:'')||'';document.getElementById('sp-type').value=p.type||'booster_box';document.querySelectorAll('#sealed-modal .type-pill').forEach(b=>b.classList.remove('active'));const ap=document.querySelector(`#sealed-modal .type-pill[data-val="${p.type||'booster_box'}"]`);if(ap)ap.classList.add('active');}
  else{['sp-name','sp-set','sp-paid','sp-value','sp-notes','sp-date','sp-img'].forEach(i=>{const el=document.getElementById(i);if(el)el.value='';});document.getElementById('sp-qty').value=1;document.getElementById('sp-lang').value='EN';document.getElementById('sp-cond').value='sealed';document.getElementById('sp-type').value='booster_box';document.querySelectorAll('#sealed-modal .type-pill').forEach(b=>b.classList.remove('active'));document.querySelector('#sealed-modal .type-pill[data-val="booster_box"]').classList.add('active');}
  updateSealedPreview();openModal('sealed-modal');
  _sealedModalId = id || null; window._sealedPendingSource = null;
  if(typeof renderSealedEvidence==='function') renderSealedEvidence(id);
}
function selectSealedType(val,icon,label,el){document.querySelectorAll('#sealed-modal .type-pill').forEach(b=>b.classList.remove('active'));el.classList.add('active');document.getElementById('sp-type').value=val;document.getElementById('sp-prev-icon').textContent=icon;updateSealedPreview();}
function updateSealedPreview(){const name=document.getElementById('sp-name').value.trim();const set=document.getElementById('sp-set').value.trim();const type=document.getElementById('sp-type').value;const info=SEALED_TYPES[type]||SEALED_TYPES.other;document.getElementById('sp-prev-icon').textContent=info.icon;document.getElementById('sp-prev-name').textContent=name||'No product selected';document.getElementById('sp-prev-name').style.color=name?'var(--text)':'var(--muted)';document.getElementById('sp-prev-meta').textContent=[info.label,set].filter(Boolean).join(' · ')||'Fill in details below';}
function saveSealed(){
  const name=document.getElementById('sp-name').value.trim();if(!name){toast('Product name required','red');return;}
  const _prevSealed=editingSealedId?(sealed.find(x=>x.id===editingSealedId)||{}):{};
  const _spVal=document.getElementById('sp-value').value;
  const data={id:editingSealedId||newId('s'),name,type:document.getElementById('sp-type').value,set:document.getElementById('sp-set').value.trim(),lang:document.getElementById('sp-lang').value,cond:document.getElementById('sp-cond').value,qty:parseInt(document.getElementById('sp-qty').value)||1,paid:document.getElementById('sp-paid').value,value:_spVal,date:document.getElementById('sp-date').value,notes:document.getElementById('sp-notes').value.trim(),img:(document.getElementById('sp-img')?document.getElementById('sp-img').value.trim():'')||_prevSealed.img||'',imgManual:!!(document.getElementById('sp-img')&&document.getElementById('sp-img').value.trim()),imgEbay:_prevSealed.imgEbay||null,imgTcg:_prevSealed.imgTcg||null,added:editingSealedId?_prevSealed.added:new Date().toISOString(),marketValue:_prevSealed.marketValue!=null?_prevSealed.marketValue:null,lastPricedAt:_prevSealed.lastPricedAt!=null?_prevSealed.lastPricedAt:null,lastPriceSource:_prevSealed.lastPriceSource||null,lastPriceConfidence:_prevSealed.lastPriceConfidence||null,compCount:_prevSealed.compCount||0,valueSource:(window._sealedPendingSource||_prevSealed.valueSource||(parseFloat(_spVal||0)>0?'manual':'market'))};
  if(editingSealedId)sealed=sealed.map(x=>x.id===editingSealedId?data:x);else sealed.push(data);
  save();closeModal('sealed-modal');renderSealed();renderPortfolio();
  if(sealedSetFilter)renderSealedQuickAdd(sealedSetFilter,document.getElementById('sealed-set-banner-logo').src||'');
  toast(editingSealedId?'Product updated':'Product added','green');
}
function deleteSealed(id){showConfirm('Remove product?','Permanently removes it.',()=>{retire('sealed',id);sealed=sealed.filter(x=>x.id!==id);save();renderSealed();renderPortfolio();toast('Removed','red');});}
function setSealedFilter(f,el){sealedFilter=f;document.querySelectorAll('#page-sealed .filter-chip').forEach(c=>c.classList.remove('active'));el.classList.add('active');renderSealed();}
function renderSealed(){
  const items=sealed.filter(s=>(!sealedFilter||s.type===sealedFilter)&&(!sealedSetFilter||s.set===sealedSetFilter));
  const grid=document.getElementById('sealed-grid');const empty=document.getElementById('sealed-empty');
  const total=sealed.reduce((s,x)=>s+(x.qty||1),0);
  document.getElementById('nb-sealed').textContent=total;document.getElementById('sealed-topbar-cnt').textContent=total+' item'+(total!==1?'s':'');
  let totalVal=0,totalPaid=0,pnlCount=0;
  sealed.forEach(x=>{const v=sealedEffectiveValue(x);const p=parseFloat(x.paid||0);const q=itemQty(x);if(v>0)totalVal+=v*q;if(p>0){totalPaid+=p*q;pnlCount++;}});
  document.getElementById('ss-total').textContent=total;
  document.getElementById('ss-value').textContent='$'+totalVal.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
  const pnlEl=document.getElementById('ss-pnl');const pnlSub=document.getElementById('ss-pnl-sub');
  if(pnlCount>0&&totalVal>0){const pnl=totalVal-totalPaid;const pct=totalPaid>0?((pnl/totalPaid)*100).toFixed(1):0;pnlEl.textContent=(pnl>=0?'+':'-')+'$'+Math.abs(pnl).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});pnlEl.style.color=pnl>=0?'var(--green)':'var(--red)';pnlSub.textContent=(pnl>=0?'+':'')+pct+'% on '+pnlCount+' items';}
  else{pnlEl.textContent='—';pnlEl.style.color='var(--muted2)';pnlSub.textContent='add prices to track';}
  if(!sealed.length){grid.innerHTML='';empty.style.display='block';return;}
  empty.style.display='none';
  if(typeof loadSealedPrices==='function'){ loadSealedPrices(); }   // non-blocking: fetch market prices, re-renders when ready
  if(!items.length){grid.innerHTML='<p style="color:var(--muted);font-size:12.5px;padding:10px 0;">No items match this filter.</p>';return;}
  grid.innerHTML=items.map(p=>{
    const info=SEALED_TYPES[p.type]||SEALED_TYPES.other;
    const val=sealedEffectiveValue(p),paid=parseFloat(p.paid||0);
    const vsrc=sealedValueSource(p);
    const roi=val>0&&paid>0?val*(p.qty||1)-paid*(p.qty||1):null;
    const roiPct=roi!=null&&paid>0?((roi/(paid*(p.qty||1)))*100).toFixed(1):null;
    const tcgQ=encodeURIComponent(p.name+(p.set?' '+p.set:''));
    return `<div class="card-tile" style="cursor:default;">
      <div class="ct-img" onclick="openSealedDetail('${p.id}')" style="aspect-ratio:1;background:var(--bg3);display:flex;align-items:center;justify-content:center;font-size:52px;overflow:hidden;position:relative;cursor:pointer;">
        <span style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;">${info.icon}</span>
        ${(()=>{const _si=sealedImageFor(p);return _si?`<img src="${esc(_si)}" alt="${esc(p.name)}" loading="lazy" style="position:relative;width:100%;height:100%;object-fit:cover;" onerror="this.style.display='none'">`:'';})()}
        <div class="ct-badges"><span class="ct-badge type-standard">${info.label}</span>${p.lang&&p.lang!=='EN'?`<span class="ct-badge type-reverse">${esc(p.lang)}</span>`:''}</div>
        <span class="ct-cond" style="background:${p.cond==='sealed'?'rgba(46,204,128,.2)':'rgba(255,140,66,.2)'};color:${p.cond==='sealed'?'#4ade80':'var(--orange)'};width:auto;padding:2px 6px;border-radius:6px;font-size:9px;top:7px;right:7px;">${p.cond==='sealed'?'SEALED':'OPEN'}</span>
      </div>
      <div class="ct-body">
        <div class="ct-name" onclick="openSealedDetail('${p.id}')" style="cursor:pointer;">${esc(p.name)}</div>
        <div class="ct-set" onclick="openSealedDetail('${p.id}')" style="cursor:pointer;">${esc(p.set||'')}${p.qty>1?' · ×'+esc(p.qty):''}</div>
        <div class="price-strip">
          ${val>0?`<div class="ps-row"><span class="ps-lbl">Value<span style="font-size:8px;font-weight:700;padding:1px 4px;border-radius:4px;margin-left:5px;letter-spacing:.3px;background:${vsrc==='market'?'rgba(46,204,128,.16)':'rgba(245,200,66,.16)'};color:${vsrc==='market'?'var(--green)':'var(--gold)'};">${vsrc==='market'?'LIVE':'MANUAL'}</span></span><span class="ps-val ps-best">$${val.toFixed(2)}</span></div>`:''}
          ${paid>0?`<div class="ps-row"><span class="ps-lbl">Paid</span><span class="ps-val">$${paid.toFixed(2)}</span></div>`:''}
          ${roi!=null?`<hr class="ps-divider"><div class="ps-summary"><span style="color:${roi>=0?'var(--green)':'var(--red)'};">${roi>=0?'+':'-'}$${Math.abs(roi).toFixed(2)} (${roiPct}%)</span></div>`:''}
          ${!val&&!paid?`<div onclick="openSealedModal('${p.id}')" style="font-size:11px;color:var(--gold);cursor:pointer;padding:6px 0;">⚠ Tap to add market value</div>`:''}
        </div>
        <div class="ct-actions">
          <a href="https://www.tcgplayer.com/search/pokemon/product?q=${tcgQ}" target="_blank" class="btn btn-ghost btn-sm" style="flex:1;justify-content:center;">TCGPlayer</a>
          <a href="https://www.ebay.com/sch/i.html?_nkw=${tcgQ}&LH_Sold=1&LH_Complete=1" target="_blank" class="btn btn-ghost btn-sm" style="flex:1;justify-content:center;">eBay Sold</a>
          <button class="btn btn-ghost btn-sm" onclick="openSealedModal('${p.id}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:12px;height:12px"><path d="M11 4H4a2 2 0 0 0-2 2v14c0 1.1.9 2 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4z"/></svg></button>
          <button class="btn btn-danger btn-sm" onclick="deleteSealed('${p.id}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:12px;height:12px"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg></button>
        </div>
      </div>
    </div>`;
  }).join('');
}
// Sealed set browser
function renderSealedSets(sets){const el=document.getElementById('sealed-set-list');if(!el)return;if(!sets||!sets.length){el.innerHTML='<p style="font-size:12px;color:var(--muted);padding:6px 0;">No sets loaded — add pokemontcg.io key in Settings.</p>';return;}document.getElementById('sealed-set-cnt').textContent=sets.length+' sets';el.innerHTML=sets.map(s=>{const logo=s.images?.logo?`<img class="set-logo" src="${esc(s.images.logo)}" alt="${esc(s.name)}" loading="lazy" onerror="this.style.display='none'">`:'<div class="set-logo-ph"></div>';return `<div class="set-item${sealedSetFilter===s.name?' active':''}" onclick="selectSealedSet('${s.id}','${s.name.replace(/'/g,"\\'")}','${s.images?.logo||''}')">${logo}<div style="min-width:0;flex:1;"><div class="set-name">${esc(s.name)}</div><div class="set-year">${(s.releaseDate||'').slice(0,4)}</div></div></div>`;}).join('');}
function filterSealedSets(q){if(!allSets.length)return;renderSealedSets(q?allSets.filter(s=>s.name.toLowerCase().includes(q.toLowerCase())):allSets);}
function selectSealedSet(id,name,logo){sealedSetFilter=name;document.getElementById('sp-set').value=name;const banner=document.getElementById('sealed-set-banner');banner.style.display='flex';document.getElementById('sealed-set-banner-name').textContent=name;const bl=document.getElementById('sealed-set-banner-logo');bl.src=logo;bl.style.display=logo?'':'none';document.getElementById('sealed-set-clear').style.display='';renderSealedSets(document.getElementById('sealed-set-filter').value?allSets.filter(s=>s.name.toLowerCase().includes(document.getElementById('sealed-set-filter').value.toLowerCase())):allSets);renderSealedQuickAdd(name,logo);renderSealed();}
function clearSealedSetFilter(){sealedSetFilter='';document.getElementById('sealed-set-banner').style.display='none';document.getElementById('sealed-set-clear').style.display='none';document.getElementById('sealed-set-filter').value='';document.getElementById('sealed-quickadd-panel').style.display='none';renderSealedSets(allSets);renderSealed();}
function renderSealedQuickAdd(setName,setLogo){const panel=document.getElementById('sealed-quickadd-panel');const grid=document.getElementById('sealed-quickadd-grid');if(!setName){panel.style.display='none';return;}panel.style.display='';grid.innerHTML=SEALED_CATALOG.map(prod=>{const fullName=setName+' '+prod.suffix;const owned=sealed.some(s=>s.name===fullName);const tcgQ=encodeURIComponent(fullName);return `<div style="background:var(--bg3);border:1px solid ${owned?'rgba(245,200,66,.3)':'var(--border)'};border-radius:var(--r);padding:10px;display:flex;flex-direction:column;gap:6px;"><div style="display:flex;align-items:center;gap:7px;"><span style="font-size:20px;">${prod.icon}</span><div><div style="font-size:11px;font-weight:600;">${prod.label}</div><div style="font-size:10px;color:var(--muted);">${prod.note}</div></div></div><div style="font-size:10px;color:var(--muted2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${fullName}</div><div style="display:flex;gap:5px;">${owned?`<span style="font-size:10px;color:var(--green);font-family:var(--mono);padding:3px 8px;background:rgba(46,204,128,.1);border-radius:4px;">✓ In vault</span>`:`<button class="btn btn-primary btn-xs" style="flex:1;justify-content:center;font-size:10px;" onclick="quickAddSealed('${fullName.replace(/'/g,"\\'")}','${prod.type}','${setName.replace(/'/g,"\\'")}','${(setLogo||'').replace(/'/g,"\\'")}')">+ Add</button>`}<a href="https://www.tcgplayer.com/search/pokemon/product?q=${tcgQ}" target="_blank" class="btn btn-ghost btn-xs" style="font-size:10px;padding:3px 6px;">TC</a><a href="https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(fullName+' sealed')}&LH_Sold=1&LH_Complete=1" target="_blank" class="btn btn-ghost btn-xs" style="font-size:10px;padding:3px 6px;">eBay</a></div></div>`;}).join('');}
function quickAddSealed(name,type,setName,setLogo){openSealedModal();document.getElementById('sp-name').value=name;document.getElementById('sp-set').value=setName;document.getElementById('sp-type').value=type;document.querySelectorAll('#sealed-modal .type-pill').forEach(b=>b.classList.remove('active'));const pill=document.querySelector(`#sealed-modal .type-pill[data-val="${type}"]`);if(pill)pill.classList.add('active');updateSealedPreview();}
