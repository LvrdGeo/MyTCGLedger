/* ════════════════════════════════════════════════════════════════════════════
   MyTCG Ledger V6 - collection-views.js
   ────────────────────────────────────────────────────────────────────────────
   DOMAIN MODULE (collection browsing). Renders the PSA and Singles pages from
   values other layers already computed.

   OWNS:
     - liquidity        liqCache, liqCacheKey, readLiquidity, writeLiquidity,
                        getLiqScore, loadLiquidityScore, loadLiquidityForCards
                        Ownership resolved here (Batch 12 deferred it): the ONLY
                        consumer is appendSinglesChunk() in this same file, and
                        the badge it drives is a collection-view badge. Batch 10's
                        cache separation and Batch 11's corrected grader regex
                        /\bpsa\b|\bbgs\b|\bcgc\b|\bsgc\b/i move UNCHANGED.
     - PSA page         PSA_CHUNK, _psaCards/_psaCursor/_psaObserver,
                        _psaSentinel, appendPsaChunk, _renderPsaChunked,
                        renderPSA, psaTileHTML
     - Singles page     SINGLES_CHUNK, _singlesCards/_singlesCursor/
                        _singlesObserver, _singlesSentinel, appendSinglesChunk,
                        _renderSinglesChunked, renderSingles, singlesTileHTML,
                        setTypeFilter
     - shared atom      tileImage (used only by the two tile builders here)

   DOES NOT OWN: card CRUD and the card-detail modal (openDetail/editCard/delCard
   are call-time references from tile templates - the relationship is
   collection view -> card detail, never ownership), the scanner, pricing
   acquisition, valuation formulas, identity, persistence, portfolio, dashboard,
   sealed, search/catalogue, sync, navigation.

   LOAD-TIME DEPENDENCIES: none. Eight declarations only - no render, no fetch,
   no IntersectionObserver created, no DOM touched while loading.

   CALL-TIME DEPENDENCIES:
     core       esc, money, toast
     valuation  cardValue, cardPriceData, editionBadge, bestPrice
     storage    idbPut  (liquidity cache persistence, unchanged key 'liq_<id>')
     pricing    buildPriceStrip
     cards      openDetail, editCard, delCard   (tile actions)
     inline     collection, pcache, typeFilter, sortBy, fmtPrice, EBAY_WORKER,
                and the #page-psa / #page-singles markup
     external   Worker /active  (liquidity listing counts only)
   ════════════════════════════════════════════════════════════════════════════ */

// ═══ PSA SLABS ═══

// ════════════════════════════════════════════════════════════════════════════
// ── LIQUIDITY CACHE ──
// Liquidity records are NOT price records. They were previously written straight
// into `pcache` under a 'liq_<cardId>' key, so the price cache held two different
// value shapes — { ts, data } for prices and { ts, count } for liquidity — and a
// portfolio renderer was writing into the pricing layer's cache.
//
// Ownership is now explicit: liquidity lives in its own in-memory `liqCache`, and
// ONLY these three helpers touch it. Nothing else may treat a liquidity record as
// a price record.
//
// COMPATIBILITY (no migration, no data loss):
//   · Persistence is UNCHANGED — still idbPut() under the same 'liq_<id>' key in
//     the same IndexedDB store, so existing records stay readable and nothing is
//     rewritten or deleted.
//   · hydratePcache() still restores those keys into `pcache` (storage.js is
//     untouched), so readLiquidity() falls back to the legacy pcache location and
//     promotes the record into liqCache on read. Purely additive.
//   · TTL (1h), badge text/class, request shape and network frequency: unchanged.
// DEVICE-LOCAL: like pcache, liqCache is never part of collectAppData() and is
// not synced. Nothing new is written to the cloud.
// ════════════════════════════════════════════════════════════════════════════
const liqCache = {};
function liqCacheKey(card){ return 'liq_' + (card && card.id); }
// Canonical read: new cache first, then the legacy pcache location. Returns the
// stored { ts, count } record or null. Never throws on malformed input.
function readLiquidity(card){
  const k = liqCacheKey(card);
  let rec = liqCache[k];
  if (!rec) {
    const legacy = (typeof pcache !== 'undefined') ? pcache[k] : null;   // pre-Batch-10 records
    if (legacy && typeof legacy.count === 'number') { rec = legacy; liqCache[k] = legacy; }
  }
  return (rec && typeof rec.count === 'number' && typeof rec.ts === 'number') ? rec : null;
}
// Canonical write: in-memory liqCache + the unchanged IndexedDB key.
function writeLiquidity(card, count){
  const k = liqCacheKey(card);
  const rec = { ts: Date.now(), count };
  liqCache[k] = rec;
  try { idbPut(k, rec); } catch(_) {}
  return rec;
}

// ── Liquidity Score ──
function getLiqScore(count) {
  if (count >= 15) return { grade: 'A+', cls: 'aplus', label: 'Highly liquid — 15+ active listings' };
  if (count >= 8)  return { grade: 'A',  cls: 'a',     label: 'Liquid — 8-14 active listings' };
  if (count >= 4)  return { grade: 'B',  cls: 'b',     label: 'Moderate — 4-7 active listings' };
  if (count >= 2)  return { grade: 'C',  cls: 'c',     label: 'Slow — 2-3 active listings' };
  return               { grade: 'D',  cls: 'd',     label: 'Illiquid — 0-1 active listings' };
}

async function loadLiquidityScore(card) {
  const el = document.getElementById('liq-' + card.id);
  if (!el) return;

  // Check cache first (see LIQUIDITY CACHE above — no longer pcache)
  const cached = readLiquidity(card);
  if (cached && (Date.now() - cached.ts) < 3600000) { // 1hr cache
    const s = getLiqScore(cached.count);
    el.textContent = s.grade;
    el.className = `liq-badge liq-${s.cls}`;
    el.title = s.label;
    return;
  }

  try {
    const numClean = (card.num||'').split('/')[0];
    const isVintage = card.set && /base set|jungle|fossil|team rocket|gym heroes|gym challenge|neo genesis|neo discovery|neo destiny|neo revelation|e-card|skyridge|aquapolis|expedition|wizards/i.test(card.set);
    const grader = card.grade ? card.grade.split(' ')[0] : '';
    const gradeNum = card.grade ? card.grade.split(' ').slice(1).join(' ') : '';

    let q;
    if (card.type === 'graded' && card.grade) {
      q = isVintage
        ? `${card.name} ${card.set} ${grader} ${gradeNum}`
        : `${card.name} ${numClean} ${card.set} ${grader} ${gradeNum}`;
    } else {
      q = `${card.name} ${numClean} ${card.set} pokemon card`;
    }

    const r = await fetch(`${EBAY_WORKER}/active?q=${encodeURIComponent(q)}&limit=20`);
    if (!r.ok) throw new Error();
    const data = await r.json();

    // Filter to relevant listings only
    const items = (data.items||[]).filter(i => {
      if (card.type === 'graded') return /\bpsa\b|\bbgs\b|\bcgc\b|\bsgc\b/i.test(i.title||'');
      return true;
    });

    const count = items.length;
    writeLiquidity(card, count);

    const s = getLiqScore(count);
    if (el) {
      el.textContent = s.grade;
      el.className = `liq-badge liq-${s.cls}`;
      el.title = `Liquidity: ${s.grade} — ${s.label}`;
    }
  } catch(e) {
    if (el) { el.textContent = '?'; el.className = 'liq-badge liq-loading'; }
  }
}

// Load liquidity scores for visible cards with a delay to avoid hammering the worker
function loadLiquidityForCards(cards) {
  cards.forEach((card, i) => {
    setTimeout(() => loadLiquidityScore(card), i * 400);
  });
}

// ═══ Tier 2: PSA virtualization (chunked render + IntersectionObserver) ═══
// Mirrors the fixed Singles pattern: tile HTML, order, and the price loader are
// unchanged; only HOW MANY tiles are injected at once changes. No content-visibility
// rule is added (that was the Singles ordering bug).
const PSA_CHUNK = 60;
let _psaCards = [], _psaCursor = 0, _psaObserver = null;
function _psaSentinel(){
  const grid=document.getElementById('psa-grid');if(!grid)return null;
  let s=document.getElementById('psa-sentinel');
  if(!s){ s=document.createElement('div'); s.id='psa-sentinel'; s.style.cssText='height:1px;width:100%;'; grid.insertAdjacentElement('afterend',s); }
  return s;
}
function appendPsaChunk(){
  const grid=document.getElementById('psa-grid');if(!grid)return;
  const slice=_psaCards.slice(_psaCursor,_psaCursor+PSA_CHUNK);
  if(!slice.length){ if(_psaObserver){_psaObserver.disconnect();_psaObserver=null;} return; }
  grid.insertAdjacentHTML('beforeend', slice.map(psaTileHTML).join(''));
  _psaCursor+=slice.length;
  loadPricesForCards(slice);
  if(_psaCursor>=_psaCards.length && _psaObserver){ _psaObserver.disconnect(); _psaObserver=null; }
}
function _renderPsaChunked(slabs){
  const grid=document.getElementById('psa-grid');if(!grid)return;
  _psaCards=slabs;_psaCursor=0;
  grid.innerHTML='';
  appendPsaChunk();                       // first chunk + its price load
  if(_psaCursor<_psaCards.length){        // more remain → observe the sentinel
    const sent=_psaSentinel();const root=document.querySelector('.main');
    _psaObserver=new IntersectionObserver(es=>{ if(es.some(e=>e.isIntersecting)) appendPsaChunk(); },{root:root||null,rootMargin:'600px 0px'});
    if(sent)_psaObserver.observe(sent);
  }
}
function renderPSA(){
  const slabs=collection.filter(c=>c.type==='graded');
  const grid=document.getElementById('psa-grid');const empty=document.getElementById('psa-empty');
  document.getElementById('nb-psa').textContent=slabs.length;
  document.getElementById('psa-count-lbl').textContent=slabs.length+' slab'+(slabs.length!==1?'s':'');
  // Tier 2: reset PSA virtualization state for every (re)render path
  if(_psaObserver){_psaObserver.disconnect();_psaObserver=null;}
  _psaCards=[];_psaCursor=0;
  const _oldPsaSent=document.getElementById('psa-sentinel'); if(_oldPsaSent)_oldPsaSent.remove();
  if(!slabs.length){grid.innerHTML='';empty.style.display='block';return;}
  empty.style.display='none';
  _renderPsaChunked(slabs);
}
function psaTileHTML(card){
    const p=cardPriceData(card);const bp=cardValue(card);
    const paid=parseFloat(card.paid||0);const pnl=bp>0&&paid>0?bp-paid:null;
    const grader=(card.grade||'').split(' ')[0]||'PSA';const gradeN=(card.grade||'').split(' ').slice(1).join(' ')||'?';
    const img=p?.img||card.img||null;const tcgQ=encodeURIComponent(card.name+(card.num?' '+card.num:'')+' '+card.grade);
    return `<div class="psa-card">
      <div class="psa-img">${tileImage(img,card.name,{placeholder:'<div style="font-size:32px;color:var(--muted);">⟡</div>'})}
        <div class="psa-grade-b">${esc(gradeN)}</div><div class="psa-grader-b">${esc(grader)}</div>
      </div>
      <div class="psa-body">
        <div class="psa-name">${esc(card.name)}</div><div class="psa-set">${esc(card.set||'Unknown')}${card.num?' · #'+esc(card.num):''}${editionBadge(card)?' '+editionBadge(card):''}</div>
        <div class="psa-pr"><span style="color:var(--muted2)">Market</span><span style="font-family:var(--mono);font-weight:600;color:var(--green);">${bp>0?fmtPrice(bp):'—'}</span></div>
        ${paid>0?`<div class="psa-pr"><span style="color:var(--muted2)">Paid</span><span style="font-family:var(--mono);font-weight:600;">$${paid.toFixed(2)}</span></div>`:''}
        ${pnl!=null?`<div class="psa-pr"><span style="color:var(--muted2)">P&L</span><span style="font-family:var(--mono);font-weight:600;color:${pnl>=0?'var(--green)':'var(--red)'};">${pnl>=0?'+':''}${fmtPrice(pnl)}</span></div>`:''}
        <div class="psa-acts">
          <button class="btn btn-ghost btn-sm" onclick="openDetail('${card.id}')">Detail</button>
          <a href="https://www.ebay.com/sch/i.html?_nkw=${tcgQ}&LH_Sold=1&LH_Complete=1" target="_blank" class="btn btn-ghost btn-sm">eBay</a>
          <button class="btn btn-ghost btn-sm" onclick="editCard('${card.id}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:12px;height:12px"><path d="M11 4H4a2 2 0 0 0-2 2v14c0 1.1.9 2 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4z"/></svg></button>
        </div>
      </div>
    </div>`;
}

// ═══ ALL SINGLES ═══
// ── tileImage(): shared image atom (Phase 1: Singles + PSA only). Returns the
// inner <img>-or-placeholder ONLY — never the wrapper or overlays. Canonical
// attribute order: class · src · alt · loading · style · onerror. Verified
// byte-identical to the prior inline Singles/PSA output (string-diff harness).
function tileImage(src, alt, opts){
  opts = opts || {};
  const imgClass = opts.imgClass || '';
  const imgStyle = opts.imgStyle || '';
  const onerror  = (opts.onerror !== false);
  const placeholder = opts.placeholder || '';
  if (!src) return placeholder;
  // src/alt are user- or API-supplied — escape so a quote in a card name or image
  // URL cannot break out of the attribute. Output is byte-identical for plain text.
  return `<img${imgClass?` class="${imgClass}"`:''} src="${esc(src)}" alt="${esc(alt)}" loading="lazy"${imgStyle?` style="${imgStyle}"`:''}${onerror?` onerror="this.style.display='none'"`:''}>`;
}

// ═══ Tier 2: Singles virtualization (chunked render + IntersectionObserver) ═══
// Tile HTML, filters, sort, and the price/liquidity loaders are unchanged; only
// HOW MANY tiles are injected at once changes. Loaders are re-run per appended
// chunk (idempotent via the existing in-flight dedupe + cache).
const SINGLES_CHUNK = 60;
let _singlesCards = [], _singlesCursor = 0, _singlesObserver = null;
function _singlesSentinel(){
  const grid=document.getElementById('singles-grid');if(!grid)return null;
  let s=document.getElementById('singles-sentinel');
  if(!s){ s=document.createElement('div'); s.id='singles-sentinel'; s.style.cssText='height:1px;width:100%;'; grid.insertAdjacentElement('afterend',s); }
  return s;
}
function appendSinglesChunk(){
  const grid=document.getElementById('singles-grid');if(!grid)return;
  const slice=_singlesCards.slice(_singlesCursor,_singlesCursor+SINGLES_CHUNK);
  if(!slice.length){ if(_singlesObserver){_singlesObserver.disconnect();_singlesObserver=null;} return; }
  grid.insertAdjacentHTML('beforeend', slice.map(singlesTileHTML).join(''));
  _singlesCursor+=slice.length;
  loadPricesForCards(slice);
  loadLiquidityForCards(slice);
  if(_singlesCursor>=_singlesCards.length && _singlesObserver){ _singlesObserver.disconnect(); _singlesObserver=null; }
}
function _renderSinglesChunked(cards){
  const grid=document.getElementById('singles-grid');if(!grid)return;
  _singlesCards=cards;_singlesCursor=0;
  grid.innerHTML='';
  appendSinglesChunk();                       // first chunk + its price/liquidity load
  if(_singlesCursor<_singlesCards.length){    // more remain → observe the sentinel
    const sent=_singlesSentinel();const root=document.querySelector('.main');
    _singlesObserver=new IntersectionObserver(es=>{ if(es.some(e=>e.isIntersecting)) appendSinglesChunk(); },{root:root||null,rootMargin:'600px 0px'});
    if(sent)_singlesObserver.observe(sent);
  }
}
function renderSingles(){
  const singles=collection.filter(c=>c.type!=='graded');
  let cards=typeFilter?singles.filter(c=>c.type===typeFilter):singles;
  if(sortBy==='name')cards.sort((a,b)=>a.name.localeCompare(b.name));
  else if(sortBy==='value_desc')cards.sort((a,b)=>getBestCached(b)-getBestCached(a));
  const grid=document.getElementById('singles-grid');const empty=document.getElementById('singles-empty');
  document.getElementById('nb-singles').textContent=singles.reduce((s,c)=>s+(c.qty||1),0);
  document.getElementById('topbar-cnt').textContent=singles.reduce((s,c)=>s+(c.qty||1),0)+' cards';
  // Tier 2: reset Singles virtualization state for every (re)render path
  if(_singlesObserver){_singlesObserver.disconnect();_singlesObserver=null;}
  _singlesCards=[];_singlesCursor=0;
  const _oldSent=document.getElementById('singles-sentinel'); if(_oldSent)_oldSent.remove();
  if(!singles.length){grid.innerHTML='';empty.style.display='block';return;}
  empty.style.display='none';
  if(!cards.length){grid.innerHTML='<p style="color:var(--muted);font-size:12.5px;grid-column:1/-1;padding:10px 0;">No cards match this filter.</p>';return;}
  _renderSinglesChunked(cards);
}
function singlesTileHTML(card){
    const p=cardPriceData(card);
    const typeLabel={standard:'Standard',holo:'Holo',reverse:'Reverse',ex:'ex/GX/V',graded:'Graded'}[card.type]||card.type;
    const imgHtml=tileImage(p?.img||card.img,card.name,{placeholder:`<div style="font-size:28px;color:var(--muted);">${card.num?'#'+esc((card.num||'').split('/')[0]):'⟡'}</div>`});
    const priceHtml=p?buildPriceStrip(p,card):`<div class="ps-loading"><div class="spinner"></div>Fetching…</div>`;
    return `<div class="card-tile" id="tile-${card.id}" onclick="openDetail('${card.id}')">
      <div class="ct-img">${imgHtml}
        <div class="ct-badges"><span class="ct-badge type-${card.type}">${typeLabel}</span>${editionBadge(card)}</div>
        <span class="ct-cond cond-${card.cond}">${card.cond}</span>
        <div class="liq-badge liq-loading" id="liq-${card.id}" title="Liquidity Score — loading…">·</div>
      </div>
      <div class="ct-body">
        <div class="ct-name">${esc(card.name)}</div>
        <div class="ct-set">${esc(card.set||'Unknown')}${card.num?' · '+esc(card.num):''}${card.qty>1?' · ×'+esc(card.qty):''}</div>
        <div class="price-strip" id="ps-${card.id}">${priceHtml}</div>
        <div class="ct-actions" onclick="event.stopPropagation()">
          <button class="btn btn-ghost btn-sm" onclick="editCard('${card.id}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:12px;height:12px"><path d="M11 4H4a2 2 0 0 0-2 2v14c0 1.1.9 2 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4z"/></svg><span class="mob-btn-label">Edit</span></button>
          <button class="btn btn-danger btn-sm" onclick="delCard('${card.id}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:12px;height:12px"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg><span class="mob-btn-label">Del</span></button>
        </div>
      </div>
    </div>`;
}

function setTypeFilter(f,el){typeFilter=f;document.querySelectorAll('#page-singles .filter-chip:not([id^="stab"])').forEach(c=>c.classList.remove('active'));el.classList.add('active');renderSingles();}
