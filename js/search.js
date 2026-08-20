/* ════════════════════════════════════════════════════════════════════════════
   MyTCG Ledger V6 - search.js
   ────────────────────────────────────────────────────────────────────────────
   DOMAIN MODULE (English card discovery). Batch 22 estimated "Search + Sets" at
   162 lines; the real domain is 933. The "═══ NAV + MOBILE ═══" banner at the
   old line 4118 is MISLABELLED - everything under it up to the JP block is
   search, not navigation. Real nav (goPage/updateFab/mobile) lives ~600 lines
   further down and is NOT touched here.

   OWNS - four search surfaces plus the set browser:
     - add-modal search   onModalSearch, doModalSearch, modalPickCard
     - name dropdown      onNameSearch, doNameSearch, quickAdd
     - overview search    _ovTimer/_ovPage/_ovQuery/_ovTotal, onOverviewSearch,
                          closeOverviewSearch, showOverviewLoading,
                          doOverviewSearch, ovPickCard
     - card-search tab    _tabTimer/_tabPage/_tabQuery/_tabTotal/_tabSetFilter/
                          _tabRarity/TAB_PAGE_SIZE, initTabSearchSets,
                          onTabSearchSetFilter, rerunTabSearch, onTabSearch,
                          clearTabSearch, doTabSearch, tabPickCard,
                          setTabPageSize is NOT here (it sits in the JP region)
     - set browser        loadSets, renderSets, filterSets, openSet,
                          closeSetCards, setSearchMode, _browseEra/_browseSetId,
                          ERA_MAP, filterSetsByEra, renderSetBrowser,
                          browseSetById, browseSet, filterSetCards,
                          renderSetCardsGrid
     - query helpers      searchCountLine, buildDexNameQuery, buildNameQuery,
                          getPokemonDexNumber, POKEMON_DEX
     - TCG tier display   TCG_TIER_LABEL, TCG_TIER_ORDER, tcgTiers,
                          tcgPrimaryPrice, tcgVariantChips - verified
                          search-exclusive (zero references in any other module)
     - picker             pickerSelectType/WatchKind/Edition, pickerConfirm,
                          addToWatchlistFromPicker, prefillAddForm

   PICKER OWNERSHIP, finally resolved: Batch 16 left it out of wishlist.js and
   Batch 18 left it out of cards-crud.js, both calling it "search region". The
   graph now agrees - pickerConfirm's only entry points are inline HTML on the
   search picker, and its two callees (prefillAddForm, addToWatchlistFromPicker)
   are reached from nowhere else. It is search-owned UI that HANDS OFF to the
   other two domains.

   DOCUMENTED PRE-EXISTING MUTATION: addToWatchlistFromPicker pushes onto
   `wishlist` and calls save() directly rather than routing through wishlist.js.
   Pre-existing, moved unchanged, NOT rewired.

   DOES NOT OWN: the JP catalogue (js stays inline - see below), cards CRUD
   (saveCard/openAddModal/selectType/updateAddPreview are call-time handoffs),
   wishlist lifecycle, card detail, pricing, sealed, scanner, portfolio,
   nav/bootstrap, sync, storage.

   SEARCH <-> JP: MUTUAL, CALL-TIME ONLY - measured after the boundary widened.
   An early scan over the narrow 3949-4117 range reported "search -> JP = 0";
   that was an artefact of the range, not the truth. The real edges are:
       search -> JP  (2)  onTabSearch  -> jpOnSearch      when _searchLang==='JP'
                          doTabSearch  -> jpAlsoAvailable offers JP versions
       JP -> search  (1)  jpPickCard   -> quickAdd
   All three fire only on user interaction. search.js executes nothing at load,
   and the JP block is inline (loading AFTER this file), so the mutual reference
   can never resolve during evaluation - there is no load-time cycle. This is the
   same shape already accepted for sealed <-> portfolio in Batch 12.
   ebayCardQuery / jpEnSetName / jpSearchTerms / JP_SET_EN stay inline with the
   JP block; card-detail.js keeps consuming them exactly as before.

   LOAD-TIME DEPENDENCIES: none. 12 declarations only - no search runs, no set
   list is fetched, nothing renders at load. loadSets() is called by init().

   CALL-TIME DEPENDENCIES:
     core       esc, money, toast, openModal, closeModal
     valuation  cardEdition / edition helpers
     storage    save   (via addToWatchlistFromPicker)
     cards-crud openAddModal, selectType, selectCond, selectEdition,
                updateAddPreview, refreshEditionSection
     inline     collection, wishlist, allSets, keys, editingId, and the
                #page-singles / #add-modal / #set-* / #ov-* / #tab-* DOM
     external   api.pokemontcg.io (cards + sets)
   ════════════════════════════════════════════════════════════════════════════ */

// ═══ SEARCH + SETS ═══
function onModalSearch(val){
  updateAddPreview();
  clearTimeout(window._modalSearchTimer);
  const dd=document.getElementById('modal-name-dd');
  if(!val.trim()){dd.classList.remove('open');return;}
  if(val.trim().length<3){
    dd.classList.add('open');
    dd.innerHTML='<div style="padding:10px 14px;font-size:12px;color:var(--muted);">Keep typing… (3+ characters)</div>';
    return;
  }
  dd.classList.add('open');
  dd.innerHTML='<div class="sd-loading"><div class="spinner"></div>Searching…</div>';
  window._modalSearchTimer=setTimeout(()=>doModalSearch(val),400);
}
async function doModalSearch(q){
  const dd=document.getElementById('modal-name-dd');
  try{
    // Use dex number for known pokemon, name search for everything else
    const dexNum = getPokemonDexNumber(q);
    const qStr   = dexNum ? buildDexNameQuery(q, dexNum) : buildNameQuery(q);
    const r=await ptcgFetch(`/cards?q=${encodeURIComponent(qStr)}&orderBy=-set.releaseDate&pageSize=60`);
    if(!r.ok)throw new Error('API '+r.status);
    const j=await r.json();
    if(!j.data?.length){dd.innerHTML='<div style="padding:12px 14px;font-size:12px;color:var(--muted);">No cards found for "'+q+'"</div>';return;}
    dd.innerHTML=searchCountLine(j,q,{compact:true})+j.data.map(c=>{
      const tier=c.tcgplayer?.prices?Object.values(c.tcgplayer.prices)[0]:null;
      const price=tier?.market||null;
      const key='md_'+c.id.replace(/[^a-z0-9]/gi,'_');
      window._mdCards=window._mdCards||{};
      window._mdCards[key]={id:c.id,name:c.name,set:c.set?.name||'',num:c.number||'',img:c.images?.large||c.images?.small||'',rarity:c.rarity||''};
      return `<div class="sd-item" onclick="modalPickCard(window._mdCards['${key}'])">
        ${c.images?.small?`<img class="sd-thumb" src="${c.images.small}" alt="${esc(c.name)}" loading="lazy">`:'<div class="sd-ph">⟡</div>'}
        <div style="min-width:0;flex:1;">
          <div class="sd-name">${esc(c.name)}</div>
          <div class="sd-meta">${esc(c.set?.name||'')} · #${esc(c.number||'?')} · <span style="color:var(--muted)">${esc(c.rarity||'')}</span></div>
        </div>
        <div class="sd-price">${price!=null?`<div class="sd-pval">$${price.toFixed(2)}</div><div class="sd-plbl">TCGPlayer</div>`:'<div class="sd-plbl" style="font-size:11px;">Select</div>'}</div>
      </div>`;
    }).join('');
  }catch(e){dd.innerHTML='<div style="padding:12px 14px;font-size:12px;color:var(--muted);">Search failed — check pokemontcg.io key in Settings.</div>';}
}
function modalPickCard(card){
  const dd=document.getElementById('modal-name-dd');
  dd.classList.remove('open');
  // Fill in all the fields
  document.getElementById('f-name').value=card.name;
  document.getElementById('f-set').value=card.set;
  document.getElementById('f-num').value=card.num;
  document.getElementById('f-cardid').value=card.id;
  document.getElementById('f-img').value=card.img;
  // Auto-detect type from rarity
  const r=(card.rarity||'').toLowerCase();
  let gt='standard';
  if(r.includes('ex')||r.includes('gx')||r.includes(' v')||r.includes('vmax')||r.includes('vstar'))gt='ex';
  else if(r.includes('holo'))gt='holo';
  else if(r.includes('reverse'))gt='reverse';
  const tP=document.querySelector(`.type-pill[data-val="${gt}"]`);
  if(tP)selectType(gt,tP);
  // Update the preview at the top of the modal
  updateAddPreview();
}
// Close modal dropdown when clicking outside
// (dismiss listener moved to initGlobalListeners — see APPLICATION BOOTSTRAP)
function onNameSearch(val){clearTimeout(searchTimer);const dd=document.getElementById('name-dd');if(!val.trim()){dd.classList.remove('open');return;}dd.classList.add('open');dd.innerHTML='<div class="sd-loading"><div class="spinner"></div>Searching…</div>';searchTimer=setTimeout(()=>doNameSearch(val),350);}
async function doNameSearch(q){
  const dd=document.getElementById('name-dd');
  try{const r=await ptcgFetch(`/cards?q=${encodeURIComponent(buildNameQuery(q))}&orderBy=-set.releaseDate&pageSize=60`);if(!r.ok)throw new Error();const j=await r.json();
    if(!j.data?.length){dd.innerHTML='<div style="padding:14px;font-size:12px;color:var(--muted);">No cards found.</div>';return;}
    dd.innerHTML=searchCountLine(j,q,{compact:true})+j.data.map(c=>{const tier=c.tcgplayer?.prices?Object.values(c.tcgplayer.prices)[0]:null;const price=tier?.market||null;const key='sd_'+c.id.replace(/[^a-z0-9]/gi,'_');window._sdCards=window._sdCards||{};window._sdCards[key]={id:c.id,name:c.name,set:c.set?.name||'',num:c.number||'',img:c.images?.large||c.images?.small||'',rarity:c.rarity||''};
      return `<div class="sd-item" onclick="quickAdd(window._sdCards['${key}'])">${c.images?.small?`<img class="sd-thumb" src="${c.images.small}" alt="${esc(c.name)}" loading="lazy">`:'<div class="sd-ph">⟡</div>'}<div style="min-width:0;"><div class="sd-name">${esc(c.name)}</div><div class="sd-meta">${esc(c.set?.name||'')} · #${esc(c.number||'?')} · ${esc(c.rarity||'')}</div></div><div class="sd-price">${price!=null?`<div class="sd-pval">$${price.toFixed(2)}</div><div class="sd-plbl">TCGPlayer</div>`:'<div class="sd-plbl">Click to add</div>'}</div></div>`;}).join('');
  }catch(e){dd.innerHTML='<div style="padding:14px;font-size:12px;color:var(--muted);">Search failed. Check pokemontcg.io key.</div>';}
}
// (dismiss listener moved to initGlobalListeners — see APPLICATION BOOTSTRAP)

function quickAdd(card){document.getElementById('name-dd').classList.remove('open');document.getElementById('name-search').value='';_pickerCard=card;document.getElementById('picker-img').src=card.img;document.getElementById('picker-img').style.display=card.img?'':'none';document.getElementById('picker-img-ph').style.display=card.img?'none':'';document.getElementById('picker-name').textContent=card.name;document.getElementById('picker-meta').textContent=[card.set,card.num?'#'+card.num:'',card.rarity].filter(Boolean).join(' · ');document.getElementById('picker-graded-panel').style.display='none';document.getElementById('picker-grade-sel').value='10';document.getElementById('picker-cert').value='';document.getElementById('picker-grader').value='PSA';document.querySelectorAll('.picker-choice').forEach(b=>b.style.borderColor='');document.getElementById('picker-confirm-btn').disabled=true;_pickerEdition='unlimited';const _pe=editionEligibility({cardId:card.id,set:card.set,type:'standard'});const _per=document.getElementById('picker-edition-row');if(_pe.eligible){_per.style.display='';document.getElementById('picker-ed-shadowless').style.display=_pe.shadowless?'':'none';document.querySelectorAll('#picker-edition-row .ed-pill').forEach(p=>p.classList.toggle('active',p.dataset.val==='unlimited'));}else{_per.style.display='none';}document.getElementById('picker-watch-panel').style.display='none';_pickerWatchKind='single';document.querySelectorAll('#picker-watch-panel .ed-pill').forEach(b=>b.classList.toggle('active',b.dataset.kind==='single'));document.getElementById('picker-watch-grade').style.display='none';document.getElementById('picker-watch-grader').value='PSA';document.getElementById('picker-watch-grade-sel').value='10';openModal('card-picker-modal');}
function pickerSelectType(type,el){document.querySelectorAll('.picker-choice').forEach(b=>b.style.borderColor='var(--border)');el.style.borderColor='var(--gold)';document.getElementById('picker-graded-panel').style.display=type==='graded'?'':'none';document.getElementById('picker-watch-panel').style.display=type==='watchlist'?'':'none';document.getElementById('picker-confirm-btn').disabled=false;}
function pickerSelectWatchKind(kind,el){_pickerWatchKind=kind;document.querySelectorAll('#picker-watch-panel .ed-pill').forEach(b=>b.classList.remove('active'));if(el)el.classList.add('active');document.getElementById('picker-watch-grade').style.display=kind==='graded'?'grid':'none';}
function pickerSelectEdition(val,el){_pickerEdition=val;document.querySelectorAll('#picker-edition-row .ed-pill').forEach(p=>p.classList.remove('active'));if(el)el.classList.add('active');}
function pickerConfirm(){
  const sel=document.querySelector('.picker-choice[style*="gold"]');
  if(!sel)return;
  const type=sel.dataset.type;
  closeModal('card-picker-modal');
  if(type==='watchlist'){
    let grade='';
    if(_pickerWatchKind==='graded'){
      grade=document.getElementById('picker-watch-grader').value+' '+document.getElementById('picker-watch-grade-sel').value;
    }
    addToWatchlistFromPicker(_pickerCard,_pickerEdition,_pickerWatchKind,grade);
  } else {
    prefillAddForm({..._pickerCard,edition:_pickerEdition},type);
  }
}
function addToWatchlistFromPicker(card,edition,kind,grade){
  if(!card)return;
  const existing=wishlist.find(w=>((w.cardId&&w.cardId===card.id)||(w.name===card.name&&w.set===card.set))&&(w.type||'single')===(kind||'single')&&(w.grade||'')===(grade||''));
  if(existing){toast('Already on watchlist','gold');return;}
  wishlist.push({
    id:newId('w'),
    name:card.name,
    set:card.set||'',
    num:card.num||'',
    cardId:card.id||'',
    img:card.img||'',
    rarity:card.rarity||'',
    edition:edition||'unlimited',
    type:kind||'single',
    grade:grade||'',
    added:new Date().toISOString()
  });
  save();
  renderWishlist();
  const kindLabel=kind==='graded'?(grade||'Graded'):kind==='sealed'?'Sealed':'Single';
  toast(card.name+' ('+kindLabel+') added to Watchlist','green');
}
function prefillAddForm(card,chosenType){editingId=null;window._pendingWishRemoval=null;document.getElementById('modal-title').textContent='Add Card';document.getElementById('f-name').value=card.name;document.getElementById('f-set').value=card.set;document.getElementById('f-num').value=card.num;document.getElementById('f-cardid').value=card.id;document.getElementById('f-img').value=card.img;document.getElementById('f-qty').value=1;document.getElementById('f-paid').value='';document.getElementById('f-notes').value='';document.getElementById('cert-msg').innerHTML='';window._pendingRarity=card.rarity||'';{const _pv=/reverse/i.test(card.rarity||'')?'reverse':/holo/i.test(card.rarity||'')?'holo':'';const _pvP=document.querySelector(`#variant-pills .var-pill[data-val="${_pv}"]`);if(_pvP)selectVariant(_pv,_pvP);}
  if(chosenType==='graded'){const grader=document.getElementById('picker-grader').value;const grade=document.getElementById('picker-grade-sel').value;const cert=document.getElementById('picker-cert').value.trim();const tP=document.querySelector('.type-pill[data-val="graded"]');if(tP)selectType('graded',tP);document.getElementById('f-grader').value=grader;document.getElementById('f-grade-sel').value=grade;document.getElementById('f-cert').value=cert;document.getElementById('f-grade').value=grader+' '+grade;document.getElementById('f-cond').value='NM';}
  else{const r=(card.rarity||'').toLowerCase();let gt='standard';if(r.includes('ex')||r.includes('gx')||r.includes(' v')||r.includes('vmax'))gt='ex';else if(r.includes('holo'))gt='holo';else if(r.includes('reverse'))gt='reverse';const tP=document.querySelector(`.type-pill[data-val="${gt}"]`);if(tP)selectType(gt,tP);const cP=document.querySelector('.cond-pill[data-val="NM"]');if(cP)selectCond('NM',cP);document.getElementById('f-grade').value='';document.getElementById('f-cert').value='';}
  document.getElementById('f-edition').value=(card.edition||'unlimited');refreshEditionSection();const _pcEd=document.getElementById('f-edition').value;const _pcP=document.querySelector(`#edition-section .ed-pill[data-val="${_pcEd}"]`);if(_pcP)selectEdition(_pcEd,_pcP);
  updateAddPreview();openModal('add-modal');}

async function loadSets(){
  const CACHE_KEY = 'pkv2_sets_cache';
  const CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days — sets change rarely
  const paint = () => {
    renderSets(allSets);
    renderSealedSets(allSets);
    const lbl = document.getElementById('set-cnt-lbl');
    if (lbl) lbl.textContent = allSets.length + ' sets';
    if (document.getElementById('page-cardsearch')?.classList.contains('active')) renderSetBrowser();
  };
  // 1) Serve cached sets instantly (stale-while-revalidate) — this is the speedup.
  let servedFromCache = false;
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw) {
      const cached = JSON.parse(raw);
      if (cached && Array.isArray(cached.data) && cached.data.length) {
        allSets = cached.data;
        paint();
        servedFromCache = true;
        if (Date.now() - (cached.ts || 0) < CACHE_TTL) return; // fresh — skip the network entirely
      }
    }
  } catch(e) {}
  // 2) Fetch fresh (first load, or cache stale) and update cache + UI on success.
  try {
    const r = await ptcgFetch('/sets?orderBy=-releaseDate');
    if(!r.ok) throw new Error();
    const j = await r.json();
    const data = j.data || [];
    if (data.length) {
      allSets = data;
      try { localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), data })); } catch(e){}
      paint();
    }
  } catch(e) {
    if (!servedFromCache) document.getElementById('set-list').innerHTML='<p style="font-size:12px;color:var(--muted);padding:8px;">Set browser unavailable — add pokemontcg.io key in Settings.</p>';
  }
}
function renderSets(sets){document.getElementById('set-list').innerHTML=sets.map(s=>{const logo=s.images?.logo?`<img class="set-logo" src="${esc(s.images.logo)}" alt="${esc(s.name)}" loading="lazy" onerror="this.style.display='none'">`:'<div class="set-logo-ph"></div>';return `<div class="set-item" onclick="openSet('${s.id}','${s.name.replace(/'/g,"\\'")}',event)">${logo}<div style="min-width:0;flex:1;"><div class="set-name">${esc(s.name)}</div><div class="set-year">${(s.releaseDate||'').slice(0,4)} · ${s.total||'?'} cards</div></div></div>`;}).join('');}
function filterSets(q){const f=q?allSets.filter(s=>s.name.toLowerCase().includes(q.toLowerCase())):allSets;renderSets(f);document.getElementById('set-cnt-lbl').textContent=f.length+' sets';}
async function openSet(id,name,e){document.querySelectorAll('#page-singles .set-item').forEach(el=>el.classList.remove('active'));e?.currentTarget?.classList.add('active');const panel=document.getElementById('set-cards-panel');const grid=document.getElementById('set-cards-grid');document.getElementById('set-cards-title').textContent=name;panel.classList.add('open');grid.innerHTML='<div style="padding:16px;color:var(--muted);font-size:12px;display:flex;align-items:center;gap:8px;"><div class="spinner"></div>Loading…</div>';try{const r=await ptcgFetch(`/cards?q=set.id:${id}&orderBy=number&pageSize=250`);if(!r.ok)throw new Error();const j=await r.json();window._setCards={};grid.innerHTML=j.data.map(c=>{const key='sc_'+c.id.replace(/[^a-z0-9]/gi,'_');window._setCards[key]={id:c.id,name:c.name,set:c.set?.name||'',num:c.number||'',img:c.images?.small||'',rarity:c.rarity||''};return `<div class="set-card-item" onclick="quickAdd(window._setCards['${key}'])">${c.images?.small?`<img src="${c.images.small}" alt="${esc(c.name)}" loading="lazy">`:'<div style="aspect-ratio:3/4;display:flex;align-items:center;justify-content:center;font-size:22px;color:var(--muted);">⟡</div>'}<div class="sc-name">${esc(c.name)}</div><div class="sc-num">#${c.number}</div></div>`;}).join('');}catch(e){grid.innerHTML='<p style="font-size:12px;color:var(--muted);padding:8px;">Failed to load set cards.</p>';}}
function closeSetCards(){document.getElementById('set-cards-panel').classList.remove('open');document.querySelectorAll('#page-singles .set-item').forEach(el=>el.classList.remove('active'));}
function setSearchMode(mode,el){document.querySelectorAll('.filter-chip[id^="stab"]').forEach(b=>b.classList.remove('active'));el.classList.add('active');document.getElementById('mode-name').style.display=mode==='name'?'':'none';document.getElementById('mode-set').style.display=mode==='set'?'':'none';}

// ═══ NAV + MOBILE ═══

// ── Overview Card Search ──
let _ovTimer = null;
let _ovPage  = 1;
let _ovQuery = '';
let _ovTotal = 0;

function onOverviewSearch(val){
  clearTimeout(_ovTimer);
  const clr = document.getElementById('overview-clear');
  if(clr) clr.style.display = val ? '' : 'none';
  if(!val.trim()){closeOverviewSearch();return;}
  showOverviewLoading();
  _ovTimer = setTimeout(()=>doOverviewSearch(val,1), 500);
}

function closeOverviewSearch(){
  document.getElementById('overview-results').style.display='none';
  document.getElementById('overview-clear').style.display='none';
}

function showOverviewLoading(){
  const res = document.getElementById('overview-results');
  res.style.display='';
  document.getElementById('overview-results-grid').innerHTML=
    '<div class="cs-loading"><div class="spinner"></div>Searching all sets…</div>';
}

async function doOverviewSearch(q, page=1){
  _ovQuery = q;
  _ovPage  = page;
  const res  = document.getElementById('overview-results');
  const grid = document.getElementById('overview-results-grid');
  res.style.display='';
  if(page===1) grid.innerHTML='<div class="cs-loading"><div class="spinner"></div>Searching all sets…</div>';

  try{
    const pageSize = 24;
    const url = `${PTCG_BASE}/cards?q=${encodeURIComponent(buildNameQuery(q))}&orderBy=-set.releaseDate&pageSize=${pageSize}&page=${page}`;
    const r = await fetch(url, {headers:ptcgHeaders()});
    if(!r.ok) throw new Error();
    const j = await r.json();
    _ovTotal = j.totalCount || 0;

    if(!j.data?.length){
      grid.innerHTML=`<div class="cs-empty">No cards found for "<b>${q}</b>"<br><span style="font-size:11px;color:var(--muted);">Try a different name or check your pokemontcg.io key</span></div>`;
      return;
    }

    const cards = j.data;
    const showing = (page-1)*pageSize + cards.length;

    const html = `
      <div class="cs-header">
        <span>${_ovTotal.toLocaleString()} results for "${q}"</span>
        <span>Showing ${showing} of ${_ovTotal}</span>
      </div>
      <div class="cs-grid">
        ${cards.map(card=>{
          const tier  = card.tcgplayer?.prices ? Object.values(card.tcgplayer.prices)[0] : null;
          const price = tier?.market || null;
          const key   = 'ov_'+card.id.replace(/[^a-z0-9]/gi,'_');
          window._ovCards = window._ovCards||{};
          window._ovCards[key] = {id:card.id,name:card.name,set:card.set?.name||'',num:card.number||'',img:card.images?.large||card.images?.small||'',rarity:card.rarity||''};
          const inVault = collection.some(c=>c.cardId===card.id||( c.name===card.name&&c.num===card.number&&c.set===card.set?.name));
          return `<div class="cs-card" onclick="ovPickCard(window._ovCards['${key}'])">
            <div class="cs-img-wrap">
              ${card.images?.small?`<img src="${card.images.small}" alt="${card.name}" loading="lazy">`:'<div class="cs-img-ph">⟡</div>'}
            </div>
            <div class="cs-body">
              <div class="cs-set-pill">${card.set?.name||'Unknown'} · #${card.number||'?'}</div>
              <div class="cs-name">${esc(card.name)}</div>
              <div class="cs-set">${esc(card.rarity||'')}</div>
              ${price?`<div class="cs-price">$${price.toFixed(2)}</div>`:'<div class="cs-price" style="color:var(--muted);">—</div>'}
            </div>
            <button class="cs-add" title="${inVault?'Already in vault':'Add to vault'}" style="${inVault?'background:var(--green);opacity:1;':''}">${inVault?'✓':'+'}</button>
          </div>`;
        }).join('')}
      </div>
      <div class="cs-footer">
        <span style="color:var(--muted);">${_ovTotal > showing ? `${_ovTotal-showing} more results` : 'All results shown'}</span>
        <div style="display:flex;gap:8px;">
          ${page>1?`<button class="btn btn-ghost btn-xs" onclick="doOverviewSearch('${q}',${page-1})">← Prev</button>`:''}
          ${_ovTotal > showing?`<button class="btn btn-primary btn-xs" onclick="doOverviewSearch('${q}',${page+1})">Next ${Math.min(pageSize,_ovTotal-showing)} →</button>`:''}
        </div>
      </div>`;

    grid.innerHTML = html;
  }catch(e){
    grid.innerHTML='<div class="cs-empty">Search failed — check your pokemontcg.io key in Settings.</div>';
  }
}

function ovPickCard(card){
  // Open the card picker modal same as quickAdd from Singles search
  quickAdd(card);
}

// Close on outside click
// (dismiss listener moved to initGlobalListeners — see APPLICATION BOOTSTRAP)


// ── Card Search Tab ──
let _tabTimer   = null;
let _tabPage    = 1;
let _tabQuery   = '';
let _tabTotal   = 0;
let _tabSetFilter = '';
let _tabRarity  = '';
let TAB_PAGE_SIZE = 40;

// Populate set dropdown from allSets when page is opened
function initTabSearchSets(){
  const sel = document.getElementById('tab-search-set');
  if(!sel || sel.options.length > 1) return; // already populated
  allSets.forEach(s=>{
    const o = document.createElement('option');
    o.value = s.name; o.textContent = s.name + ' ('+((s.releaseDate||'').slice(0,4))+')';
    sel.appendChild(o);
  });
}

function onTabSearchSetFilter(){
  _tabSetFilter = document.getElementById('tab-search-set').value;
  rerunTabSearch();
}

function rerunTabSearch(){
  _tabRarity = document.getElementById('tab-search-rarity').value;
  if(_tabQuery) doTabSearch(_tabQuery, 1);
}

function onTabSearch(val){
  clearTimeout(_tabTimer);
  document.getElementById('tab-search-clear').style.display = val ? '' : 'none';
  if (window._searchLang === 'JP') { jpOnSearch(val); return; }   // JP mode (2026-07)
  if(!val.trim()){ clearTabSearch(); return; }
  // Don't fire until user has typed at least 3 characters
  if(val.trim().length < 3){
    document.getElementById('tab-search-grid').innerHTML = '';
    document.getElementById('tab-search-pagination').style.display = 'none';
    document.getElementById('tab-search-loading').style.display = 'none';
    document.getElementById('tab-search-empty').style.display = '';
    document.getElementById('tab-search-empty').innerHTML = '<div style="font-size:40px;margin-bottom:12px;opacity:.2;">🔍</div><div style="font-size:14px;font-weight:600;color:var(--text);margin-bottom:6px;">Keep typing…</div><div style="font-size:12px;">Enter at least 3 characters to search</div>';
    return;
  }
  // Show loading spinner but don't update _tabQuery yet — wait for result
  document.getElementById('tab-search-loading').style.display = '';
  document.getElementById('tab-search-empty').style.display   = 'none';
  document.getElementById('tab-search-grid').innerHTML        = '';
  document.getElementById('tab-search-pagination').style.display = 'none';
  // 500ms debounce — long enough that user finishes typing
  _tabTimer = setTimeout(()=>doTabSearch(val, 1), 500);
}

function clearTabSearch(){
  _tabQuery = '';
  document.getElementById('tab-search-grid').innerHTML = '';
  document.getElementById('tab-search-empty').style.display   = '';
  document.getElementById('tab-search-loading').style.display = 'none';
  document.getElementById('tab-search-pagination').style.display = 'none';
  document.getElementById('tab-search-count').textContent = '';
  document.getElementById('tab-search-clear').style.display = 'none';
  // Restore set browser
  closeBrowseSet();
  renderSetBrowser();
}

async function doTabSearch(q, page=1){
  _tabPage  = page;
  _tabQuery = q;  // only set now that we're actually running the search
  _tabRarity = document.getElementById('tab-search-rarity').value;
  _tabSetFilter = document.getElementById('tab-search-set').value;

  const grid   = document.getElementById('tab-search-grid');
  const loader = document.getElementById('tab-search-loading');
  const empty  = document.getElementById('tab-search-empty');
  const pager  = document.getElementById('tab-search-pagination');
  const count  = document.getElementById('tab-search-count');

  loader.style.display = '';
  empty.style.display  = 'none';
  grid.innerHTML       = '';
  pager.style.display  = 'none';

  try{
    // Build query: search by name, but if we know the dex number use that too
  // This catches ALL cards featuring that Pokémon (e.g. "Brock's Mudkip", promos, etc.)
  // Support "name + number" searches: "pidgeot ex 97", "2016 pidgeot ex 97", "097", "97/87".
  let _work = q.trim();
  _work = _work.replace(/^(19|20)\d{2}\s+/, '');                 // strip a leading year
  let _cardNum = null;
  const _nm = _work.match(/\s(\d{1,3})(?:\/\d{1,3})?$/);          // trailing card number
  if (_nm) { _cardNum = _nm[1].replace(/^0+/, '') || _nm[1]; _work = _work.slice(0, _nm.index).trim(); }
  const dexNum = getPokemonDexNumber(_work);
  let qStr;
  if (_cardNum && _work) {
    // explicit name + number → precise hit. Wildcard name dodges apostrophes/punct.
    const _loose = _work.replace(/[^A-Za-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
    qStr = `name:*${_loose.replace(/ /g,'*')}* number:${_cardNum}`;
  } else if (dexNum) {
    // Dex number alone MISSES vintage cards: many WOTC-era prints (Jungle 1999,
    // Gym, Neo…) have no nationalPokedexNumbers field in pokemontcg.io, so a pure
    // dex query silently drops the entire back catalogue (Eevee returned 85 cards,
    // none older than 2019). OR the dex match with a name match so we get both the
    // dex-indexed cards AND every card actually named after the Pokémon.
    qStr = buildDexNameQuery(_work || q, dexNum);
  } else if (_work || q) {
    const _ln = (_work || q).replace(/[^A-Za-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
    qStr = _ln ? `name:*${_ln.replace(/ /g,'*')}*` : '';
  } else {
    qStr = '';   // no search text — browse by set/rarity filter alone
  }
    // Set filter: wildcard the set name so apostrophes (McDonald's) don't break Lucene.
    if(_tabSetFilter){
      const _sl = _tabSetFilter.replace(/[^A-Za-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
      const _sq = _sl ? `set.name:*${_sl.replace(/ /g,'*')}*` : '';
      qStr = qStr ? `${qStr} ${_sq}` : _sq;
    }
    if(_tabRarity)    qStr = qStr ? `${qStr} rarity:"${_tabRarity}"` : `rarity:"${_tabRarity}"`;
    // If somehow still empty (shouldn't happen), bail gracefully.
    if(!qStr.trim()){ loader.style.display='none'; empty.style.display=''; return; }

    // NOTE: pokemontcg.io's select= mangles nested objects (images, tcgplayer) — it can
    // drop the real image URL so cards render as blank card-backs. We fetch full objects
    // for correctness; the number-sort + cache below still keep set-browsing fast.
    const _order  = (_tabSetFilter && !_work && !_cardNum) ? 'number' : '-set.releaseDate';

    // pokemontcg.io's Lucene backend intermittently 500s on some wildcard/OR shapes
    // ("Pidge" works, "Pidgey" errors — same dex, same structure). Rather than guess
    // which terms it dislikes, try progressively simpler queries and use the first
    // that answers. Only a total failure surfaces an error to the user.
    const _suffix = qStr.replace(/^\((?:[^)]*)\)\s*/, '').trim();   // trailing set/rarity filters
    const _candidates = [qStr];
    if (dexNum) {
      const _dexQ = `nationalPokedexNumbers:${dexNum}`;
      _candidates.push(_suffix ? `${_dexQ} ${_suffix}` : _dexQ);      // dex only
      const _nm = (_work || q).replace(/[^A-Za-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
      if (_nm) {
        const _nameQ = `name:*${_nm.replace(/ /g,'*')}*`;
        _candidates.push(_suffix ? `${_nameQ} ${_suffix}` : _nameQ);  // name only
      }
    }

    window._tabCache = window._tabCache || {};
    let j = null, _lastErr = null, url = '';
    for (const _q of _candidates) {
      url = `${PTCG_BASE}/cards?q=${encodeURIComponent(_q)}&orderBy=${_order}&pageSize=${TAB_PAGE_SIZE}&page=${page}`;
      const _cached = window._tabCache[url];
      if (_cached && (Date.now() - _cached.t) < 300000) { j = _cached.j; break; }
      try {
        const r = await fetch(url, {headers:ptcgHeaders()});
        if (!r.ok) { _lastErr = new Error('API error ' + r.status); continue; }
        j = await r.json();
        window._tabCache[url] = { j, t: Date.now() };
        break;
      } catch(err) { _lastErr = err; }
    }
    if (!j) throw (_lastErr || new Error('Search unavailable'));
    _tabTotal = j.totalCount || 0;
    loader.style.display = 'none';

    if(!j.data?.length){
      empty.style.display = '';
      empty.innerHTML = `<div style="font-size:40px;margin-bottom:12px;opacity:.2;">🔍</div><div style="font-size:14px;font-weight:600;color:var(--text);margin-bottom:6px;">No results for "${q}"</div><div style="font-size:12px;">Try a broader name or remove filters</div>`;
      count.textContent = '';
      return;
    }

    const showing = (page-1)*TAB_PAGE_SIZE + j.data.length;
    const dexUsed = getPokemonDexNumber(q);
    count.textContent = dexUsed
      ? `${_tabTotal.toLocaleString()} cards found (Pokédex #${dexUsed})`
      : `${_tabTotal.toLocaleString()} cards found`;
    jpAlsoAvailable(q);   // offer Japanese versions of this Pokémon

    grid.innerHTML = j.data.map(card=>{
      const price = tcgPrimaryPrice(card);
      const varChips = tcgVariantChips(card);
      const key   = 'ts_'+card.id.replace(/[^a-z0-9]/gi,'_');
      window._tsCards = window._tsCards||{};
      window._tsCards[key] = {id:card.id,name:card.name,set:card.set?.name||'',num:card.number||'',img:card.images?.large||card.images?.small||'',rarity:card.rarity||''};
      const inVault = collection.some(c=>c.cardId===card.id||(c.name===card.name&&c.num===card.number&&c.set===card.set?.name));
      return `<div class="cs-card" onclick="tabPickCard(window._tsCards['${key}'])">
        <div class="cs-img-wrap">
          ${card.images?.small?`<img src="${card.images.small}" alt="${card.name}" loading="lazy">`:'<div class="cs-img-ph">⟡</div>'}
        </div>
        <div class="cs-body">
          <div class="cs-set-pill">${card.set?.name||'?'} · #${card.number||'?'}</div>
          <div class="cs-name">${esc(card.name)}</div>
          <div class="cs-set">${esc(card.rarity||'')}</div>
          ${price?`<div class="cs-price">$${price.toFixed(2)}</div>`:'<div class="cs-price" style="color:var(--muted);">—</div>'}
          ${varChips}
        </div>
        <button class="cs-add" title="${inVault?'In vault':'Add to vault'}" style="${inVault?'background:var(--green);opacity:1;':''}" onclick="event.stopPropagation();tabPickCard(window._tsCards['${key}'])">${inVault?'✓':'+'}</button>
      </div>`;
    }).join('');

    // Always show pagination bar (for per-page controls), update content
    const totalPages = Math.ceil(_tabTotal / TAB_PAGE_SIZE);
    // Always show pagination bar so per-page controls are accessible
    pager.style.display = 'flex';
    pager.style.flexDirection = 'column';
    document.getElementById('tab-search-pager-info').textContent =
      totalPages > 1 ? `Page ${page} of ${totalPages} — ${showing} of ${_tabTotal.toLocaleString()} cards` : `${_tabTotal.toLocaleString()} cards`;
    const btns = document.getElementById('tab-search-pager-btns');
    btns.innerHTML = totalPages > 1
      ? `${page>1?`<button class="btn btn-ghost btn-sm" onclick="doTabSearch('${q}',${page-1})">← Prev</button>`:''}
         ${page<totalPages?`<button class="btn btn-primary btn-sm" onclick="doTabSearch('${q}',${page+1})">Next ${Math.min(TAB_PAGE_SIZE,_tabTotal-showing)} →</button>`:''}`
      : '';
    if(page > 1) grid.scrollIntoView({behavior:'smooth',block:'start'});
  }catch(e){
    loader.style.display = 'none';
    if (count) count.textContent = '';                    // don't leave a stale count
    const _hint = document.getElementById('tab-search-jp-hint'); if (_hint) _hint.style.display='none';
    grid.innerHTML = `<div style="grid-column:1/-1;padding:20px;font-size:12px;color:var(--red);">Search failed — ${e.message}. <a href="#" onclick="doTabSearch('${String(q).replace(/'/g,"")}',1);return false;" style="color:var(--gold);">Retry</a></div>`;
  }
}

function tabPickCard(card){
  quickAdd(card);
}


// Pokémon name → Pokédex number map for precise card search
const POKEMON_DEX = {
  bulbasaur:1,ivysaur:2,venusaur:3,charmander:4,charmeleon:5,charizard:6,squirtle:7,wartortle:8,blastoise:9,
  caterpie:10,metapod:11,butterfree:12,weedle:13,kakuna:14,beedrill:15,pidgey:16,pidgeotto:17,pidgeot:18,
  rattata:19,raticate:20,spearow:21,fearow:22,ekans:23,arbok:24,pikachu:25,raichu:26,sandshrew:27,sandslash:28,
  nidoran:29,nidorina:30,nidoqueen:31,nidoranm:32,nidorino:33,nidoking:34,clefairy:35,clefable:36,vulpix:37,
  ninetales:38,jigglypuff:39,wigglytuff:40,zubat:41,golbat:42,oddish:43,gloom:44,vileplume:45,paras:46,
  parasect:47,venonat:48,venomoth:49,diglett:50,dugtrio:51,meowth:52,persian:53,psyduck:54,golduck:55,
  mankey:56,primeape:57,growlithe:58,arcanine:59,poliwag:60,poliwhirl:61,poliwrath:62,abra:63,kadabra:64,
  alakazam:65,machop:66,machoke:67,machamp:68,bellsprout:69,weepinbell:70,victreebel:71,tentacool:72,
  tentacruel:73,geodude:74,graveler:75,golem:76,ponyta:77,rapidash:78,slowpoke:79,slowbro:80,magnemite:81,
  magneton:82,farfetchd:83,doduo:84,dodrio:85,seel:86,dewgong:87,grimer:88,muk:89,shellder:90,cloyster:91,
  gastly:92,haunter:93,gengar:94,onix:95,drowzee:96,hypno:97,krabby:98,kingler:99,voltorb:100,electrode:101,
  exeggcute:102,exeggutor:103,cubone:104,marowak:105,hitmonlee:106,hitmonchan:107,lickitung:108,koffing:109,
  weezing:110,rhyhorn:111,rhydon:112,chansey:113,tangela:114,kangaskhan:115,horsea:116,seadra:117,goldeen:118,
  seaking:119,staryu:120,starmie:121,mrmime:122,scyther:123,jynx:124,electabuzz:125,magmar:126,pinsir:127,
  tauros:128,magikarp:129,gyarados:130,lapras:131,ditto:132,eevee:133,vaporeon:134,jolteon:135,flareon:136,
  porygon:137,omanyte:138,omastar:139,kabuto:140,kabutops:141,aerodactyl:142,snorlax:143,articuno:144,
  zapdos:145,moltres:146,dratini:147,dragonair:148,dragonite:149,mewtwo:150,mew:151,
  chikorita:152,bayleef:153,meganium:154,cyndaquil:155,quilava:156,typhlosion:157,totodile:158,croconaw:159,
  feraligatr:160,sentret:161,furret:162,hoothoot:163,noctowl:164,ledyba:165,ledian:166,spinarak:167,
  ariados:168,crobat:169,chinchou:170,lanturn:171,pichu:172,cleffa:173,igglybuff:174,togepi:175,togetic:176,
  natu:177,xatu:178,mareep:179,flaaffy:180,ampharos:181,bellossom:182,marill:183,azumarill:184,sudowoodo:185,
  politoed:186,hoppip:187,skiploom:188,jumpluff:189,aipom:190,sunkern:191,sunflora:192,yanma:193,wooper:194,
  quagsire:195,espeon:196,umbreon:197,murkrow:198,slowking:199,misdreavus:200,unown:201,wobbuffet:202,
  girafarig:203,pineco:204,forretress:205,dunsparce:206,gligar:207,steelix:208,snubbull:209,granbull:210,
  qwilfish:211,scizor:212,shuckle:213,heracross:214,sneasel:215,teddiursa:216,ursaring:217,slugma:218,
  magcargo:219,swinub:220,piloswine:221,corsola:222,remoraid:223,octillery:224,delibird:225,mantine:226,
  skarmory:227,houndour:228,houndoom:229,kingdra:230,phanpy:231,donphan:232,porygon2:233,stantler:234,
  smeargle:235,tyrogue:236,hitmontop:237,smoochum:238,elekid:239,magby:240,miltank:241,blissey:242,
  raikou:243,entei:244,suicune:245,larvitar:246,pupitar:247,tyranitar:248,lugia:249,hooh:250,celebi:251,
  treecko:252,grovyle:253,sceptile:254,torchic:255,combusken:256,blaziken:257,mudkip:258,marshtomp:259,
  swampert:260,poochyena:261,mightyena:262,zigzagoon:263,linoone:264,wurmple:265,silcoon:266,beautifly:267,
  cascoon:268,dustox:269,lotad:270,lombre:271,ludicolo:272,seedot:273,nuzleaf:274,shiftry:275,taillow:276,
  swellow:277,wingull:278,pelipper:279,ralts:280,kirlia:281,gardevoir:282,surskit:283,masquerain:284,
  shroomish:285,breloom:286,slakoth:287,vigoroth:288,slaking:289,nincada:290,ninjask:291,shedinja:292,
  whismur:293,loudred:294,exploud:295,makuhita:296,hariyama:297,azurill:298,nosepass:299,skitty:300,
  delcatty:301,sableye:302,mawile:303,aron:304,lairon:305,aggron:306,meditite:307,medicham:308,
  electrike:309,manectric:310,plusle:311,minun:312,volbeat:313,illumise:314,roselia:315,gulpin:316,
  swalot:317,carvanha:318,sharpedo:319,wailmer:320,wailord:321,numel:322,camerupt:323,torkoal:324,
  spoink:325,grumpig:326,spinda:327,trapinch:328,vibrava:329,flygon:330,cacnea:331,cacturne:332,
  swablu:333,altaria:334,zangoose:335,seviper:336,lunatone:337,solrock:338,barboach:339,whiscash:340,
  corphish:341,crawdaunt:342,baltoy:343,claydol:344,lileep:345,cradily:346,anorith:347,armaldo:348,
  feebas:349,milotic:350,castform:351,kecleon:352,shuppet:353,banette:354,duskull:355,dusclops:356,
  tropius:357,chimecho:358,absol:359,wynaut:360,snorunt:361,glalie:362,spheal:363,sealeo:364,walrein:365,
  clamperl:366,huntail:367,gorebyss:368,relicanth:369,luvdisc:370,bagon:371,shelgon:372,salamence:373,
  beldum:374,metang:375,metagross:376,regirock:377,regice:378,registeel:379,latias:380,latios:381,
  kyogre:382,groudon:383,rayquaza:384,jirachi:385,deoxys:386,
  turtwig:387,grotle:388,torterra:389,chimchar:390,monferno:391,infernape:392,piplup:393,prinplup:394,
  empoleon:395,starly:396,staravia:397,staraptor:398,bidoof:399,bibarel:400,kricketot:401,kricketune:402,
  shinx:403,luxio:404,luxray:405,budew:406,roserade:407,cranidos:408,rampardos:409,shieldon:410,
  bastiodon:411,burmy:412,wormadam:413,mothim:414,combee:415,vespiquen:416,pachirisu:417,buizel:418,
  floatzel:419,cherubi:420,cherrim:421,shellos:422,gastrodon:423,ambipom:424,drifloon:425,drifblim:426,
  buneary:427,lopunny:428,mismagius:429,honchkrow:430,glameow:431,purugly:432,chingling:433,stunky:434,
  skuntank:435,bronzor:436,bronzong:437,bonsly:438,mimejr:439,happiny:440,chatot:441,spiritomb:442,
  gible:443,gabite:444,garchomp:445,munchlax:446,riolu:447,lucario:448,hippopotas:449,hippowdon:450,
  skorupi:451,drapion:452,croagunk:453,toxicroak:454,carnivine:455,finneon:456,lumineon:457,mantyke:458,
  snover:459,abomasnow:460,weavile:461,magnezone:462,lickilicky:463,rhyperior:464,tangrowth:465,
  electivire:466,magmortar:467,togekiss:468,yanmega:469,leafeon:470,glaceon:471,gliscor:472,mamoswine:473,
  porygonz:474,gallade:475,probopass:476,dusknoir:477,froslass:478,rotom:479,uxie:480,mesprit:481,
  azelf:482,dialga:483,palkia:484,heatran:485,regigigas:486,giratina:487,cresselia:488,phione:489,
  manaphy:490,darkrai:491,shaymin:492,arceus:493,
  victini:494,snivy:495,servine:496,serperior:497,tepig:498,pignite:499,emboar:500,oshawott:501,
  dewott:502,samurott:503,patrat:504,watchog:505,lillipup:506,herdier:507,stoutland:508,purrloin:509,
  liepard:510,pansage:511,simisage:512,pansear:513,simisear:514,panpour:515,simipour:516,munna:517,
  musharna:518,pidove:519,tranquill:520,unfezant:521,blitzle:522,zebstrika:523,roggenrola:524,boldore:525,
  gigalith:526,woobat:527,swoobat:528,drilbur:529,excadrill:530,audino:531,timburr:532,gurdurr:533,
  conkeldurr:534,tympole:535,palpitoad:536,seismitoad:537,throh:538,sawk:539,sewaddle:540,swadloon:541,
  leavanny:542,venipede:543,whirlipede:544,scolipede:545,cottonee:546,whimsicott:547,petilil:548,
  lilligant:549,basculin:550,sandile:551,krokorok:552,krookodile:553,darumaka:554,darmanitan:555,
  maractus:556,dwebble:557,crustle:558,scraggy:559,scrafty:560,sigilyph:561,yamask:562,cofagrigus:563,
  tirtouga:564,carracosta:565,archen:566,archeops:567,trubbish:568,garbodor:569,zorua:570,zoroark:571,
  minccino:572,cinccino:573,gothita:574,gothorita:575,gothitelle:576,solosis:577,duosion:578,reuniclus:579,
  ducklett:580,swanna:581,vanillite:582,vanillish:583,vanilluxe:584,deerling:585,sawsbuck:586,emolga:587,
  karrablast:588,escavalier:589,foongus:590,amoonguss:591,frillish:592,jellicent:593,alomomola:594,
  joltik:595,galvantula:596,ferroseed:597,ferrothorn:598,klink:599,klang:600,klinklang:601,tynamo:602,
  eelektrik:603,eelektross:604,elgyem:605,beheeyem:606,litwick:607,lampent:608,chandelure:609,axew:610,
  fraxure:611,haxorus:612,cubchoo:613,beartic:614,cryogonal:615,shelmet:616,accelgor:617,stunfisk:618,
  mienfoo:619,mienshao:620,druddigon:621,golett:622,golurk:623,pawniard:624,bisharp:625,bouffalant:626,
  rufflet:627,braviary:628,vullaby:629,mandibuzz:630,heatmor:631,durant:632,deino:633,zweilous:634,
  hydreigon:635,larvesta:636,volcarona:637,cobalion:638,terrakion:639,virizion:640,tornadus:641,
  thundurus:642,reshiram:643,zekrom:644,landorus:645,kyurem:646,keldeo:647,meloetta:648,genesect:649,
  chespin:650,quilladin:651,chesnaught:652,fennekin:653,braixen:654,delphox:655,froakie:656,frogadier:657,
  greninja:658,bunnelby:659,diggersby:660,fletchling:661,fletchinder:662,talonflame:663,scatterbug:664,
  spewpa:665,vivillon:666,litleo:667,pyroar:668,flabebe:669,floette:670,florges:671,skiddo:672,gogoat:673,
  pancham:674,pangoro:675,furfrou:676,espurr:677,meowstic:678,honedge:679,doublade:680,aegislash:681,
  spritzee:682,aromatisse:683,swirlix:684,slurpuff:685,inkay:686,malamar:687,binacle:688,barbaracle:689,
  skrelp:690,dragalge:691,clauncher:692,clawitzer:693,helioptile:694,heliolisk:695,tyrunt:696,tyrantrum:697,
  amaura:698,aurorus:699,sylveon:700,hawlucha:701,dedenne:702,carbink:703,goomy:704,sliggoo:705,goodra:706,
  klefki:707,phantump:708,trevenant:709,pumpkaboo:710,gourgeist:711,bergmite:712,avalugg:713,noibat:714,
  noivern:715,xerneas:716,yveltal:717,zygarde:718,diancie:719,hoopa:720,volcanion:721,
  rowlet:722,dartrix:723,decidueye:724,litten:725,torracat:726,incineroar:727,popplio:728,brionne:729,
  primarina:730,pikipek:731,trumbeak:732,toucannon:733,yungoos:734,gumshoos:735,grubbin:736,charjabug:737,
  vikavolt:738,crabrawler:739,crabominable:740,oricorio:741,cutiefly:742,ribombee:743,rockruff:744,
  lycanroc:745,wishiwashi:746,mareanie:747,toxapex:748,mudbray:749,mudsdale:750,dewpider:751,araquanid:752,
  fomantis:753,lurantis:754,morelull:755,shiinotic:756,salandit:757,salazzle:758,stufful:759,bewear:760,
  bounsweet:761,steenee:762,tsareena:763,comfey:764,oranguru:765,passimian:766,wimpod:767,golisopod:768,
  sandygast:769,palossand:770,pyukumuku:771,typenull:772,silvally:773,minior:774,komala:775,turtonator:776,
  togedemaru:777,mimikyu:778,bruxish:779,drampa:780,dhelmise:781,jangmoo:782,hakamoo:783,kommoomo:784,
  tapukoko:785,tapulele:786,tapubulu:787,tapufini:788,cosmog:789,cosmoem:790,solgaleo:791,lunala:792,
  nihilego:793,buzzwole:794,pheromosa:795,xurkitree:796,celesteela:797,kartana:798,guzzlord:799,
  necrozma:800,magearna:801,marshadow:802,poipole:803,naganadel:804,stakataka:805,blacephalon:806,zeraora:807,
  meltan:808,melmetal:809,
  grookey:810,thwackey:811,rillaboom:812,scorbunny:813,raboot:814,cinderace:815,sobble:816,drizzile:817,
  inteleon:818,skwovet:819,greedent:820,rookidee:821,corvisquire:822,corviknight:823,blipbug:824,
  dottler:825,orbeetle:826,nickit:827,thievul:828,gossifleur:829,eldegoss:830,wooloo:831,dubwool:832,
  chewtle:833,drednaw:834,yamper:835,boltund:836,rolycoly:837,carkol:838,coalossal:839,applin:840,
  flapple:841,appletun:842,silicobra:843,sandaconda:844,cramorant:845,arrokuda:846,barraskewda:847,
  toxel:848,toxtricity:849,sizzlipede:850,centiskorch:851,clobbopus:852,grapploct:853,sinistea:854,
  polteageist:855,hatenna:856,hattrem:857,hatterene:858,impidimp:859,morgrem:860,grimmsnarl:861,
  obstagoon:862,perrserker:863,cursola:864,sirfetchd:865,mrmime2:866,runerigus:867,milcery:868,
  alcremie:869,falinks:870,pincurchin:871,snom:872,frosmoth:873,stonjourner:874,eiscue:875,indeedee:876,
  morpeko:877,cufant:878,copperajah:879,dracozolt:880,arctozolt:881,dracovish:882,arctovish:883,
  duraludon:884,dreepy:885,drakloak:886,dragapult:887,zacian:888,zamazenta:889,eternatus:890,
  kubfu:891,urshifu:892,zarude:893,regieleki:894,regidrago:895,glastrier:896,spectrier:897,calyrex:898,
  wyrdeer:899,kleavor:900,ursaluna:901,basculegion:902,sneasler:903,overqwil:904,enamorus:905,
  sprigatito:906,floragato:907,meowscarada:908,fuecoco:909,crocalor:910,skeledirge:911,quaxly:912,
  quaxwell:913,quaquaval:914,lechonk:915,oinkologne:916,tarountula:917,spidops:918,nymble:919,lokix:920,
  pawmi:921,pawmo:922,pawmot:923,tandemaus:924,maushold:925,fidough:926,dachsbun:927,smoliv:928,
  dolliv:929,arboliva:930,squawkabilly:931,nacli:932,naclstack:933,garganacl:934,charcadet:935,
  armarouge:936,ceruledge:937,tadbulb:938,bellibolt:939,wattrel:940,kilowattrel:941,maschiff:942,
  mabosstiff:943,shroodle:944,grafaiai:945,bramblin:946,brambleghast:947,toedscool:948,toedscruel:949,
  klawf:950,capsakid:951,scovillain:952,rellor:953,rabsca:954,flittle:955,espathra:956,tinkatink:957,
  tinkatuff:958,tinkaton:959,wiglett:960,wugtrio:961,bombirdier:962,finizen:963,palafin:964,varoom:965,
  revavroom:966,cyclizar:967,orthworm:968,glimmet:969,glimmora:970,greavard:971,houndstone:972,
  flamigo:973,cetoddle:974,cetitan:975,veluza:976,dondozo:977,tatsugiri:978,annihilape:979,
  clodsire:980,farigiraf:981,dudunsparce:982,kingambit:983,greattusk:984,scythermantis:985,
  brutebonnet:986,fluttermane:987,slitherwing:988,sandyshocks:989,irontheads:990,ironbundle:991,
  ironhands:992,ironjugulis:993,ironmoth:994,ironthorns:995,frigibax:996,arctibax:997,baxcalibur:998,
  gimmighoul:999,gholdengo:1000,wochien:1001,chienpao:1002,tinglu:1003,chiyu:1004,
  roaringmoon:1005,ironvaliant:1006,tinkatuff2:1007,koraidon:1007,miraidon:1008,
  walkingwake:1009,ironleaves:1010,
};

// Build a SAFE pokemontcg.io name query. Unquoted multi-word values (name:Dark blastoise)
// cause Lucene 400 errors; wildcards avoid that AND dodge apostrophes/punctuation.
// Dex+name query. A bare nationalPokedexNumbers: query MISSES vintage cards —
// many WOTC-era prints (Jungle 1999, Gym, Neo) have no dex field in pokemontcg.io,
// so dex-only silently drops the whole back catalogue. ORing in a name match returns
// both the dex-indexed cards AND every card actually named after the Pokémon.
// pokemontcg.io returns ONE record per card with a price tier per PRINTING
// (normal / holofoil / reverseHolofoil / 1stEdition…). The grid used
// Object.values(prices)[0] — an ARBITRARY tier depending on JSON key order — and gave
// no sign the other printings existed (Mewtwo #11 has a holo AND a reverse holo, per
// PriceCharting). These surface every printing with its own price, deterministically.
const TCG_TIER_LABEL = {
  normal:'Normal', holofoil:'Holo', reverseHolofoil:'Reverse',
  '1stEditionNormal':'1st Ed', '1stEditionHolofoil':'1st Ed Holo',
  unlimitedHolofoil:'Unlimited Holo', unlimited:'Unlimited'
};
const TCG_TIER_ORDER = ['holofoil','normal','1stEditionHolofoil','1stEditionNormal','unlimitedHolofoil','reverseHolofoil','unlimited'];
function tcgTiers(card){
  const p = card && card.tcgplayer && card.tcgplayer.prices;
  if (!p) return [];
  const out = [];
  for (const k of TCG_TIER_ORDER) if (p[k] && (p[k].market || p[k].mid)) out.push({key:k,label:TCG_TIER_LABEL[k]||k,price:p[k].market||p[k].mid});
  for (const k of Object.keys(p)) if (TCG_TIER_ORDER.indexOf(k)===-1 && p[k] && (p[k].market||p[k].mid)) out.push({key:k,label:TCG_TIER_LABEL[k]||k,price:p[k].market||p[k].mid});
  return out;
}
function tcgPrimaryPrice(card){ const t = tcgTiers(card); return t.length ? t[0].price : null; }
function tcgVariantChips(card){
  const t = tcgTiers(card);
  if (t.length < 2) return '';
  return '<div class="cs-vars">' + t.map(v => '<span class="cs-var"><span class="cs-var-l">'+v.label+'</span>$'+v.price.toFixed(2)+'</span>').join('') + '</div>';
}

// Shared "N cards exist across all sets" line for EVERY card-search surface in the
// app (card search tab, watchlist, deal centre, add-card modal, name dropdown).
// Uses the API's totalCount — the true number across all sets — not the page size,
// so a capped result list can never masquerade as the complete picture.
function searchCountLine(j, query, opts){
  opts = opts || {};
  const shown = (j && Array.isArray(j.data)) ? j.data.length : 0;
  const total = (j && typeof j.totalCount === 'number') ? j.totalCount : shown;
  if (!total) return '';
  let dex = null;
  try { dex = (typeof getPokemonDexNumber === 'function') ? getPokemonDexNumber(query) : null; } catch(_){}
  const pad = opts.compact ? '7px 12px' : '10px 14px';
  const fs  = opts.compact ? '10px' : '11px';
  return '<div style="padding:'+pad+';border-bottom:1px solid var(--border);font-family:var(--mono);font-size:'+fs+';color:var(--muted);background:var(--bg3);">'
    + '<b style="color:var(--text);">' + total.toLocaleString() + '</b> card' + (total===1?'':'s')
    + ' exist across all sets'
    + (dex ? ' <span style="color:var(--muted2);">(Pok\u00e9dex #' + dex + ')</span>' : '')
    + (shown < total ? ' <span style="color:var(--muted2);">\u00b7 showing ' + shown + '</span>' : '')
    + '</div>';
}

function buildDexNameQuery(input, dexNum){
  const n = String(input||'').replace(/[^A-Za-z0-9 ]/g,' ').replace(/\s+/g,' ').trim();
  if (!dexNum) return n ? `name:*${n.replace(/ /g,'*')}*` : '';
  if (!n)      return `nationalPokedexNumbers:${dexNum}`;
  return `(nationalPokedexNumbers:${dexNum} OR name:*${n.replace(/ /g,'*')}*)`;
}

function buildNameQuery(raw){
  const ln = String(raw||'').replace(/[^A-Za-z0-9 ]/g,' ').replace(/\s+/g,' ').trim();
  if(!ln) return `name:*${String(raw||'').trim()}*`;
  return `name:*${ln.replace(/ /g,'*')}*`;
}
function getPokemonDexNumber(query) {
  const q = query.toLowerCase().trim()
    .replace(/['']/g, '')
    .replace(/\s+/g, '')
    .replace(/[^a-z0-9]/g,'');
  // Exact match first
  if (POKEMON_DEX[q]) return POKEMON_DEX[q];
  // Prefix match — "rayqu" matches "rayquaza"
  if (q.length >= 4) {
    const match = Object.keys(POKEMON_DEX).find(k => k.startsWith(q));
    if (match) return POKEMON_DEX[match];
  }
  return null;
}


// ── Set Browser ──
let _browseEra   = 'all';
let _browseSetId = null;

const ERA_MAP = {
  scarlet: ['sv'],
  sword:   ['swsh'],
  sun:     ['sm'],
  xy:      ['xy'],
  bw:      ['bw'],
  hgss:    ['hgss'],
  dp:      ['dp','pl','la'],
  ex:      ['ex','em','pk','np','rg','ds','lg','hp','cg','df','tk'],
  wotc:    ['base','jungle','fossil','teamrocket','gym','neo','ecard','legend','si'],
  promo:   ['promo','mcd'],
};

function filterSetsByEra(era, el) {
  _browseEra = era;
  document.querySelectorAll('.era-pill').forEach(b => b.classList.remove('active'));
  if (el) el.classList.add('active');
  closeBrowseSet();
  renderSetBrowser();
}

function renderSetBrowser() {
  const grid = document.getElementById('set-browser-grid');
  const cnt  = document.getElementById('set-browser-count');
  if (!allSets.length) {
    grid.innerHTML = '<div style="grid-column:1/-1;padding:20px;font-size:12px;color:var(--muted);">Loading sets… add a pokemontcg.io key in Settings for faster results.</div>';
    return;
  }

  let sets = allSets;
  if (_browseEra !== 'all') {
    const prefixes = ERA_MAP[_browseEra] || [];
    sets = allSets.filter(s => {
      const id = (s.id || '').toLowerCase();
      return prefixes.some(p => id.startsWith(p));
    });
  }

  cnt.textContent = sets.length + ' sets';
  document.getElementById('set-browser-set-name').style.display = 'none';

  grid.innerHTML = sets.map(s => {
    const year = (s.releaseDate || '').slice(0, 4);
    const total = s.total || s.printedTotal || '?';
    // Store set data in a map so onclick just needs the ID (avoids apostrophe issues)
    window._allSetMap = window._allSetMap || {};
    window._allSetMap[s.id] = { name: s.name, logo: s.images?.logo || s.images?.symbol || '' };
    return `<div class="set-tile" onclick="browseSetById('${s.id}')">
      <div class="set-tile-logo">
        ${s.images?.logo
          ? `<img src="${esc(s.images.logo)}" alt="${esc(s.name)}" loading="lazy">`
          : `<div class="set-tile-logo-ph">🃏</div>`}
      </div>
      <div class="set-tile-body">
        <div class="set-tile-name">${esc(s.name)}</div>
        <div class="set-tile-meta"><span>${year}</span><span>${total} cards</span></div>
      </div>
    </div>`;
  }).join('');
}

function browseSetById(setId) {
  const s = (window._allSetMap || {})[setId] || {};
  browseSet(setId, s.name || setId, s.logo || '');
}

async function browseSet(setId, setName, logoUrl) {
  _browseSetId = setId;
  const grid    = document.getElementById('set-browser-grid');
  const cGrid   = document.getElementById('cs-set-cards-grid');
  const loading = document.getElementById('cs-set-cards-loading');
  const lbl     = document.getElementById('set-browser-set-label');
  const nameEl  = document.getElementById('set-browser-set-name');

  // Update breadcrumb and show back button
  lbl.textContent = setName;
  nameEl.style.display = 'inline-flex';
  const backBtn = document.getElementById('set-back-btn');
  if (backBtn) backBtn.style.display = 'inline-flex';

  // Hide set grid, show loading
  grid.style.display    = 'none';
  cGrid.style.display   = 'none';
  loading.style.display = '';
  document.getElementById('set-era-filters').style.display = 'none';

  try {
    let cards;
    // Session cache — reopening a set you've already viewed is instant (no API call).
    // In-memory only (cleared on reload), so it can never fill localStorage or touch
    // your saved data; cross-reload persistence is the IndexedDB upgrade (#5).
    window._setCardCache = window._setCardCache || {};
    if (window._setCardCache[setId]) {
      cards = window._setCardCache[setId];
      loading.style.display = 'none';
    } else {
      // pokemontcg.io caps pageSize at 250 — asking for 500 returns a 500 error.
      // Try 250, then fall back to 100 in case the server is straining on a big set.
      let r = null, j = null;
      for (const ps of [250, 100]) {
        try {
          const rr = await ptcgFetch(`/cards?q=set.id:${encodeURIComponent(setId)}&orderBy=number&pageSize=${ps}`);
          if (!rr.ok) { r = rr; continue; }
          j = await rr.json(); r = rr; break;
        } catch(_) {}
      }
      if (!j) throw new Error('API error ' + (r ? r.status : 'network'));
      loading.style.display = 'none';

      cards = j.data || [];

      // Fallback: if set.id query returns nothing, try set.name search
      if (!cards.length) {
        const r2 = await ptcgFetch(`/cards?q=set.name:"${encodeURIComponent(setName)}"&orderBy=number&pageSize=250`);
        if (r2.ok) {
          const j2 = await r2.json();
          cards = j2.data || [];
        }
      }

      if (cards.length) window._setCardCache[setId] = cards;
    }

    const cnt = document.getElementById('set-browser-count');
    cnt.textContent = cards.length + ' cards';

    // Build rarity filter pills from actual rarities in this set
    const rarities = [...new Set(cards.map(c => c.rarity).filter(Boolean))];
    const rarityBar = rarities.length > 1
      ? `<div class="set-cards-rarity-filter">
          <button class="era-pill active" onclick="filterSetCards('',this)">All</button>
          ${rarities.map(r => `<button class="era-pill" onclick="filterSetCards('${r.replace(/'/g,"\'")}',this)">${r}</button>`).join('')}
        </div>`
      : '';

    // Store cards for filtering
    window._browseSetCards = cards;

    cGrid.innerHTML = `
      <div class="set-cards-header">
        ${logoUrl ? `<img src="${logoUrl}" alt="${setName}">` : ''}
        <div>
          <div style="font-size:15px;font-weight:700;">${setName}</div>
          <div style="font-family:var(--mono);font-size:10px;color:var(--muted);">${cards.length} cards</div>
        </div>
      </div>
      ${rarityBar}
      <div class="cs-grid" id="set-cards-inner" style="max-height:none;padding:0;"></div>`;

    cGrid.style.display = '';
    renderSetCardsGrid(cards);

  } catch(e) {
    loading.style.display = 'none';
    cGrid.style.display   = '';
    cGrid.innerHTML = `<div style="padding:20px;font-size:12px;color:var(--red);">Failed to load set — ${e.message} <a href="#" onclick="delete window._setCardCache['${setId}'];browseSet('${setId}','${String(setName).replace(/'/g,"")}');return false;" style="color:var(--gold);">Retry</a></div>`;
  }
}

function filterSetCards(rarity, el) {
  document.querySelectorAll('.set-cards-rarity-filter .era-pill').forEach(b => b.classList.remove('active'));
  if (el) el.classList.add('active');
  const cards = rarity
    ? (window._browseSetCards || []).filter(c => c.rarity === rarity)
    : (window._browseSetCards || []);
  renderSetCardsGrid(cards);
}

function renderSetCardsGrid(cards) {
  const inner = document.getElementById('set-cards-inner');
  if (!inner) return;
  inner.innerHTML = cards.map(card => {
    const tier  = card.tcgplayer?.prices ? Object.values(card.tcgplayer.prices)[0] : null;
    const price = tier?.market || null;
    const key   = 'bs_' + card.id.replace(/[^a-z0-9]/gi, '_');
    window._tsCards = window._tsCards || {};
    window._tsCards[key] = {
      id:     card.id,
      name:   card.name,
      set:    card.set?.name || '',
      num:    card.number  || '',
      img:    card.images?.large || card.images?.small || '',
      rarity: card.rarity || ''
    };
    const inVault = collection.some(c =>
      c.cardId === card.id || (c.name === card.name && c.num === card.number && c.set === card.set?.name)
    );
    return `<div class="cs-card" onclick="tabPickCard(window._tsCards['${key}'])">
      <div class="cs-img-wrap">
        ${card.images?.small
          ? `<img src="${card.images.small}" alt="${card.name}" loading="lazy">`
          : '<div class="cs-img-ph">⟡</div>'}
      </div>
      <div class="cs-body">
        <div class="cs-set-pill">#${card.number || '?'}</div>
        <div class="cs-name">${esc(card.name)}</div>
        <div class="cs-set">${esc(card.rarity || '')}</div>
        ${price
          ? `<div class="cs-price">$${price.toFixed(2)}</div>`
          : '<div class="cs-price" style="color:var(--muted);">—</div>'}
      </div>
      <button class="cs-add"
        title="${inVault ? 'In vault' : 'Add to vault'}"
        style="${inVault ? 'background:var(--green);opacity:1;' : ''}"
        onclick="event.stopPropagation();tabPickCard(window._tsCards['${key}'])">
        ${inVault ? '✓' : '+'}
      </button>
    </div>`;
  }).join('');
}

// ════════════════════════════════════════════════════════════════════════════
// REHOMED IN FINAL MIGRATION - the two search-owned bridges.
// Both write SEARCH state (_browseSetId / _searchLang) and call clearTabSearch /
// renderSetBrowser; they only DELEGATE to jp-catalogue in JP mode.
// ════════════════════════════════════════════════════════════════════════════
function setSearchLang(lang, btn, opts){
  opts = opts || {};
  window._searchLang = lang;
  document.querySelectorAll('#lang-toggle .era-pill').forEach(b=>b.classList.toggle('active', b===btn));
  // reset any active search — SKIPPED when we're switching in order to run a search
  // immediately (jpJumpToSearch), because clearTabSearch()'s empty state and the
  // set-browser fetch below would otherwise race and overwrite the results.
  const inp = document.getElementById('tab-search-input');
  if (!opts.keepQuery) {
    if (inp) { inp.value=''; }
    try { clearTabSearch(); } catch(_){}
  }
  const filters = document.getElementById('tab-search-filters');
  const eras    = document.getElementById('set-era-filters');
  if (lang === 'JP') {
    if (filters) filters.style.display = 'none';          // EN set/rarity selects
    if (eras)    eras.style.display    = 'none';          // EN era pills
    if (inp) inp.placeholder = 'Search any Japanese card…';
    if (!opts.keepQuery) jpShowSets();
  } else {
    if (filters) filters.style.display = 'flex';
    if (eras)    eras.style.display    = 'flex';
    if (inp) inp.placeholder = 'Search any Pokémon card across all sets…';
    // Reset the breadcrumb/count that jpShowSets rewrote, so English mode never
    // shows "ALL SETS · JP" or a stale Japanese set count.
    const _crumb = document.getElementById('set-browser-all-sets');
    if (_crumb) _crumb.textContent = 'ALL SETS';
    const _cnt = document.getElementById('set-browser-count');
    if (_cnt) _cnt.textContent = '';
    // restore English browser
    const cGrid = document.getElementById('cs-set-cards-grid');
    if (cGrid) { cGrid.style.display='none'; cGrid.innerHTML=''; }
    const grid = document.getElementById('set-browser-grid');
    if (grid) grid.style.display='';
    const backBtn = document.getElementById('set-back-btn');
    if (backBtn) backBtn.style.display='none';
    document.getElementById('set-browser-set-name').style.display='none';
    renderSetBrowser();
  }
}

function closeBrowseSet() {
  if (window._searchLang === 'JP') { jpShowSets(); return; }   // JP mode (2026-07)
  _browseSetId = null;
  window._browseSetCards = [];
  // Show sets grid + era filters
  document.getElementById('set-browser-grid').style.display    = 'grid';
  document.getElementById('cs-set-cards-grid').style.display      = 'none';
  document.getElementById('cs-set-cards-loading').style.display   = 'none';
  document.getElementById('set-era-filters').style.display     = '';
  // Hide breadcrumb set name + back button
  document.getElementById('set-browser-set-name').style.display = 'none';
  const backBtn = document.getElementById('set-back-btn');
  if (backBtn) backBtn.style.display = 'none';
  // Re-render the sets grid so it's populated
  renderSetBrowser();
}
