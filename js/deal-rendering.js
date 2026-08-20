/* ════════════════════════════════════════════════════════════════════════════
   MyTCG Ledger V6 - deal-rendering.js
   ────────────────────────────────────────────────────────────────────────────
   DOMAIN MODULE (deal presentation / history / performance). The third Deals
   slice. Deals is now converging on: deal-log (form UI), deal-search
   (discovery), deal-rendering (presentation) - with persistence/apply and
   evaluation still inline.

   OWNS:
     - legacy compatibility  isLegacyDeal, normalizeDeal   (READ-ONLY canonical
                             view of v1 records; nothing here rewrites stored data)
     - negotiation section   renderDealNegotiation
     - legacy list           renderLegacyDeals
     - gallery + leaderboard renderDealGalleryAndLeaderboard
     - page orchestration    renderDeals

   TWO PHYSICAL RUNS, ONE DOMAIN. The runs are separated by the deal-PERSISTENCE
   block (saveDealLog / applyDealToPortfolio / makeCardFromDeal /
   removeCardFromCollection / deleteDeal / markDealClosed), which stays inline.
   The cut goes around it - persistence was never part of this domain.

   PURELY READ-ONLY, verified mechanically: zero writes to deals, collection,
   soldHistory, wishlist, sealed, pcache, liqCache, AppState or the deletion
   ledger; zero fetch; zero save(); zero dbWrite; zero analytics.

   PERSISTENCE IS REACHED ONLY THROUGH GENERATED MARKUP. deleteDeal,
   markDealClosed and openDealLogModal appear exclusively inside onclick strings
   in rendered templates - they fire on user click, never during a render pass.
   That is a UI-level edge, not a runtime dependency.

   normalizeDeal OWNERSHIP: its only caller is renderLegacyDeals, so legacy
   normalisation here is presentation compatibility, not a persistence concern.
   Deal normalisation remains known deferred debt - moved unchanged, not fixed.

   RENAMED (maintainability batch): renderDBNegotiation -> renderDealNegotiation.
   The DB- prefix was a dashboard artefact; the function renders the Deals page's
   negotiation-summary section and its only caller is renderDeals. 7 references
   updated, no inline handlers, no aliases retained.

   DOES NOT OWN: deal persistence/apply, deal-log form state, deal search, deal
   evaluation, card detail, cards CRUD, pricing, valuation, storage, analytics,
   nav.

   CALL-TIME DEPENDENCIES:
     core        esc, money, fmtDate
     valuation   cardValue, cacheKey
     pricing     buildCardStrip
     evaluation  dealVerdictBadge - called from inside a render template, so this
                 IS a runtime edge into the still-inline evaluation pair
     inline      deals, collection, and the #dp-* / #deal-* DOM
   INBOUND (all call-time): inline goPage, refreshCurrentPage and deleteDeal ->
   renderDeals. No extracted module calls in; no cycle.

   LOAD-TIME EXECUTION: none. Zero declarations, zero statements - function
   declarations only.
   ════════════════════════════════════════════════════════════════════════════ */

function isLegacyDeal(d){
  return !!d && !d.dealType && !d.status && d.amount != null;
}
// Read-only canonical view of any deal record. Legacy fields are mapped, never moved.
function normalizeDeal(d){
  if (!d) return null;
  if (!isLegacyDeal(d)) return d;
  const amt = parseFloat(d.amount) || 0;
  return {
    ...d,
    _legacy:   true,
    dealType:  d.type === 'sell' ? 'sale' : d.type === 'buy' ? 'purchase' : 'offer',
    cardName:  d.name || '',
    platform:  d.source || '',
    notes:     d.notes || '',
    date:      d.date || '',
    amount:    amt,
    // Deliberately NOT given a status / buyPrice / sellPrice: a v1 record carries a
    // single amount with no counterpart, so folding it into the closed-deal ROI math
    // would invent a 100% loss. It is surfaced read-only instead.
  };
}

// (2026-08) REMOVED: the v1 deal-modal JavaScript cluster — openDealModal(),
// runDealSearch(), selectDealCard(), clearDealSelection(), closeDealDD(),
// selectDealType(), saveDeal(), dealSearchTimer, dealSearchSelected, and a
// document-level click listener that ran closest('#deal-modal') on EVERY click
// in the app to close a dropdown that no longer existed. All were reachable
// only from the #deal-modal markup removed above; each had zero other callers.
// Deliberately KEPT: onDealSearch() / doDealSearch(), which serve the LIVE
// deals-page search bar, and the whole legacy-deal READ path.
// ══════════════════════════════
// DEAL PERFORMANCE CENTER
// ══════════════════════════════
function renderDealNegotiation() {
  // Get all deals with negotiation data
  const negDeals = deals.filter(d => d.sellerAsk && d.finalPrice);
  const section  = document.getElementById('dp-neg-section');
  if (!negDeals.length) { if(section) section.style.display='none'; return; }
  if (section) section.style.display = '';

  // Calculate stats
  let totalSaved=0, totalAsk=0, totalOffer=0, totalFinal=0;
  let bestSaved=-Infinity, bestDeal=null;

  negDeals.forEach(d => {
    const ask   = parseFloat(d.sellerAsk||0);
    const final = parseFloat(d.finalPrice||0);
    const saved = ask - final;
    totalSaved += saved;
    totalAsk   += ask;
    totalFinal += final;
    if(d.myOffer) totalOffer += parseFloat(d.myOffer);
    if(saved > bestSaved){ bestSaved=saved; bestDeal=d; }
  });

  const avgSaved  = totalSaved / negDeals.length;
  const avgAsk    = totalAsk   / negDeals.length;
  const avgOffer  = totalOffer / negDeals.filter(d=>d.myOffer).length || 0;
  const avgFinal  = totalFinal / negDeals.length;
  const avgPct    = ((totalSaved/totalAsk)*100).toFixed(1);

  const fmt = v => '$'+Math.abs(v).toLocaleString('en-US',{minimumFractionDigits:0,maximumFractionDigits:0});

  // Update stat cards
  document.getElementById('dp-neg-avg-saved').textContent  = '-'+fmt(avgSaved);
  document.getElementById('dp-neg-avg-pct').textContent    = '-'+avgPct+'%';
  document.getElementById('dp-neg-total-saved').textContent= '-'+fmt(totalSaved);
  if(bestDeal){
    document.getElementById('dp-neg-best-name').textContent = (bestDeal.cardsOut||[{name:bestDeal.cardName}])[0]?.name||'—';
    document.getElementById('dp-neg-best-val').textContent  = '-'+fmt(parseFloat(bestDeal.sellerAsk)-parseFloat(bestDeal.finalPrice))+' saved';
  }

  // Pattern bar — averages
  document.getElementById('dp-neg-bar-ask').textContent   = fmt(avgAsk);
  document.getElementById('dp-neg-bar-offer').textContent = avgOffer>0 ? fmt(avgOffer) : '—';
  document.getElementById('dp-neg-bar-final').textContent = fmt(avgFinal);

  // Progress bar — where does final typically land between offer and ask
  const offerDeals = negDeals.filter(d=>d.myOffer);
  if(offerDeals.length) {
    const wrap = document.getElementById('dp-neg-progress-wrap');
    if(wrap) wrap.style.display='';
    const avgO = offerDeals.reduce((s,d)=>s+parseFloat(d.myOffer),0)/offerDeals.length;
    const avgA = offerDeals.reduce((s,d)=>s+parseFloat(d.sellerAsk),0)/offerDeals.length;
    const avgF = offerDeals.reduce((s,d)=>s+parseFloat(d.finalPrice),0)/offerDeals.length;
    const range = avgA - avgO;
    const pct   = range>0 ? Math.min(100,Math.max(0,((avgF-avgO)/range)*100)) : 50;
    const fill  = document.getElementById('dp-neg-progress-fill');
    const lbl   = document.getElementById('dp-neg-progress-label');
    if(fill) fill.style.width = pct+'%';
    if(lbl)  lbl.textContent  = `You typically meet ${(100-pct).toFixed(0)}% of the way from your offer to their ask`;
  }

  // Deal history table
  const hist = document.getElementById('dp-neg-history');
  if(hist){
    hist.innerHTML = negDeals.slice().reverse().slice(0,8).map(d => {
      const ask   = parseFloat(d.sellerAsk||0);
      const offer = parseFloat(d.myOffer||0);
      const final = parseFloat(d.finalPrice||0);
      const saved = ask - final;
      const pct   = ask>0?((saved/ask)*100).toFixed(1):null;
      const name  = (d.cardsOut||[{name:d.cardName}])[0]?.name||'—';
      const img   = (d.cardsOut||[{img:d.img}])[0]?.img||d.img||'';
      return `<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border);">
        ${img?`<img src="${esc(img)}" style="width:28px;height:39px;object-fit:contain;border-radius:3px;flex-shrink:0;">`:'<div style="width:28px;height:39px;background:var(--bg3);border-radius:3px;flex-shrink:0;"></div>'}
        <div style="flex:1;min-width:0;">
          <div style="font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(name)}</div>
          <div style="font-family:var(--mono);font-size:10px;color:var(--muted);">${esc(d.date||'—')} · ${esc(d.platform||'—')}</div>
        </div>
        <div style="display:flex;gap:8px;align-items:center;font-family:var(--mono);font-size:11px;flex-shrink:0;">
          <span style="color:var(--red);">Ask: $${ask.toFixed(0)}</span>
          ${offer>0?`<span style="color:var(--muted);">→</span><span style="color:var(--gold);">Off: $${offer.toFixed(0)}</span>`:''}
          <span style="color:var(--muted);">→</span>
          <span style="color:var(--green);">Final: $${final.toFixed(0)}</span>
          <span style="background:rgba(46,204,128,.12);color:var(--green);padding:2px 6px;border-radius:4px;font-size:10px;">-${pct||0}%</span>
        </div>
      </div>`;
    }).join('');
  }
}

// Read-only list of v1 deal records so historical data is visible instead of
// silently invisible. Delete is offered (it goes through the same retire() ledger
// path as every other delete); editing is not, because the v1 editor is retired.
function renderLegacyDeals(legacyDeals){
  const section = document.getElementById('dp-legacy-section');
  const list    = document.getElementById('dp-legacy-list');
  const count   = document.getElementById('dp-legacy-count');
  if (!section || !list) return;
  if (!legacyDeals.length) { section.hidden = true; list.innerHTML = ''; return; }
  section.hidden = false;
  if (count) count.textContent = legacyDeals.length;
  const badgeFor = t => t === 'sale'     ? '<span class="deal-badge d-sell">Sale</span>'
                      : t === 'purchase' ? '<span class="deal-badge d-buy">Purchase</span>'
                      :                    '<span class="deal-badge d-offer">Offer</span>';
  list.innerHTML = legacyDeals.map(raw => {
    const d = normalizeDeal(raw);
    return `<div class="deal-row">
      ${badgeFor(d.dealType)}
      <div class="deal-name">
        <div class="deal-main">${esc(d.cardName || '—')}</div>
        <div class="deal-meta">${esc([d.platform, d.cond, d.notes].filter(Boolean).join(' · ')) || '—'}</div>
      </div>
      <div class="deal-amt">${moneyFull(d.amount)}</div>
      <div class="deal-date">${esc(d.date || '—')}</div>
      <button class="btn btn-danger btn-xs" onclick="deleteDeal('${d.id}')">✕</button>
    </div>`;
  }).join('');
}

function renderDealGalleryAndLeaderboard() {
  const closedDeals = deals.filter(d => d.status === 'closed');

  // ── Card Gallery ──
  const gallerySection = document.getElementById('dp-gallery-section');
  const galleryEl      = document.getElementById('dp-card-gallery');

  if (galleryEl && closedDeals.length) {
    if (gallerySection) gallerySection.style.display = '';

    // Collect all card images from all deals
    const allCards = [];
    closedDeals.forEach(d => {
      (d.cardsOut || []).forEach(card => {
        if (card.img) allCards.push({ ...card, dealProfit: parseFloat(d.sellPrice||0) - parseFloat(d.buyPrice||0), side: 'out', dealId: d.id });
      });
      (d.cardsIn || []).forEach(card => {
        if (card.img) allCards.push({ ...card, dealProfit: parseFloat(d.sellPrice||0) - parseFloat(d.buyPrice||0), side: 'in', dealId: d.id });
      });
    });

    if (allCards.length) {
      galleryEl.innerHTML = allCards.slice(0, 30).map(card => {
        const profit = card.dealProfit;
        const borderCol = profit > 0 ? 'rgba(46,204,128,0.4)' : profit < 0 ? 'rgba(255,77,109,0.4)' : 'var(--border)';
        return `<div style="position:relative;cursor:pointer;transition:transform .15s;"
          onmouseover="this.style.transform='translateY(-3px)'"
          onmouseout="this.style.transform=''"
          title="${esc(card.name)}${profit !== 0 ? ' · ' + (profit>0?'+':'') + '$' + profit.toFixed(0) : ''}">
          <img src="${esc(card.img)}" alt="${esc(card.name)}"
            style="width:72px;height:100px;object-fit:cover;border-radius:6px;border:2px solid ${borderCol};display:block;">
          <div style="position:absolute;bottom:3px;right:3px;background:rgba(0,0,0,.75);border-radius:3px;padding:1px 4px;font-family:var(--mono);font-size:8px;font-weight:700;color:${profit>=0?'#2ecc80':'#ff4d6d'};">
            ${profit!==0?(profit>0?'+':'')+'\$'+Math.abs(profit).toFixed(0):''}
          </div>
        </div>`;
      }).join('');
    } else {
      galleryEl.innerHTML = '<div style="font-size:12px;color:var(--muted);">Card images will appear here as you log deals.</div>';
    }
  }

  // ── Top 5 Leaderboard ──
  const lbSection = document.getElementById('dp-leaderboard-section');
  const lbEl      = document.getElementById('dp-leaderboard');

  if (lbEl && closedDeals.length) {
    if (lbSection) lbSection.style.display = '';

    const ranked = closedDeals
      .map(d => ({
        d,
        profit: parseFloat(d.sellPrice||0) - parseFloat(d.buyPrice||0),
        roi:    parseFloat(d.buyPrice) > 0 ? (((parseFloat(d.sellPrice||0)-parseFloat(d.buyPrice||0))/parseFloat(d.buyPrice))*100).toFixed(1) : null,
        img:    (d.cardsOut||[])[0]?.img || d.img || '',
        name:   (d.cardsOut||[{name:d.cardName}])[0]?.name || d.cardName || '—',
      }))
      .filter(r => r.profit > 0)
      .sort((a,b) => b.profit - a.profit)
      .slice(0, 5);

    if (!ranked.length) {
      if (lbSection) lbSection.style.display = 'none';
      return;
    }

    const medals = ['🥇','🥈','🥉','4️⃣','5️⃣'];
    lbEl.innerHTML = ranked.map((r, i) => `
      <div style="background:var(--bg2);border:1px solid var(--border);border-radius:var(--r2);overflow:hidden;position:relative;${i===0?'border-color:var(--gold);':''}" title="${esc(r.name)}">
        <div style="position:relative;">
          ${r.img
            ? `<img src="${esc(r.img)}" alt="${esc(r.name)}" style="width:100%;aspect-ratio:3/4;object-fit:cover;display:block;">`
            : `<div style="width:100%;aspect-ratio:3/4;background:var(--bg3);display:flex;align-items:center;justify-content:center;font-size:32px;">⟡</div>`}
          <div style="position:absolute;top:6px;left:6px;font-size:16px;">${medals[i]}</div>
          <div style="position:absolute;bottom:0;left:0;right:0;background:linear-gradient(transparent,rgba(0,0,0,.85));padding:8px 8px 6px;">
            <div style="font-family:var(--mono);font-size:13px;font-weight:800;color:var(--green);">+\$${r.profit.toFixed(0)}</div>
            ${r.roi?`<div style="font-family:var(--mono);font-size:10px;color:rgba(255,255,255,.6);">+${r.roi}% ROI</div>`:''}
          </div>
        </div>
        <div style="padding:7px 8px;">
          <div style="font-size:10px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(r.name)}</div>
          <div style="font-family:var(--mono);font-size:9px;color:var(--muted);">${esc(r.d.platform||r.d.sellPlatform||'—')} · ${esc(r.d.date||r.d.sellDate||'—')}</div>
        </div>
      </div>`).join('');
  }
}

function renderDeals() {
  // Legacy (v1) records are separated out first so the stats below operate on the
  // v2 shape only — exactly as before this change. Nothing is mutated or dropped.
  const legacyDeals = deals.filter(isLegacyDeal);
  const openDeals   = deals.filter(d => d.status === 'open');
  const closedDeals = deals.filter(d => d.status === 'closed');
  renderLegacyDeals(legacyDeals);

  document.getElementById('nb-deals').textContent = deals.length;
  document.getElementById('dp-open-count').textContent = openDeals.length ? openDeals.length : '';
  document.getElementById('dp-closed-count').textContent = closedDeals.length ? closedDeals.length + ' deals' : '';

  // ── Stats ──
  let capital=0, revenue=0, bestProfit=-Infinity, bestDeal=null, wins=0;
  const platformStats = {};

  closedDeals.forEach(d => {
    const buy  = parseFloat(d.buyPrice||0);
    const sell = parseFloat(d.sellPrice||0);
    const profit = sell - buy;
    capital  += buy;
    revenue  += sell;
    if (profit > bestProfit) { bestProfit = profit; bestDeal = d; }
    if (profit > 0) wins++;
    // Platform tracking
    const plat = d.sellPlatform || 'Unknown';
    if (!platformStats[plat]) platformStats[plat] = {count:0, capital:0, revenue:0};
    platformStats[plat].count++;
    platformStats[plat].capital += buy;
    platformStats[plat].revenue += sell;
  });

  const totalProfit = revenue - capital;
  const avgROI = capital > 0 ? ((totalProfit/capital)*100).toFixed(1) : null;
  const winRate = closedDeals.length > 0 ? ((wins/closedDeals.length)*100).toFixed(0) : null;

  const fmt = v => '$' + Math.abs(v).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});

  document.getElementById('dp-closed').textContent = closedDeals.length;
  document.getElementById('dp-capital').textContent = capital > 0 ? fmt(capital) : '—';
  document.getElementById('dp-revenue').textContent = revenue > 0 ? fmt(revenue) : '—';

  const profitEl = document.getElementById('dp-profit');
  profitEl.textContent = capital > 0 ? (totalProfit>=0?'+':'') + fmt(totalProfit) : '—';
  profitEl.style.color = totalProfit >= 0 ? 'var(--green)' : 'var(--red)';

  document.getElementById('dp-roi').textContent = avgROI ? (avgROI>=0?'+':'') + avgROI + '%' : '—';
  document.getElementById('dp-roi').style.color = avgROI >= 0 ? 'var(--green)' : 'var(--red)';
  document.getElementById('dp-winrate').textContent = winRate ? winRate + '%' : '—';
  document.getElementById('dp-winrate').style.color = winRate >= 50 ? 'var(--green)' : 'var(--red)';

  if (bestDeal) {
    document.getElementById('dp-best-name').textContent = bestDeal.cardName;
    document.getElementById('dp-best-val').textContent = '+' + fmt(parseFloat(bestDeal.sellPrice)-parseFloat(bestDeal.buyPrice)) + ' profit';
  }

  // ── Platform breakdown ──
  const platKeys = Object.keys(platformStats).sort((a,b) => {
    const roiA = platformStats[a].capital > 0 ? (platformStats[a].revenue-platformStats[a].capital)/platformStats[a].capital : 0;
    const roiB = platformStats[b].capital > 0 ? (platformStats[b].revenue-platformStats[b].capital)/platformStats[b].capital : 0;
    return roiB - roiA;
  });
  const platEl = document.getElementById('dp-platforms');
  const platList = document.getElementById('dp-platform-list');
  if (platKeys.length) {
    platEl.style.display = '';
    platList.innerHTML = platKeys.map(p => {
      const s = platformStats[p];
      const roi = s.capital > 0 ? (((s.revenue-s.capital)/s.capital)*100).toFixed(1) : 0;
      const profit = s.revenue - s.capital;
      return `<div style="display:flex;align-items:center;justify-content:space-between;padding:5px 0;border-bottom:1px solid var(--border);font-size:12px;">
        <span style="font-weight:500;">${esc(p)}</span>
        <span style="font-family:var(--mono);font-size:10px;color:var(--muted);">${s.count} deal${s.count!==1?'s':''}</span>
        <span style="font-family:var(--mono);font-size:11px;color:${profit>=0?'var(--green)':'var(--red)'};">${profit>=0?'+':''}${fmt(profit)}</span>
        <span style="font-family:var(--mono);font-size:11px;color:${roi>=0?'var(--green)':'var(--red)'};">${roi>=0?'+':''}${roi}% ROI</span>
      </div>`;
    }).join('');
  } else platEl.style.display = 'none';

  // ── Open deals list ──
  const openEl = document.getElementById('dp-open-list');
  const openEmpty = document.getElementById('dp-open-empty');
  if (!openDeals.length) { openEl.innerHTML = ''; openEmpty.style.display = ''; }
  else {
    openEmpty.style.display = 'none';
    openEl.innerHTML = openDeals.sort((a,b)=>new Date(b.added)-new Date(a.added)).map(d => {
      // was pcache[d.cardId+'_NM'] — a hand-built key that never matched cacheKey()
      // (which is id_cond_edition), so "potential profit" never rendered. Resolve the
      // owned card by its collection id instead and use the canonical value path.
      const ownedCard = collection.find(c => c.id === d.cardId || c.cardId === d.cardId) || null;
      const mktPrice = ownedCard ? cardValue(ownedCard) : 0;
      const potentialProfit = mktPrice > 0 ? mktPrice - parseFloat(d.buyPrice||0) : null;
      return `<div style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--bg2);border:1px solid var(--border);border-radius:var(--r);margin-bottom:8px;">
        ${d.img ? `<img src="${esc(d.img)}" style="width:36px;height:50px;object-fit:contain;border-radius:4px;flex-shrink:0;">` : '<div style="width:36px;height:50px;background:var(--bg3);border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0;">⟡</div>'}
        <div style="flex:1;min-width:0;">
          <div style="font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(d.cardName)}</div>
          <div style="font-size:10px;color:var(--muted);font-family:var(--mono);">Bought $${parseFloat(d.buyPrice||0).toFixed(2)} · ${esc(d.buyDate||d.date||'—')} · ${esc(d.buyPlatform||d.platform||'—')}</div>
          ${potentialProfit!=null?`<div style="font-size:10px;font-family:var(--mono);color:${potentialProfit>=0?'var(--green)':'var(--red)'};">Mkt: $${mktPrice.toFixed(2)} · Potential ${potentialProfit>=0?'+':''}$${potentialProfit.toFixed(2)}</div>`:''}
        </div>
        <div style="display:flex;gap:6px;flex-shrink:0;">
          <button class="btn btn-primary btn-xs" onclick="markDealClosed('${d.id}')">Mark Sold</button>
          <button class="btn btn-ghost btn-xs" onclick="openDealLogModal('${d.id}')">Edit</button>
          <button class="btn btn-danger btn-xs" onclick="deleteDeal('${d.id}')">✕</button>
        </div>
      </div>`;
    }).join('');
  }

  // ── Negotiation breakdown ──
  renderDealNegotiation();
  renderDealGalleryAndLeaderboard();

  // ── Closed deals list ──
  const closedEl = document.getElementById('dp-closed-list');
  const closedEmpty = document.getElementById('dp-closed-empty');
  if (!closedDeals.length) { closedEl.innerHTML = ''; closedEmpty.style.display = ''; }
  else {
    closedEmpty.style.display = 'none';
    closedEl.innerHTML = closedDeals.sort((a,b)=>new Date(b.added)-new Date(a.added)).map(d => {
      const profit = parseFloat(d.sellPrice||0) - parseFloat(d.buyPrice||0);
      const roi = parseFloat(d.buyPrice) > 0 ? ((profit/parseFloat(d.buyPrice))*100).toFixed(1) : null;
      const col = profit >= 0 ? 'var(--green)' : 'var(--red)';
      const badge = d.dealType === 'trade'
        ? '<span style="font-family:var(--mono);font-size:9px;background:rgba(59,139,255,.15);color:#3b8bff;border:1px solid rgba(59,139,255,.3);padding:1px 6px;border-radius:10px;margin-right:4px;">🔄 Trade</span>'
        : d.dealType === 'purchase'
        ? '<span style="font-family:var(--mono);font-size:9px;background:rgba(245,200,66,.12);color:var(--gold);border:1px solid rgba(245,200,66,.3);padding:1px 6px;border-radius:10px;margin-right:4px;">💳 Purchase</span>'
        : '<span style="font-family:var(--mono);font-size:9px;background:rgba(46,204,128,.1);color:var(--green);border:1px solid rgba(46,204,128,.25);padding:1px 6px;border-radius:10px;margin-right:4px;">💰 Sale</span>';
      const names = (d.cardsOut||[]).map(c=>c.name).filter(Boolean).join(', ') || d.cardName || '—';

      // Build card strips for each side
      const buildCardStrip = (cards, label, labelCol) => {
        if (!cards?.length) return '';
        return `<div style="display:flex;flex-direction:column;gap:4px;">
          <div style="font-family:var(--mono);font-size:8px;color:${labelCol};text-transform:uppercase;letter-spacing:1px;">${label}</div>
          <div style="display:flex;gap:5px;flex-wrap:wrap;">
            ${cards.map(card => `
              <div style="position:relative;" title="${esc(card.name)}${card.value?' · $'+parseFloat(card.value).toFixed(0):''}">
                ${card.img
                  ? `<img src="${esc(card.img)}" style="width:52px;height:72px;object-fit:cover;border-radius:5px;border:1.5px solid rgba(255,255,255,0.08);display:block;">`
                  : `<div style="width:52px;height:72px;background:var(--bg3);border-radius:5px;display:flex;align-items:center;justify-content:center;font-size:14px;">⟡</div>`}
                ${card.value?`<div style="position:absolute;bottom:2px;left:0;right:0;text-align:center;font-family:var(--mono);font-size:8px;font-weight:700;color:#fff;background:rgba(0,0,0,.7);border-radius:0 0 4px 4px;padding:1px 0;">$${parseFloat(card.value).toFixed(0)}</div>`:''}
              </div>`).join('')}
          </div>
        </div>`;
      };

      const outStrip  = d.dealType === 'purchase' ? '' : buildCardStrip(d.cardsOut, d.dealType==='sale'?'You Sold':'You Gave', 'var(--red)');
      const inStrip   = d.dealType === 'purchase'
        ? buildCardStrip(d.cardsIn, 'You Bought', 'var(--gold)')
        : buildCardStrip(d.cardsIn,  'You Got',  'var(--green)');
      const cashOut   = parseFloat(d.cashOut||0);
      const cashInT   = parseFloat(d.cashInTrade||0);

      return `<div style="background:var(--bg2);border:1px solid var(--border);border-radius:var(--r2);margin-bottom:10px;overflow:hidden;">
        <!-- Header row -->
        <div style="display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--border);">
          <div style="flex:1;min-width:0;">
            <div style="font-size:12px;font-weight:600;margin-bottom:2px;">${badge}${dealVerdictBadge(d)}${esc(names)}</div>
            <div style="font-size:10px;color:var(--muted);font-family:var(--mono);">OUT $${parseFloat(d.buyPrice||0).toFixed(2)} → IN $${parseFloat(d.sellPrice||0).toFixed(2)} · ${esc(d.platform||d.sellPlatform||'—')} · ${esc(d.date||d.sellDate||'—')}</div>
          </div>
          <div style="text-align:right;flex-shrink:0;">
            <div style="font-family:var(--mono);font-size:15px;font-weight:700;color:${col};">${profit>=0?'+':''}$${Math.abs(profit).toFixed(2)}</div>
            ${roi?`<div style="font-family:var(--mono);font-size:10px;color:${col};">${roi>=0?'+':''}${roi}% ROI</div>`:''}
          </div>
          <div style="display:flex;gap:4px;flex-shrink:0;">
            <button class="btn btn-ghost btn-xs" onclick="openDealLogModal('${d.id}')">Edit</button>
            <button class="btn btn-danger btn-xs" onclick="deleteDeal('${d.id}')">✕</button>
          </div>
        </div>
        <!-- Card strips -->
        ${(outStrip||inStrip)?`
        <div style="padding:12px 14px;display:flex;gap:20px;flex-wrap:wrap;align-items:flex-start;">
          ${outStrip}
          ${outStrip&&inStrip?`<div style="display:flex;align-items:center;align-self:center;font-size:20px;color:var(--muted);padding-top:16px;">⇄</div>`:''}
          ${inStrip}
          ${cashOut>0||cashInT>0?`<div style="display:flex;flex-direction:column;gap:4px;align-self:flex-end;">
            ${cashOut>0?`<div style="font-family:var(--mono);font-size:10px;color:var(--red);">+$${cashOut.toFixed(2)} cash out</div>`:''}
            ${cashInT>0?`<div style="font-family:var(--mono);font-size:10px;color:var(--green);">+$${cashInT.toFixed(2)} cash in</div>`:''}
          </div>`:''}
        </div>`:''}
      </div>`;
    }).join('');
  }
}
