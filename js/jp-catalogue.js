/* ════════════════════════════════════════════════════════════════════════════
   MyTCG Ledger V6 - jp-catalogue.js
   ────────────────────────────────────────────────────────────────────────────
   DOMAIN MODULE (Japanese card catalogue + discovery). Mirrors the English flow
   using the Worker's /jp-sets and /jp-cards routes, reusing the same grids and
   tile classes but with separate jp* functions so the English path is untouched.

   REGION WAS CONTAMINATED - and split accordingly. The old "JP region"
   (3960-4714) actually ended at 4532: everything after it is the REAL nav/mobile
   domain (setTabPageSize, _currentPage, fabAction, updateFab, goPage,
   updateMobTabs, openMobileCollection, openMobileMore, closeMobileMore,
   mobGoPage). None of that moved. Same lesson as the mislabelled nav banner in
   Batch 23: physical range is not ownership.

   OWNS:
     - aliases      JP_SET_EN  (TCGdex set id -> English name, display only;
                    NEVER affects identity or pricing)
     - query        jpEnSetName, jpSearchTerms
     - cache        JP_SRC, JP_SETS_KEY, JP_CARDS_PREFIX, jpCacheGet, jpCacheSet
                    and the jpPurgeOldCaches() load-time IIFE
     - state        _jpSets, _jpSetCards, _jpTimer, window._searchLang default
     - normalizers  jpNormSet, jpAsset, jpNormCard, jpErrMsg
     - catalogue    jpEnsureSets, jpShowSets, jpBrowseSet
     - results      jpRenderCardsInto, jpImgFallback, jpPickCard
     - search       jpOnSearch, jpAlsoAvailable, jpJumpToSearch, jpTranslateName

   DOES NOT OWN - three bridge functions deliberately left inline:
     - ebayCardQuery: its ONLY caller is card-detail.js. It builds an eBay query
       for EN and JP cards alike and merely consults jpSearchTerms for the JP
       branch. Card-detail's helper, not JP's.
     - setSearchLang: the EN/JP toggle. It writes search state and calls
       clearTabSearch/renderSetBrowser; its EN branch is pure search. A shared
       mode switch, not JP-owned.
     - closeBrowseSet: mutates _browseSetId / window._browseSetCards (SEARCH
       state) and calls renderSetBrowser; it only DELEGATES to jpShowSets in JP
       mode. Search-owned, called twice from search.js.
     Also not owned: generic search, cards CRUD, card detail, wishlist, pricing,
     UVE, portfolio, dashboard, scanner, nav/bootstrap, sync, persistence.

   ESTABLISHED CROSS-DOMAIN CONTRACT (Batch 23) - preserved exactly, both
   directions, CALL-TIME only:
     search -> JP   onTabSearch -> jpOnSearch,  doTabSearch -> jpAlsoAvailable
     JP -> search   jpPickCard  -> quickAdd
     card-detail -> JP   ebayCardQuery (inline) -> jpSearchTerms
   Mutual UI collaboration, not circular ownership: nothing here runs at load
   except the cache purge, so no reference can resolve during evaluation.

   LOAD-TIME EXECUTION - three statements, all pre-existing and moved verbatim:
     1. jpPurgeOldCaches() IIFE - removes localStorage keys from superseded JP
        cache versions. Touches ONLY the pkjp_ and pkv2_jp cache-key prefixes.
     2. window._searchLang = 'EN' - the default mode flag search.js reads.
     3. let _jpSets/_jpSetCards/_jpTimer declarations.
   No fetch, no render, no modal, no domain-state mutation at load.

   CALL-TIME DEPENDENCIES:
     core       esc, toast
     search     quickAdd, clearTabSearch, renderSetBrowser, setSearchLang (via
                the inline bridge), _tabQuery/_browseSetId search state
     inline     keys, EBAY_WORKER, and the #set-browser / #cs-set-cards /
                #tab-* / #lang-toggle DOM
     external   the Worker's /jp-sets, /jp-cards and /jp-translate routes
   ════════════════════════════════════════════════════════════════════════════ */

// ═══════════════════════════════════════════════════════════════════════
// JAPANESE SEARCH & BROWSE (2026-07) — mirrors the English flow using the
// Worker's /jp-sets and /jp-cards routes (PokemonPriceTracker, PPT_TOKEN).
// Reuses the SAME grids, tiles, and card classes as English; separate jp*
// functions so the English path is untouched. Field names from PPT are
// normalized defensively (shape can vary). Rollback: remove this block, the
// #lang-toggle markup, and the six small hooks tagged "(2026-07)"/"JP mode".
// ═══════════════════════════════════════════════════════════════════════
// ═══ Japanese set → English equivalent (display only) ═══════════════════════
// Keyed on TCGdex's stable set IDs. This NEVER affects identity or pricing — the
// Japanese name stays the source of truth for eBay comps (sellers list JP cards
// under their Japanese names). This is purely a human-readable subtitle.
// Unmapped sets simply show no subtitle. Add rows freely.
const JP_SET_EN = {
  // ── Scarlet & Violet era ──
  'SV1a':'Triplet Beat','SV1S':'Scarlet ex','SV1V':'Violet ex','SV2a':'Pokémon 151',
  'SV2D':'Clay Burst','SV2P':'Snow Hazard','SV3':'Ruler of the Black Flame',
  'SV3a':'Raging Surf','SV4a':'Shiny Treasure ex','SV4K':'Ancient Roar','SV4M':'Future Flash',
  'SV5a':'Crimson Haze','SV5K':'Wild Force','SV5M':'Cyber Judge','SV6':'Transformation Mask',
  'SV6a':'Night Wanderer','SV7':'Stellar Miracle','SV7a':'Paradise Dragona',
  'SV8':'Super Electric Breaker','SV8a':'Terastal Fest ex','SV9':'Battle Partners',
  'SV9a':'Heat Wave Arena','SV10':'Glory of Team Rocket','SV11B':'Black Bolt','SV11W':'White Flare',
  // ── Sword & Shield era ──
  'S1H':'Shield','S1W':'Sword','S1a':'VMAX Rising','S2':'Rebellion Crash','S2a':'Explosive Walker',
  'S3':'Infinity Zone','S3a':'Legendary Heartbeat','S4':'Astonishing Volt Tackle',
  'S4a':'Shiny Star V','S5I':'Single Strike Master','S5R':'Rapid Strike Master',
  'S6H':'Silver Lance','S6K':'Jet-Black Spirit','S6a':'Eevee Heroes','S7D':'Skyscraping Perfection',
  'S7R':'Blue Sky Stream','S8':'Fusion Arts','S8a':'25th Anniversary Collection',
  'S8b':'VMAX Climax','S9':'Star Birth','S9a':'Battle Region','S10D':'Time Gazer',
  'S10P':'Space Juggler','S10a':'Dark Phantasma','S11':'Lost Abyss','S11a':'Incandescent Arcana',
  'S12':'Paradigm Trigger','S12a':'VSTAR Universe',
  // ── Sun & Moon era ──
  'SM1S':'Collection Sun','SM1M':'Collection Moon','SM2K':'Islands Await You',
  'SM2L':'Alolan Moonlight','SM3H':'Darkness that Consumes Light','SM3N':'To Have Seen the Battle Rainbow',
  'SM4A':'Ultradimensional Beast','SM4S':'Awakened Heroes','SM5M':'Ultra Moon','SM5S':'Ultra Sun',
  'SM6':'Forbidden Light','SM6a':'Dragon Storm','SM6b':'Champion Road','SM7':'Charisma of the Wrecked Sky',
  'SM7a':'Thunderclap Spark','SM7b':'Fairy Rise','SM8':'Explosive Impact','SM8a':'Dark Order',
  'SM8b':'GX Ultra Shiny','SM9':'Tag Bolt','SM9a':'Night Unison','SM9b':'Full Metal Wall',
  'SM10':'Double Blaze','SM10a':'GG End','SM10b':'Sky Legend','SM11':'Miracle Twin',
  'SM11a':'Remix Bout','SM11b':'Dream League','SM12':'Alter Genesis','SM12a':'Tag Team GX All Stars',
  // ── XY era ──
  'XY1a':'Collection X','XY1b':'Collection Y','XY2':'Wild Blaze','XY3':'Rising Fist',
  'XY4':'Phantom Gate','XY5a':'Gaia Volcano','XY5b':'Tidal Storm','XY6':'Emerald Break',
  'XY7':'Bandit Ring','XY8a':'Blue Shock','XY8b':'Red Flash','XY9':'Rage of the Broken Heavens',
  'XY10':'Awakening Psychic King','XY11a':'Explosive Fighter','XY11b':'Cruel Traitor',
  // ── Older / classic ──
  'PMCG1':'Base Set','PMCG2':'Jungle','PMCG3':'Fossil','PMCG4':'Team Rocket',
  'PMCG5':'Leaders\' Stadium','PMCG6':'Challenge from the Darkness',
  'neo1':'Neo Genesis','neo2':'Neo Discovery','neo3':'Neo Revelation','neo4':'Neo Destiny',
  'E1':'Expedition Base Set','E2':'Town on No Map','E3':'Wind from the Sea',
  'E4':'Split Earth','E5':'Mysterious Mountains',
  'L1a':'HeartGold Collection','L1b':'SoulSilver Collection','L2':'Revived Legends',
  'L3':'Clash at the Summit','LL':'Lost Link',
};

// JP card → English set name, for English-market lookups (TCGPlayer/PriceCharting/eBay).
// A Japanese set name like "闇、そして光へ..." returns ZERO results on those sites, so
// external links must use the English equivalent + a "Japanese" qualifier.
// Order: stored setEn (saved at add time) → live lookup in the cached JP set list → ''.
function jpEnSetName(card){
  if (!card) return '';
  if (card.setEn) return String(card.setEn);
  try {
    const list = (typeof _jpSets !== 'undefined' && _jpSets) ? _jpSets : null;
    if (list && card.set) {
      const hit = list.find(s => s.name === card.set);
      if (hit && hit.en) return hit.en;
    }
  } catch(_){}
  return '';
}
// Search string for a JP card on ENGLISH marketplaces.
function jpSearchTerms(card){
  const en = jpEnSetName(card);
  return [card.name, card.num, en, 'Japanese'].filter(Boolean).join(' ');
}

// Cache keys are VERSIONED by data source. Bumping JP_SRC invalidates every cached
// payload from the previous source automatically — no manual clearing, ever. (v3 =
// TCGdex; v1/v2 were PokemonPriceTracker and are purged on load.)
const JP_SRC = 'v5tcgdex_img';
const JP_SETS_KEY     = 'pkjp_' + JP_SRC + '_sets';
const JP_CARDS_PREFIX = 'pkjp_' + JP_SRC + '_cards_';
(function jpPurgeOldCaches(){
  try {
    const kill = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k) continue;
      // old PPT-era keys, and any versioned key that isn't the current source
      if (k === 'pkv2_jpsets' || k.startsWith('pkv2_jpcards_') ||
          (k.startsWith('pkjp_') && !k.startsWith('pkjp_' + JP_SRC + '_'))) kill.push(k);
    }
    kill.forEach(k => { try { localStorage.removeItem(k); } catch(_){} });
  } catch(_){}
})();
window._searchLang = 'EN';
let _jpSets = null, _jpSetCards = {}, _jpTimer = null;

// ── defensive normalizers: PPT field names vary, so try every plausible key ──
function jpNormSet(s){
  // GUARD (maintainability batch): elements come straight from the API response,
  // which is outside our control and may contain nulls. Everything downstream
  // filters on `s.name`, so an empty shape is dropped exactly like a bad record.
  if (!s || typeof s !== 'object') return { key:'', id:'', name:'', total:'', logo:'', symbol:'' };
  // TCGdex: cardCount is an OBJECT {total, official}; logo/symbol are extension-less
  // asset URLs (append .png/.webp). Legacy PPT keys kept as fallbacks.
  let total = '';
  const cc = s.cardCount;
  if (cc && typeof cc === 'object') total = cc.total ?? cc.official ?? '';
  else total = cc ?? s.total ?? s.numCards ?? s.count ?? s.printedTotal ?? '';
  const logo = s.logo ?? s.image ?? s.imageUrl ?? '';
  const sym  = s.symbol ?? '';
  const id   = String(s.id ?? s._id ?? s.setId ?? s.code ?? s.slug ?? s.name ?? '');
  return {
    id,
    name: String(s.name ?? s.setName ?? s.title ?? 'Unknown Set'),
    en:   JP_SET_EN[id] || '',                       // English equivalent (see table)
    total: total === '' ? '' : Number(total) || '',
    date:  String(s.releaseDate ?? s.release_date ?? s.date ?? ''),
    img:   logo ? jpAsset(String(logo), 'logo') : '',   // banner (many old JP sets lack one)
    sym:   sym  ? jpAsset(String(sym),  'symbol') : ''  // small icon — graceful fallback
  };
}
// TCGdex asset URLs carry NO extension — you append quality+format yourself.
// Cards: {url}/low.webp | {url}/high.webp   ·   Logos/symbols: {url}.webp
function jpAsset(url, kind, quality){
  if (!url) return '';
  if (/\.(png|jpg|jpeg|webp)$/i.test(url)) return url;   // already complete (PPT legacy)
  if (kind === 'logo' || kind === 'symbol') return url + '.webp';
  return url + '/' + (quality || 'low') + '.webp';
}
function jpNormCard(c, setName){
  // TCGdex card brief: {id, localId, name, image}. `localId` is the printed card
  // number; `image` has NO extension. TCGdex carries no prices (it's a catalog, not a
  // price feed) — pricing comes from eBay via the Worker, same as English cards.
  const rawImg = c.image ?? c.imageUrl ?? (c.images && (c.images.small || c.images.large)) ?? c.photo ?? '';
  let price = null;
  try {
    price = c.marketPrice ?? c.price ??
            (c.prices && (c.prices.market ?? (c.prices.raw && (c.prices.raw.market ?? c.prices.raw)) ?? null));
    if (typeof price !== 'number') price = null;
  } catch(_){ price = null; }
  const num = String(c.localId ?? c.number ?? c.cardNumber ?? c.num ?? c.no ?? '');
  return {
    id:    'jp-' + String(c.id ?? c._id ?? c.cardId ?? ((c.name||'') + '-' + num)).replace(/[^a-zA-Z0-9_-]/g,'_'),
    name:  String(c.name ?? c.cardName ?? 'Unknown'),
    en:    '',                                     // filled from the EN locale twin

    set:   String(c.setName ?? c.set ?? setName ?? ''),
    num,
    img:     rawImg ? jpAsset(String(rawImg), 'card', 'low')  : '',   // grid thumb
    imgHigh: rawImg ? jpAsset(String(rawImg), 'card', 'high') : '',   // saved to collection
    rarity:String(c.rarity ?? ''),
    price
  };
}

// 7-day persistent cache for JP payloads — protects the free tier's request quota.
function jpCacheGet(key){
  try { const raw = localStorage.getItem(key); if(!raw) return null;
    const c = JSON.parse(raw);
    if (c && c.t && Date.now()-c.t < 7*86400000 && Array.isArray(c.data) && c.data.length) return c.data;
  } catch(_){} return null;
}
function jpCacheSet(key, data){
  try { localStorage.setItem(key, JSON.stringify({t:Date.now(), data})); } catch(_){}
}
// Human-readable PPT errors — 429 = free-tier quota exhausted, not a bug.
function jpErrMsg(e){
  const m = String((e && e.message) || e || '');
  if (/429/.test(m)) return 'Upstream rate limit — please try again in a moment.';
  if (/404/.test(m)) return 'That set has no Japanese card data in the catalog yet.';
  return 'Failed to load — ' + (m || 'network error') + '<br><span style="color:var(--muted);">Japanese data comes from TCGdex (free, no key).</span>';
}

async function jpEnsureSets(){
  if (_jpSets && _jpSets.length) return _jpSets;
  // localStorage cache (7d) so the sets list is instant across sessions
  try {
    const raw = localStorage.getItem(JP_SETS_KEY);
    if (raw) { const c = JSON.parse(raw); if (c && c.t && Date.now()-c.t < 7*86400000 && Array.isArray(c.data) && c.data.length) { _jpSets = c.data; return _jpSets; } }
  } catch(_){}
  const r = await fetch(`${EBAY_WORKER}/jp-sets`);
  const j = await r.json();
  if (j && j.error) throw new Error(String(j.error) + (j.body ? ' \u2014 ' + String(j.body).slice(0,160) : ''));
  const arr = Array.isArray(j.data) ? j.data : [];
  window._jpSource = j.source || '';
  _jpSets = arr.map(jpNormSet).filter(s => s.name && s.name !== 'Unknown Set');
  // newest first when dates exist
  _jpSets.sort((a,b) => (b.date||'').localeCompare(a.date||''));
  try { localStorage.setItem(JP_SETS_KEY, JSON.stringify({t:Date.now(), data:_jpSets})); } catch(_){}
  return _jpSets;
}

async function jpShowSets(){
  const grid  = document.getElementById('set-browser-grid');
  const cGrid = document.getElementById('cs-set-cards-grid');
  const load  = document.getElementById('cs-set-cards-loading');
  const backBtn = document.getElementById('set-back-btn');
  if (cGrid) { cGrid.style.display='none'; cGrid.innerHTML=''; }
  if (load) load.style.display='none';
  if (backBtn) backBtn.style.display='none';
  document.getElementById('set-browser-set-name').style.display='none';
  document.getElementById('set-browser-all-sets').textContent = 'ALL SETS · JP';
  grid.style.display='';
  grid.innerHTML = '<div style="grid-column:1/-1;padding:20px;font-size:12px;color:var(--muted);">Loading Japanese sets…</div>';
  try {
    const sets = await jpEnsureSets();
    if (!sets.length) { grid.innerHTML = '<div style="grid-column:1/-1;padding:20px;font-size:12px;color:var(--muted);">No Japanese sets returned. <a href="#" onclick="_jpSets=null;localStorage.removeItem(\'pkv2_jpsets\');jpShowSets();return false;" style="color:var(--gold);">Retry</a></div>'; return; }
    document.getElementById('set-browser-count').textContent = sets.length + ' sets' + (window._jpSource ? ' \u00b7 ' + window._jpSource : '');
    window._jpSetMap = {};
    grid.innerHTML = sets.map((s,i) => {
      const key = 'jset_' + i;
      window._jpSetMap[key] = s;
      const year = (s.date||'').slice(0,4);
      // art: logo → symbol → clean lettermark (never a broken-image glyph)
      const art = s.img
        ? `<img src="${esc(s.img)}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'jp-mark',textContent:'${(s.id||'JP').slice(0,4)}'}))">`
        : (s.sym
            ? `<img src="${s.sym}" alt="" loading="lazy" style="max-height:38px;" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'jp-mark',textContent:'${(s.id||'JP').slice(0,4)}'}))">`
            : `<div class="jp-mark">${(s.id||'JP').slice(0,4)}</div>`);
      return `<div class="set-tile" onclick="jpBrowseSet('${key}')">
        <div class="set-tile-logo">${art}</div>
        <div class="set-tile-body">
          <div class="set-tile-name">${esc(s.name)}</div>
          ${s.en ? `<div class="jp-en">${s.en}</div>` : ''}
          <div class="set-tile-meta"><span>${year||'JP'}</span><span>${s.total ? s.total+' cards' : ''}</span></div>
        </div>
      </div>`;
    }).join('');
  } catch(e) {
    const isToken = /PPT_TOKEN/i.test(e.message||'');
    grid.innerHTML = `<div style="grid-column:1/-1;padding:20px;font-size:12px;color:var(--red);line-height:1.6;">
      ${isToken
        ? 'Japanese data needs the <b>PPT_TOKEN</b> secret (PokemonPriceTracker) on the Cloudflare Worker.<br><span style="color:var(--muted);">Dashboard → mytcgledger-ebay → Settings → Variables and Secrets → add PPT_TOKEN.</span>'
        : 'Failed to load Japanese sets — ' + (e.message||'network error')}
      <br><a href="#" onclick="jpShowSets();return false;" style="color:var(--gold);">Retry</a></div>`;
  }
}

async function jpBrowseSet(key){
  const s = (window._jpSetMap||{})[key]; if (!s) return;
  const grid  = document.getElementById('set-browser-grid');
  const cGrid = document.getElementById('cs-set-cards-grid');
  const load  = document.getElementById('cs-set-cards-loading');
  document.getElementById('set-browser-set-label').textContent = s.name;
  document.getElementById('set-browser-set-name').style.display='inline-flex';
  const backBtn = document.getElementById('set-back-btn');
  if (backBtn) backBtn.style.display='inline-flex';
  grid.style.display='none'; cGrid.style.display='none'; if (load) load.style.display='';
  try {
    let cards = _jpSetCards[s.id] || jpCacheGet(JP_CARDS_PREFIX + s.id);
    if (!cards) {
      // ONE call per set (v22: the old id-then-name retry double-spent the rate limit).
      const j = await (await fetch(`${EBAY_WORKER}/jp-cards?set=${encodeURIComponent(s.id)}&limit=300`)).json();
      const arr = (j && Array.isArray(j.data)) ? j.data : [];
      if (j && j.error && !arr.length) throw new Error(String(j.error));
      cards = arr.map(c => jpNormCard(c, j.setName || s.name));
      // v25: build deterministic TCGdex asset URLs from serie+set+localId. The image
      // URL is predictable (docs: assets.tcgdex.net/{lang}/{serie}/{set}/{num}/{q}.webp)
      // so we DON'T need the API's `image` field — we construct EN + JP candidates and
      // let the <img> onerror chain pick whichever actually exists.
      const _serie = j.serie || '';
      const _sid   = j.setId || s.id;
      if (_serie && _sid) {
        cards.forEach(c => {
          if (!c.num) return;
          const n = String(c.num).replace(/^0+/, '') || c.num;   // TCGdex uses unpadded ids
          if (!c.img) {
            c.img     = `https://assets.tcgdex.net/en/${_serie}/${_sid}/${n}/low.webp`;
            c.imgHigh = `https://assets.tcgdex.net/en/${_serie}/${_sid}/${n}/high.webp`;
          }
          // JP-locale candidate as the onerror fallback (some art is JP-only)
          c.imgAlt  = `https://assets.tcgdex.net/ja/${_serie}/${_sid}/${n}/low.webp`;
        });
      }
      // Enrich from the SAME set in TCGdex's English locale: gives a readable English
      // name and — critically — an image for vintage sets whose ja locale has none.
      // Best-effort: any failure leaves the Japanese data exactly as-is.
      try {
        const je = await (await fetch(`${EBAY_WORKER}/jp-cards?set=${encodeURIComponent(s.id)}&limit=300&lang=en`)).json();
        const en = (je && Array.isArray(je.data)) ? je.data : [];
        const nk = v => String(v==null?'':v).replace(/^0+/,'').split('/')[0].trim().toLowerCase(); // normalize card number
        if (en.length) {
          const byNum = {};
          en.forEach(c => { const k = nk(c.localId ?? c.number); if (k) byNum[k] = c; });
          let matched = 0, arted = 0;
          cards.forEach(c => {
            const m = byNum[nk(c.num)];
            if (!m) return;
            matched++;
            if (m.name && m.name !== c.name) c.en = String(m.name);
            if (!c.img && m.image) { c.img = jpAsset(String(m.image),'card','low'); c.imgHigh = jpAsset(String(m.image),'card','high'); arted++; }
          });
          window._jpEnrich = { set:s.id, enCount:en.length, matched, arted };   // diagnostic
        } else {
          window._jpEnrich = { set:s.id, enCount:0, note:'no EN data (worker may be pre-v24, or set has no EN release)' };
        }
      } catch(_){}
      _jpSetCards[s.id] = cards;
      jpCacheSet(JP_CARDS_PREFIX + s.id, cards);   // 7d persistent → re-opening costs 0 API calls
    } else { _jpSetCards[s.id] = cards; }
    if (load) load.style.display='none';
    document.getElementById('set-browser-count').textContent = cards.length + ' cards';
    cGrid.innerHTML = `
      <div class="set-cards-header">
        ${s.img ? `<img src="${esc(s.img)}" alt="">` : ''}
        <div>
          <div style="font-size:15px;font-weight:700;">${s.name} <span style="font-family:var(--mono);font-size:10px;color:var(--gold);">JP</span></div>
          ${s.en ? `<div class="jp-en" style="margin:2px 0 3px;">${s.en}</div>` : ''}
          <div style="font-family:var(--mono);font-size:10px;color:var(--muted);">${cards.length} cards</div>
        </div>
      </div>
      <div class="cs-grid" id="jp-cards-inner" style="max-height:none;padding:0;"></div>`;
    cGrid.style.display='';
    jpRenderCardsInto('jp-cards-inner', cards);
  } catch(e) {
    if (load) load.style.display='none';
    cGrid.style.display='';
    cGrid.innerHTML = `<div style="padding:20px;font-size:12px;color:var(--red);line-height:1.6;">${jpErrMsg(e)} <a href="#" onclick="delete _jpSetCards['${s.id}'];jpBrowseSet('${key}');return false;" style="color:var(--gold);">Retry</a></div>`;
  }
}

function jpRenderCardsInto(innerId, cards){
  const inner = document.getElementById(innerId); if (!inner) return;
  window._jpPick = window._jpPick || {};
  inner.innerHTML = cards.map((c,i) => {
    const key = innerId + '_' + i;
    window._jpPick[key] = c;
    const inVault = collection.some(x => x.name===c.name && x.num===c.num && (x.set===c.set || (x.lang==='JP' && x.name===c.name)));
    return `<div class="cs-card" onclick="jpPickCard('${key}')">
      <div class="cs-img-wrap">${c.img ? `<img src="${esc(c.img)}" alt="" loading="lazy" data-alt="${esc(c.imgAlt||'')}" onerror="jpImgFallback(this)">` : '<div class="cs-img-ph">🇯🇵</div>'}</div>
      <div class="cs-body">
        <div class="cs-set-pill">#${c.num || '?'}</div>
        <div class="cs-name">${esc(c.name)}</div>
        ${c.en ? `<div class="jp-en">${c.en}</div>` : ''}
        <div class="cs-set">${esc(c.rarity || c.set || '')}</div>
        ${c.price != null ? `<div class="cs-price">$${(+c.price).toFixed(2)}</div>` : '<div class="cs-price" style="color:var(--muted);font-size:9px;">priced on add</div>'}
      </div>
      <button class="cs-add" title="${inVault?'In vault':'Add to vault'}" style="${inVault?'background:var(--green);opacity:1;':''}"
        onclick="event.stopPropagation();jpPickCard('${key}')">${inVault?'✓':'+'}</button>
    </div>`;
  }).join('') || '<div style="grid-column:1/-1;padding:20px;font-size:12px;color:var(--muted);">No cards found.</div>';
}

// Image fallback: first onerror tries the JP-locale asset; second gives the placeholder.
function jpImgFallback(img){
  const alt = img.getAttribute('data-alt');
  if (alt && img.src.indexOf('/ja/') === -1) { img.removeAttribute('data-alt'); img.src = alt; return; }
  const ph = document.createElement('div'); ph.className = 'cs-img-ph'; ph.textContent = '\u{1F1EF}\u{1F1F5}';
  img.replaceWith(ph);
}

function jpPickCard(key){
  const c = (window._jpPick||{})[key]; if (!c) return;
  window._pendingLang = 'JP';   // saveCard persists lang:'JP' → pricing adds "Japanese" to eBay queries
  window._pendingSetEn = (window._jpSetMap && Object.values(window._jpSetMap).find(s => s.name === c.set)||{}).en || '';
  quickAdd({ id:'', name:(c.en || c.name), set:c.set, num:c.num, img:(c.imgHigh||c.img), rarity:c.rarity });
}

// English mode → show how many versions exist in the Japanese catalogue and let the
// user jump straight to them. Best-effort: stays silent if the lookup fails or finds
// nothing, so a slow/failed call never disrupts the English results.
async function jpAlsoAvailable(name){
  const host = document.getElementById('tab-search-jp-hint');
  if (!host) return;
  host.style.display = 'none'; host.innerHTML = '';
  const q = String(name||'').trim();
  if (!q || window._searchLang === 'JP') return;
  try {
    // Translate first so the count reflects the NATIVE Japanese catalogue, and read
    // j.total (true count) instead of the capped array length.
    const ja = await jpTranslateName(q);
    let r = await fetch(`${EBAY_WORKER}/jp-cards?search=${encodeURIComponent(ja || q)}&limit=300${ja ? '' : '&lang=en'}`);
    let j = await r.json();
    let n = (j && typeof j.total === 'number') ? j.total : ((j && Array.isArray(j.data)) ? j.data.length : 0);
    if (!n && ja) {
      r = await fetch(`${EBAY_WORKER}/jp-cards?search=${encodeURIComponent(q)}&limit=300&lang=en`);
      j = await r.json();
      n = (j && typeof j.total === 'number') ? j.total : ((j && Array.isArray(j.data)) ? j.data.length : 0);
    }
    if (!n) return;
    const safe = q.replace(/[^A-Za-z0-9 .'-]/g,'').replace(/'/g,"\\'");
    host.innerHTML = '<button class="jp-hint-btn" onclick="jpJumpToSearch(\'' + safe + '\')">' +
      '\u{1F1EF}\u{1F1F5} <b>' + n + '</b> version' + (n===1?'':'s') +
      ' in the Japanese catalogue <span class="jp-hint-arrow">\u2192</span></button>';
    host.style.display = '';
  } catch(_){}
}

// Switch to Japanese mode and re-run the same search there.
function jpJumpToSearch(q){
  const jpBtn = document.querySelector('#lang-toggle .era-pill[data-lang="JP"]');
  if (jpBtn) setSearchLang('JP', jpBtn, {keepQuery:true});   // no reset, no set-browser race
  const inp = document.getElementById('tab-search-input');
  if (inp) inp.value = q;
  // Clear the English RESULTS, but keep #tab-search-empty VISIBLE — the Japanese
  // browser (and the grid jpOnSearch renders into) lives inside it, so hiding it
  // meant the search ran and painted into a hidden container: nothing appeared.
  try {
    const e = document.getElementById('tab-search-empty'); if (e) e.style.display = '';
    const g = document.getElementById('tab-search-grid');  if (g) g.innerHTML = '';
    const p = document.getElementById('tab-search-pagination'); if (p) p.style.display = 'none';
    const h = document.getElementById('tab-search-jp-hint'); if (h) h.style.display = 'none';
    const c = document.getElementById('tab-search-count'); if (c) c.textContent = '';
    const l = document.getElementById('tab-search-loading'); if (l) l.style.display = 'none';
    // English-only chrome that would otherwise sit above the Japanese results
    const f = document.getElementById('tab-search-filters'); if (f) f.style.display = 'none';
    const era = document.getElementById('set-era-filters');  if (era) era.style.display = 'none';
  } catch(_){}
  jpOnSearch(q);
}

// English Pokémon name → Japanese, via the Worker's /jp-name route (PokeAPI,
// edge-cached 30d). Cached in localStorage permanently — names never change — so
// each Pokémon costs one request once, ever, on this device. Returns null when the
// term isn't a Pokémon (trainer cards etc.), and callers fall back to their existing
// search, so nothing regresses.
async function jpTranslateName(en){
  const q = String(en||'').trim();
  if (!q) return null;
  const key = 'pkjp_name_' + q.toLowerCase();
  try { const c = localStorage.getItem(key); if (c !== null) return c || null; } catch(_){}
  try {
    const j = await (await fetch(`${EBAY_WORKER}/jp-name?q=${encodeURIComponent(q)}`)).json();
    const ja = (j && j.ja) ? String(j.ja) : '';
    try { localStorage.setItem(key, ja); } catch(_){}
    return ja || null;
  } catch(_){ return null; }
}

function jpOnSearch(val){
  clearTimeout(_jpTimer);
  const q = String(val||'').trim();
  const cGrid = document.getElementById('cs-set-cards-grid');
  const grid  = document.getElementById('set-browser-grid');
  const load  = document.getElementById('cs-set-cards-loading');
  if (!q) { jpShowSets(); return; }
  _jpTimer = setTimeout(async () => {
    grid.style.display='none'; cGrid.style.display='none'; if (load) load.style.display='';
    document.getElementById('set-browser-set-label').textContent = 'Search: ' + q;
    jpTranslateName(q).then(ja => { if(ja){ const el=document.getElementById('set-browser-set-label'); if(el) el.textContent = 'Search: ' + q + ' \u00b7 ' + ja; } });
    document.getElementById('set-browser-set-name').style.display='inline-flex';
    const backBtn = document.getElementById('set-back-btn');
    if (backBtn) backBtn.style.display='inline-flex';
    try {
      // 1) Translate to the NATIVE Japanese name and search the ja catalogue
      //    ("Eevee" → イーブイ) — the most complete match, and the only way to reach
      //    Japan-exclusive cards that have no English record.
      // 2) Raw term against ja (handles already-Japanese input).
      // 3) TCGdex's en index as a last resort.
      let j = null, arr = [];
      const _ja = await jpTranslateName(q);
      if (_ja) {
        j = await (await fetch(`${EBAY_WORKER}/jp-cards?search=${encodeURIComponent(_ja)}&limit=300`)).json();
        arr = (j && Array.isArray(j.data)) ? j.data : [];
      }
      if (!arr.length) {
        j = await (await fetch(`${EBAY_WORKER}/jp-cards?search=${encodeURIComponent(q)}&limit=300`)).json();
        arr = (j && Array.isArray(j.data)) ? j.data : [];
      }
      if (!arr.length) {
        const je = await (await fetch(`${EBAY_WORKER}/jp-cards?search=${encodeURIComponent(q)}&limit=300&lang=en`)).json();
        if (je && Array.isArray(je.data) && je.data.length) { j = je; arr = je.data; }
      }
      if (j && j.error && !arr.length) throw new Error(String(j.error));
      const cards = arr.map(c => jpNormCard(c, ''));
      if (load) load.style.display='none';
      // TRUE total across every Japanese set. The Worker reports it separately from
      // the page slice — the old code printed the CAPPED array length, which is why
      // the hint always read exactly "60".
      const _total = (j && typeof j.total === 'number') ? j.total : cards.length;
      document.getElementById('set-browser-count').textContent = _total + ' cards';
      const _jaLbl = _ja ? ' \u00b7 ' + _ja : '';
      cGrid.innerHTML =
        '<div style="padding:10px 14px;border-bottom:1px solid var(--border);font-family:var(--mono);font-size:11px;color:var(--muted);background:var(--bg3);">'
        + '<b style="color:var(--text);">' + _total.toLocaleString() + '</b> Japanese card' + (_total===1?'':'s')
        + ' exist across all sets <span style="color:var(--muted2);">' + q + _jaLbl + '</span>'
        + (cards.length < _total ? ' <span style="color:var(--muted2);">\u00b7 showing ' + cards.length + '</span>' : '')
        + '</div>'
        + `<div class="cs-grid" id="jp-search-inner" style="max-height:none;padding:0;"></div>`;
      cGrid.style.display='';
      jpRenderCardsInto('jp-search-inner', cards);
    } catch(e) {
      if (load) load.style.display='none';
      cGrid.style.display='';
      cGrid.innerHTML = `<div style="padding:20px;font-size:12px;color:var(--red);line-height:1.6;">${jpErrMsg(e)}</div>`;
    }
  }, 350);
}
