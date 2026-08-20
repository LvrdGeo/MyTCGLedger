/* ════════════════════════════════════════════════════════════════════════════
   MyTCG Ledger V6 - cards-crud.js
   ────────────────────────────────────────────────────────────────────────────
   DOMAIN MODULE (inventory card lifecycle). The first extracted module that
   OWNS mutation of `collection`, so the bar is: add -> edit -> delete -> sell ->
   tombstone -> persist -> rerender must be behaviourally identical.

   Two banner-delimited blocks: "═══ CARD CRUD ═══" and "═══ ADD FORM HELPERS ═══".

   OWNS:
     - add / edit        openAddModal, editCard, saveCard
     - form controls     selectVariant, selectType, selectCond, selectEdition,
                         refreshEditionSection, syncGrade, updateAddPreview,
                         verifyCert
     - removal flow      _removeCardId, delCard, closeRemove, removeAsSold,
                         _lastRemoved, removeNoSale, undoRemove
     - sale flow         openSellModal, confirmSell
     - sold history      openSoldHistory, renderSoldHistory, restoreSoldCard,
                         deleteSoldEntry

   DOES NOT OWN:
     - card detail (openDetail / repriceCard / loadActiveListings / Evidence
       Explorer stay inline). card-detail -> cards-crud is a healthy call-time
       edge, not ownership.
     - cost editing: cost-editor.js owns paid/cost UI. The add/edit form still
       initialises `paid`, but no cost-editor function was moved back.
     - the search picker (quickAdd / pickerSelect* / pickerConfirm /
       prefillAddForm / addToWatchlistFromPicker): it lives in the search region
       and pickerConfirm feeds the wishlist. search -> cards-crud stays an edge.
     - removeCardFromCollection: called only by applyDealToPortfolio and located
       in the deals region - deals-owned.
     - identity engine (retire / dupWarnThenAdd / identityEngine stay in
       identity.js), pricing, valuation, storage, sync, scanner, sealed,
       wishlist, portfolio internals, generic search.

   SCANNER IS DELIBERATELY UNCHANGED: addScannedCard still does its own
   collection.push + save() and does NOT route through saveCard(). That known
   inconsistency stays deferred - this batch did not unify card creation.

   STATE: mutates `collection` (push on add, field writes on edit, splice on
   remove), `soldHistory` (sale + restore + delete), and `wishlist` (saveCard
   clears a pending wish removal). All pre-existing; no new mutation.

   LOAD-TIME DEPENDENCIES: none. Two declarations (_removeCardId, _lastRemoved).

   CALL-TIME DEPENDENCIES:
     core       esc, money, moneyFull, toast, openModal, closeModal, newId, showConfirm
     valuation  cardValue, cacheKey, cardEdition, editionEligibility
     identity   retire, dupWarnThenAdd
     storage    save, saveSoldHistory
     analytics  saveHoldingToDatabase, saveTransactionToDatabase
     app/UI     renderAll, renderDashboard, renderPortfolio (call-time)
     inline     collection, soldHistory, wishlist, editingId, and the
                #add-modal / #remove-bg / #sell-modal / #sold-history-modal markup
   ════════════════════════════════════════════════════════════════════════════ */

// ═══ CARD CRUD ═══
function openAddModal(forceGraded){editingId=null;window._pendingWishRemoval=null;document.getElementById('modal-title').textContent='Add Card';['f-name','f-set','f-num','f-cardid','f-grade','f-cert','f-paid','f-source','f-notes','f-img'].forEach(id=>document.getElementById(id).value='');document.getElementById('f-qty').value=1;document.getElementById('cert-msg').innerHTML='';window._pendingRarity='';window._pendingLang=null;const t=forceGraded?'graded':'standard';selectType(t,document.querySelector(`.type-pill[data-val="${t}"]`));selectCond('NM',document.querySelector('.cond-pill[data-val="NM"]'));document.getElementById('f-edition').value='unlimited';selectEdition('unlimited',document.querySelector('#edition-section .ed-pill[data-val="unlimited"]'));selectVariant('',document.querySelector('#variant-pills .var-pill[data-val=""]'));refreshEditionSection();updateAddPreview();openModal('add-modal');}
function editCard(id){const card=collection.find(x=>x.id===id);if(!card)return;editingId=id;document.getElementById('modal-title').textContent='Edit Card';document.getElementById('f-name').value=card.name||'';document.getElementById('f-set').value=card.set||'';document.getElementById('f-num').value=card.num||'';document.getElementById('f-cardid').value=card.cardId||'';document.getElementById('f-cert').value=card.cert||'';document.getElementById('f-qty').value=card.qty||1;document.getElementById('f-paid').value=card.paid||'';document.getElementById('f-source').value=card.source||'';document.getElementById('f-notes').value=card.notes||'';document.getElementById('f-img').value=card.img||'';document.getElementById('cert-msg').innerHTML='';window._pendingRarity=card.rarity||'';const tP=document.querySelector(`.type-pill[data-val="${card.type||'standard'}"]`);if(tP)selectType(card.type||'standard',tP);const cP=document.querySelector(`.cond-pill[data-val="${card.cond||'NM'}"]`);if(cP)selectCond(card.cond||'NM',cP);if(card.type==='graded'&&card.grade){const parts=card.grade.match(/^(\w+)\s+(.+)$/);if(parts){document.getElementById('f-grader').value=parts[1];document.getElementById('f-grade-sel').value=parts[2];}document.getElementById('f-grade').value=card.grade;}const _ed=card.edition||'unlimited';document.getElementById('f-edition').value=_ed;refreshEditionSection();const _curEd=document.getElementById('f-edition').value;const _eP=document.querySelector(`#edition-section .ed-pill[data-val="${_curEd}"]`);if(_eP)selectEdition(_curEd,_eP);const _v=card.variant||'';const _vP=document.querySelector(`#variant-pills .var-pill[data-val="${_v}"]`);if(_vP)selectVariant(_v,_vP);updateAddPreview();openModal('add-modal');}
function selectVariant(v,btn){document.getElementById('f-variant').value=v;document.querySelectorAll('#variant-pills .var-pill').forEach(p=>p.classList.toggle('active',p===btn));updateAddPreview();}
function saveCard(){const name=document.getElementById('f-name').value.trim();if(!name){toast('Card name required','red');return;}const _t=document.getElementById('f-type').value;const data={id:editingId||newId('c'),name,set:document.getElementById('f-set').value.trim(),num:document.getElementById('f-num').value.trim(),cardId:document.getElementById('f-cardid').value.trim(),type:_t,cond:document.getElementById('f-cond').value,edition:document.getElementById('f-edition').value||'unlimited',variant:document.getElementById('f-variant').value||'',grade:document.getElementById('f-grade').value.trim(),cert:document.getElementById('f-cert').value.trim(),qty:parseInt(document.getElementById('f-qty').value)||1,paid:document.getElementById('f-paid').value,source:document.getElementById('f-source').value,notes:document.getElementById('f-notes').value.trim(),img:document.getElementById('f-img').value.trim(),rarity:window._pendingRarity||(editingId?(collection.find(c=>c.id===editingId)||{}).rarity:'')||'',added:editingId?(collection.find(c=>c.id===editingId)||{}).added:new Date().toISOString()};if(window._pendingLang){data.lang=window._pendingLang;window._pendingLang=null;if(window._pendingSetEn){data.setEn=window._pendingSetEn;window._pendingSetEn=null;}}else if(editingId){const _pc=collection.find(c=>c.id===editingId);if(_pc&&_pc.lang)data.lang=_pc.lang;}if((data.grade&&data.grade.trim())||(data.cert&&data.cert.trim())){data.type='graded';}delete pcache[cacheKey(data)];idbDelete(cacheKey(data));if(editingId){collection=collection.map(c=>c.id===editingId?data:c);if(window._pendingWishRemoval){wishlist=wishlist.filter(x=>x.id!==window._pendingWishRemoval);}window._pendingWishRemoval=null;save();saveHoldingToDatabase(data);saveTransactionToDatabase({client_id:data.id,txn_type:'edit',card_name:data.name,quantity:parseInt(data.qty,10)||1,unit_price:null,cost_basis:data.paid,source:data.source||null,occurred_at:data.added});closeModal('add-modal');renderAll();toast('Card updated','green');}else{collection.push(data);if(window._pendingWishRemoval){wishlist=wishlist.filter(x=>x.id!==window._pendingWishRemoval);}window._pendingWishRemoval=null;save();saveHoldingToDatabase(data);saveTransactionToDatabase({client_id:data.id,txn_type:'add',card_name:data.name,quantity:parseInt(data.qty,10)||1,unit_price:data.paid,cost_basis:data.paid,source:data.source||null,occurred_at:data.added});closeModal('add-modal');renderAll();toast('Card added','green');}}
function openSoldHistory(){
  renderSoldHistory();
  openModal('sold-history-modal');
}

function renderSoldHistory(){
  const summary = document.getElementById('sold-history-summary');
  const body = document.getElementById('sold-history-body');
  if(!body) return;

  if(!soldHistory.length){
    if(summary) summary.innerHTML = '';
    body.innerHTML = '<div style="padding:30px 20px;text-align:center;color:var(--muted);font-size:13px;">No sold or removed cards yet.<br><span style="font-size:11px;">When you remove a card from your collection, it\'ll appear here.</span></div>';
    return;
  }

  // Summary totals
  const totalProceeds = soldHistory.reduce((s,e)=>s+(e.soldPrice||0)*(e.qty||1),0);
  const totalCost = soldHistory.reduce((s,e)=>s+(e.paid||0)*(e.qty||1),0);
  const totalPnL = totalProceeds - totalCost;
  const pnlCol = totalPnL>=0?'var(--green)':'var(--red)';
  const pnlPct = totalCost>0?((totalPnL/totalCost)*100).toFixed(1):null;

  if(summary) summary.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:14px;">
      <div style="background:var(--bg3);border-radius:var(--r);padding:10px;text-align:center;">
        <div style="font-size:9px;color:var(--muted);font-family:var(--mono);text-transform:uppercase;letter-spacing:1px;">Total Sold</div>
        <div style="font-size:17px;font-weight:700;">${soldHistory.length}</div>
      </div>
      <div style="background:var(--bg3);border-radius:var(--r);padding:10px;text-align:center;">
        <div style="font-size:9px;color:var(--muted);font-family:var(--mono);text-transform:uppercase;letter-spacing:1px;">Proceeds</div>
        <div style="font-size:17px;font-weight:700;color:var(--gold);">$${totalProceeds.toLocaleString('en-US',{maximumFractionDigits:0})}</div>
      </div>
      <div style="background:var(--bg3);border-radius:var(--r);padding:10px;text-align:center;">
        <div style="font-size:9px;color:var(--muted);font-family:var(--mono);text-transform:uppercase;letter-spacing:1px;">Realized P&L</div>
        <div style="font-size:17px;font-weight:700;color:${pnlCol};">${totalPnL>=0?'+':''}$${Math.abs(totalPnL).toLocaleString('en-US',{maximumFractionDigits:0})}</div>
      </div>
    </div>`;

  body.innerHTML = soldHistory.map(e=>{
    const pnl = (e.soldPrice||0) - (e.paid||0);
    const pnlCol = pnl>=0?'var(--green)':'var(--red)';
    const pnlPct = e.paid>0?((pnl/e.paid)*100).toFixed(0):null;
    const date = new Date(e.soldDate).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
    return `<div style="display:flex;gap:12px;align-items:center;padding:12px 0;border-bottom:1px solid var(--border);">
      ${e.img?`<img src="${esc(e.img)}" style="width:42px;height:58px;object-fit:cover;border-radius:5px;flex-shrink:0;" onerror="this.style.display='none'">`:'<div style="width:42px;height:58px;background:var(--bg3);border-radius:5px;flex-shrink:0;"></div>'}
      <div style="flex:1;min-width:0;">
        <div style="font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(e.name)}</div>
        <div style="font-size:10px;color:var(--muted);font-family:var(--mono);">${esc(e.set||'')}${e.num?' · #'+esc(e.num):''}${e.grade?' · '+esc(e.grade):''}</div>
        <div style="font-size:10px;color:var(--muted);margin-top:2px;">${date} · Paid $${(e.paid||0).toFixed(2)} → Sold $${(e.soldPrice||0).toFixed(2)}</div>
      </div>
      <div style="text-align:right;flex-shrink:0;">
        <div style="font-weight:700;font-size:13px;color:${pnlCol};">${pnl>=0?'+':''}$${Math.abs(pnl).toFixed(2)}</div>
        ${pnlPct?`<div style="font-size:10px;color:${pnlCol};">${pnl>=0?'+':''}${pnlPct}%</div>`:''}
        <div style="display:flex;gap:4px;margin-top:6px;">
          <button class="btn btn-ghost btn-xs" style="font-size:9px;padding:3px 6px;" onclick="restoreSoldCard('${e.id}')">↩ Restore</button>
          <button class="btn btn-danger btn-xs" style="font-size:9px;padding:3px 6px;" onclick="deleteSoldEntry('${e.id}')">✕</button>
        </div>
      </div>
    </div>`;
  }).join('');
}

let _removeCardId = null;
function delCard(id){
  const card = collection.find(c=>c.id===id);
  if(!card){ return; }
  _removeCardId = id;
  document.getElementById('remove-msg').textContent = card.name + (card.num?' · #'+card.num:'') + (card.grade?' · '+card.grade:'');
  document.getElementById('remove-bg').classList.add('open');
}
function closeRemove(){ document.getElementById('remove-bg').classList.remove('open'); _removeCardId = null; }
function removeAsSold(){ const id = _removeCardId; closeRemove(); const card = collection.find(c=>c.id===id); if(card) openSellModal(card); }
let _lastRemoved = null;
function removeNoSale(){ const id = _removeCardId; const idx = collection.findIndex(c=>c.id===id); const card = idx>=0 ? collection[idx] : null; closeRemove(); if(!card) return; _lastRemoved = { card:{...card}, idx }; retire('card', id); collection = collection.filter(c=>c.id!==id); save(); renderAll(); toast((card.name||'Card') + ' removed', 'red', undoRemove); }
function undoRemove(){ if(!_lastRemoved) return; const {card, idx} = _lastRemoved; _lastRemoved = null; if(collection.some(c=>c.id===card.id)){ renderAll(); return; } if(idx>=0 && idx<=collection.length) collection.splice(idx,0,card); else collection.push(card); save(); renderAll(); toast((card.name||'Card') + ' restored','green'); }

function openSellModal(card){
  window._sellCardId = card.id;
  const p = cardPriceData(card);
  const marketPrice = cardValue(card);
  const paid = parseFloat(card.paid)||0;
  window._sellMarketPrice = marketPrice;

  const img = p?.img || card.img || '';
  document.getElementById('sell-modal-body').innerHTML = `
    <div style="display:flex;gap:12px;align-items:center;margin-bottom:16px;">
      ${img?`<img src="${esc(img)}" style="width:48px;height:67px;object-fit:cover;border-radius:6px;" onerror="this.style.display='none'">`:''}
      <div>
        <div style="font-weight:600;font-size:15px;">${esc(card.name)}</div>
        <div style="font-size:11px;color:var(--muted);font-family:var(--mono);">${esc(card.set||'')}${card.num?' · #'+esc(card.num):''}${card.grade?' · '+esc(card.grade):''}</div>
      </div>
    </div>
    <div style="display:flex;gap:10px;margin-bottom:14px;">
      <div style="flex:1;background:var(--bg3);border-radius:var(--r);padding:10px;">
        <div style="font-size:10px;color:var(--muted);font-family:var(--mono);text-transform:uppercase;">You Paid</div>
        <div style="font-size:16px;font-weight:700;">${paid>0?'$'+paid.toFixed(2):'—'}</div>
      </div>
      <div style="flex:1;background:var(--bg3);border-radius:var(--r);padding:10px;">
        <div style="font-size:10px;color:var(--muted);font-family:var(--mono);text-transform:uppercase;">Market Value</div>
        <div style="font-size:16px;font-weight:700;color:var(--gold);">${marketPrice>0?'$'+marketPrice.toFixed(2):'—'}</div>
      </div>
    </div>
    <label style="font-size:12px;color:var(--muted);display:block;margin-bottom:6px;">Sale price (leave blank to use market value)</label>
    <input id="sell-price-input" type="number" step="0.01" placeholder="${marketPrice>0?marketPrice.toFixed(2):'0.00'}" style="width:100%;padding:11px;background:var(--bg3);border:1px solid var(--border);border-radius:var(--r);color:var(--text);font-size:15px;font-family:var(--mono);margin-bottom:14px;">
    <div id="sell-pnl-preview" style="font-size:12px;color:var(--muted);margin-bottom:4px;"></div>
  `;

  // Live P&L preview
  setTimeout(()=>{
    const inp = document.getElementById('sell-price-input');
    const updatePreview = ()=>{
      const sale = parseFloat(inp.value) || marketPrice;
      const pnl = sale - paid;
      const pct = paid>0 ? ((pnl/paid)*100).toFixed(1) : null;
      const col = pnl>=0 ? 'var(--green)' : 'var(--red)';
      document.getElementById('sell-pnl-preview').innerHTML = paid>0
        ? `Realized P&L: <span style="color:${col};font-weight:700;">${pnl>=0?'+':''}$${pnl.toFixed(2)}${pct?` (${pnl>=0?'+':''}${pct}%)`:''}</span>`
        : `Sale value: <span style="color:var(--gold);font-weight:700;">$${sale.toFixed(2)}</span>`;
    };
    if(inp){ inp.addEventListener('input', updatePreview); updatePreview(); }
  }, 50);

  openModal('sell-modal');
}

function confirmSell(){
  const card = collection.find(c=>c.id===window._sellCardId);
  if(!card){ closeModal('sell-modal'); return; }
  const inp = document.getElementById('sell-price-input');
  const salePrice = parseFloat(inp?.value) || window._sellMarketPrice || 0;
  const paid = parseFloat(card.paid)||0;

  // Record in sold history
  soldHistory.unshift({
    id: newId('sold'),
    cardId: card.cardId||'',
    name: card.name,
    set: card.set||'',
    num: card.num||'',
    img: cardPriceData(card)?.img || card.img || '',
    type: card.type||'standard',
    grade: card.grade||'',
    cond: card.cond||'',
    paid: paid,
    soldPrice: salePrice,
    marketPrice: window._sellMarketPrice||0,
    realizedPnL: salePrice - paid,
    qty: card.qty||1,
    soldDate: new Date().toISOString(),
    origCard: {...card}  // store full card so we can restore it
  });
  saveTransactionToDatabase({
    client_id:    card.id || null,
    txn_type:     'sell',
    card_name:    card.name || null,
    quantity:     card.qty || 1,
    unit_price:   salePrice,
    total_amount: salePrice * (card.qty || 1),
    cost_basis:   paid,
    realized_pnl: (salePrice - paid) * (card.qty || 1),
    occurred_at:  new Date().toISOString()
  });
  saveSoldHistory();

  // Remove from collection
  retire('card', card.id);
  collection = collection.filter(c=>c.id!==card.id);
  save();
  closeModal('sell-modal');
  renderAll();
  if(typeof renderSoldHistory==='function') renderSoldHistory();
  toast(`${card.name} sold for $${salePrice.toFixed(2)}`,'green');
}

function restoreSoldCard(soldId){
  const entry = soldHistory.find(s=>s.id===soldId);
  if(!entry){ return; }
  showConfirm('Restore to collection?', `Add ${entry.name} back to your vault?`, ()=>{
    const card = entry.origCard || {
      id:newId('c'), name:entry.name, set:entry.set, num:entry.num,
      cardId:entry.cardId, type:entry.type, grade:entry.grade, cond:entry.cond,
      paid:entry.paid, qty:entry.qty, img:entry.img, added:new Date().toISOString()
    };
    card.id = newId('c'); // fresh id
    collection.push(card);
    // Retire the sold record in the deletion ledger before dropping it. Without this,
    // mergeById() on the next sync sees the entry still present in the cloud (or on
    // another device) and resurrects it — the card would be back in the vault AND
    // still listed as sold. clearAll() already retires 'sold' entries this way.
    retire('sold', soldId);
    soldHistory = soldHistory.filter(s=>s.id!==soldId);
    save();
    renderAll();
    if(typeof renderSoldHistory==='function') renderSoldHistory();
    toast(`${entry.name} restored to collection`,'green');
  });
}

function deleteSoldEntry(soldId){
  showConfirm('Delete from history?','This permanently removes the record.',()=>{
    // Same ledger requirement as restoreSoldCard — and this path previously never
    // called save(), so the delete was written to localStorage but never marked
    // dirty, never queued a push, and left realized P&L stale on the dashboard.
    retire('sold', soldId);
    soldHistory = soldHistory.filter(s=>s.id!==soldId);
    save();
    renderSoldHistory();
    renderDashboard();          // realized P&L is derived from soldHistory
    toast('Record deleted','red');
  });
}

// ═══ ADD FORM HELPERS ═══
function selectType(val,el){document.querySelectorAll('#add-modal .type-pill').forEach(p=>p.classList.remove('active'));if(el)el.classList.add('active');document.getElementById('f-type').value=val;document.getElementById('graded-section').style.display=val==='graded'?'':'none';document.getElementById('cond-section').style.display=val==='graded'?'none':'';if(val==='graded')syncGrade();else document.getElementById('f-grade').value='';updateAddPreview();}
function selectCond(val,el){document.querySelectorAll('.cond-pill').forEach(p=>p.classList.remove('active'));if(el)el.classList.add('active');document.getElementById('f-cond').value=val;updateAddPreview();}
function selectEdition(val,el){document.querySelectorAll('#edition-section .ed-pill').forEach(p=>p.classList.remove('active'));if(el)el.classList.add('active');document.getElementById('f-edition').value=val;updateAddPreview();}
function refreshEditionSection(){
  const sec=document.getElementById('edition-section');if(!sec)return;
  const probe={set:document.getElementById('f-set').value,cardId:document.getElementById('f-cardid').value,type:document.getElementById('f-type').value};
  const elig=editionEligibility(probe);
  if(!elig.eligible){sec.style.display='none';document.getElementById('f-edition').value='unlimited';return;}
  sec.style.display='';
  document.getElementById('ed-pill-shadowless').style.display=elig.shadowless?'':'none';
  if(!elig.shadowless&&document.getElementById('f-edition').value==='shadowless'){
    selectEdition('unlimited',document.querySelector('#edition-section .ed-pill[data-val="unlimited"]'));
  }
}
function syncGrade(){const grader=document.getElementById('f-grader').value;const grade=document.getElementById('f-grade-sel').value;document.getElementById('f-grade').value=grader+' '+grade;updateAddPreview();}
function updateAddPreview(){const name=document.getElementById('f-name').value.trim();const set=document.getElementById('f-set').value.trim();const num=document.getElementById('f-num').value.trim();const img=document.getElementById('f-img').value.trim();const type=document.getElementById('f-type').value;const cond=document.getElementById('f-cond').value;const grade=document.getElementById('f-grade').value.trim();const nameEl=document.getElementById('add-prev-name');const metaEl=document.getElementById('add-prev-meta');const tagsEl=document.getElementById('add-prev-tags');const imgWrap=document.getElementById('add-prev-img');nameEl.textContent=name||'No card selected';nameEl.style.color=name?'var(--text)':'var(--muted)';metaEl.textContent=[set,num?'#'+num:''].filter(Boolean).join(' · ')||'Fill in details below';if(img)imgWrap.innerHTML=`<img src="${img}" style="width:100%;height:100%;object-fit:cover;" loading="lazy">`;else imgWrap.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width:22px;height:22px;color:var(--muted)"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>';const typeLabel={standard:'Standard',holo:'Holo',reverse:'Reverse',ex:'ex/GX/V',graded:'Graded'}[type]||type;const typeColor={standard:'rgba(90,90,114,.2)',holo:'rgba(176,110,245,.2)',reverse:'rgba(15,212,176,.15)',ex:'rgba(245,200,66,.18)',graded:'rgba(79,142,247,.18)'}[type]||'';const typeText={standard:'#9ca3af',holo:'#c084fc',reverse:'#2dd4bf',ex:'var(--gold)',graded:'#60a5fa'}[type]||'';let tags=`<span style="background:${typeColor};color:${typeText};font-family:var(--mono);font-size:10px;font-weight:600;padding:2px 8px;border-radius:5px;text-transform:uppercase;">${typeLabel}</span>`;if(grade)tags+=`<span style="background:rgba(245,200,66,.15);color:var(--gold);font-family:var(--mono);font-size:10px;font-weight:600;padding:2px 8px;border-radius:5px;">${grade}</span>`;else if(cond){const cc={NM:'rgba(46,204,128,.15)',LP:'rgba(79,142,247,.15)',MP:'rgba(255,140,66,.15)',HP:'rgba(255,77,109,.15)'}[cond]||'';const ct={NM:'#4ade80',LP:'#60a5fa',MP:'var(--orange)',HP:'var(--red)'}[cond]||'';tags+=`<span style="background:${cc};color:${ct};font-family:var(--mono);font-size:10px;font-weight:600;padding:2px 8px;border-radius:5px;">${cond}</span>`;}tags+=editionBadge({edition:(document.getElementById('f-edition')||{}).value||'unlimited'});tagsEl.innerHTML=tags;}
async function verifyCert(){const cert=document.getElementById('f-cert').value.trim();if(!cert)return;const msg=document.getElementById('cert-msg');msg.innerHTML='<span style="color:var(--muted)"><span class="spinner" style="display:inline-block;vertical-align:-2px;margin-right:4px"></span>Verifying…</span>';if(!keys.psa){msg.innerHTML='<span style="color:var(--gold)">⚠ Add PSA token in Settings.</span>';return;}try{const r=await fetch(`https://api.psacard.com/publicapi/cert/GetByCertNumber/${cert}`,{headers:{Authorization:'bearer '+keys.psa}});if(!r.ok)throw new Error();const j=await r.json();const info=j.PSACert;if(info){document.getElementById('f-name').value=info.Subject||document.getElementById('f-name').value;document.getElementById('f-grade').value='PSA '+(info.CardGrade||'');document.getElementById('f-type').value='graded';msg.innerHTML=`<span style="color:var(--green)">✓ PSA ${info.CardGrade} — ${info.Subject}</span>`;}}catch(e){msg.innerHTML='<span style="color:var(--red)">Cert not found.</span>';}}
