/* ════════════════════════════════════════════════════════════════════════════
   MyTCG Ledger V6 - scanner.js
   ────────────────────────────────────────────────────────────────────────────
   DOMAIN MODULE (card scanner). A leaf: nothing in the project calls into it
   except inline HTML handlers.

   THE CONTRACT THIS FILE MUST PRESERVE, end to end:
     image input -> /vision request -> result interpretation -> match display
     -> grade preservation -> selected result -> card handoff

   OWNS:
     - scanner state    scanSelectedCard, scanCond, scanEdition,
                        scanDetectedEdition, scanGrade, scanIsGraded,
                        _scanPriceToken (+ window._scanMatches/_scanParsed)
     - option setters   setScanCond, setScanEdition, setScanGrade,
                        normalizeDetectedEdition, applyScanGradeToSelects,
                        applyScanCardOptions
     - image pipeline   preprocessImage
     - identification   callClaudeVision (the ONLY caller of Worker /vision),
                        scanCard, searchAndShowMatches
     - result surface   scanCardFromApi, showScanResultCard, showScanMatches,
                        scanPickMatch, showScanResultManual, showScanError,
                        loadScanPrice
     - handoff / reset  addScannedCard, resetScanner

   DOES NOT OWN: card CRUD (saveCard/editCard/deleteCard/openAddModal stay with
   cards), the card-detail view, pricing acquisition and valuation (loadScanPrice
   calls the existing fetchLivePrices), the price cache, identity, storage
   primitives, sync, the generic search/catalogue, the modal framework, or
   navigation.

   DOCUMENTED PRE-EXISTING BEHAVIOUR, preserved byte-for-byte: addScannedCard()
   pushes onto `collection` and calls save() + renderAll() itself rather than
   delegating to saveCard(). That is the scanner's existing handoff; it is NOT a
   new mutation and was not changed here.

   LOAD-TIME DEPENDENCIES: none. Seven declarations only - no camera access, no
   permission prompt, no /vision request, no DOM touch, no modal, no persistence.

   CALL-TIME DEPENDENCIES:
     core       esc, toast, newId, openModal, closeModal
     valuation  editionEligibility, bestPrice
     pricing    fetchLivePrices
     storage    save
     app        renderAll
     inline     collection, keys, EBAY_WORKER, and the #scan-* modal markup
     external   Worker /vision, pokemontcg.io card search
   ════════════════════════════════════════════════════════════════════════════ */

// ═══ CARD SCANNER ═══
let scanSelectedCard = null;
let scanCond = 'NM';
let scanEdition = 'unlimited';
let scanDetectedEdition = null;
let scanGrade = '';
let scanIsGraded = false;
// Map Claude Vision's free-form edition read to our canonical value.
function normalizeDetectedEdition(parsed){
  const raw = ((parsed && (parsed.edition||parsed.notes)) || '').toString().toLowerCase();
  if(/shadowless/.test(raw)) return 'shadowless';
  if(/1st|first\s*edition|1ed|1e\b/.test(raw)) return '1stEdition';
  if(/unlimited/.test(raw)) return 'unlimited';
  return null; // unknown — leave default
}
function setScanEdition(val){
  scanEdition = val;
  ['unlimited','1stEdition','shadowless'].forEach(e=>{
    const b=document.getElementById('scan-ed-'+e); if(b) b.classList.toggle('active', e===val);
  });
}

function setScanCond(val) {
  scanCond = val;
  ['NM','LP','MP','HP'].forEach(c => {
    document.getElementById('scan-cond-'+c).classList.toggle('active', c === val);
  });
}

function setScanGrade() {
  const grader = document.getElementById('scan-grader').value;
  const g = document.getElementById('scan-grade-sel').value;
  scanGrade = grader + ' ' + g;
  if (scanSelectedCard) scanSelectedCard.grade = scanGrade;
}

// ── Pre-process image: auto-rotate + normalise to JPEG ──
async function preprocessImage(file) {
  return new Promise(resolve => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      // Draw onto canvas at sensible max resolution (1200px long edge)
      const MAX = 1200;
      let w = img.naturalWidth, h = img.naturalHeight;
      if (Math.max(w,h) > MAX) {
        if (w > h) { h = Math.round(h * MAX/w); w = MAX; }
        else       { w = Math.round(w * MAX/h); h = MAX; }
      }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      // Return as JPEG base64 (strips EXIF rotation issues)
      resolve({ base64: canvas.toDataURL('image/jpeg', 0.92).split(',')[1], mediaType: 'image/jpeg' });
    };
    img.onerror = () => {
      // Fallback: use original
      const reader = new FileReader();
      reader.onload = ev => resolve({ base64: ev.target.result.split(',')[1], mediaType: file.type || 'image/jpeg' });
      reader.readAsDataURL(file);
    };
    img.src = url;
  });
}

async function callClaudeVision(base64, mediaType, loadingMsg) {
  document.getElementById('scan-loading-msg').textContent = loadingMsg || 'Identifying card…';
  const PROMPT = `You are a meticulous Pokémon TCG card identifier. Take your time and reason carefully — accuracy matters far more than speed.

The image may show either a RAW card or a card sealed in a GRADING SLAB (a hard plastic case with a printed label — PSA red label, BGS black/silver, CGC, SGC, or ACE). It may be rotated, tilted, dimly lit, or have glare off the plastic.

Work through these steps in order, reasoning about what you actually see at each one:

STEP 1 — SLAB OR RAW? Look for a hard plastic holder and a printed label bar (usually across the top). PSA = red label; BGS = black/silver with subgrades; CGC = blue/white; SGC = black tuxedo border; ACE = white. Holder + label ⇒ this is a GRADED slab.

STEP 2 — IF GRADED, READ THE LABEL FIRST. The label is the cleanest, most reliable text in the image — trust it over the card behind the plastic. From it extract: GRADER (PSA/BGS/CGC/SGC/ACE), GRADE number (e.g. 10, 9.5, 9), YEAR, SET name, CARD NAME, CARD NUMBER, and CERT number if visible. Vintage labels often read like "1999 POKEMON GAME" (= Base Set) or "JUNGLE 1ST EDITION". Set type = "graded".

STEP 3 — IF RAW (no holder): mentally correct rotation, then read the name from the top, the collector number/total from the bottom-right (e.g. "215/203"), and the set from the symbol/logo near the bottom.

STEP 4 — RARITY: from the symbol (circle=common, diamond=uncommon, star=rare, etc.) or the label.

STEP 5 — TYPE: standard, holo, reverse, ex (ex/GX/V/VMAX/VSTAR), or graded (if slabbed).

STEP 6 — EDITION (critical for vintage WOTC sets, Base Set→Neo Destiny, raw OR slabbed): a black "1st Edition" stamp on the lower-left artwork, or "1ST EDITION" on a slab label ⇒ "1st_edition". Base Set only, no drop-shadow on the art frame and no stamp ⇒ "shadowless". Otherwise ⇒ "unlimited". Modern cards (2003+) ⇒ "unlimited".

STEP 7 — CONDITION (raw cards only; for slabs leave "NM"): NM, LP, MP, or HP from visible wear.

Reason through the steps in a few short sentences. THEN, as the very last thing in your reply, output ONE flat JSON object on its own line (no markdown fences) with exactly these keys:
{"name":"","set":"","number":"collector number only e.g. 4 or 215","rarity":"","type":"standard|holo|reverse|ex|graded","graded":false,"grader":"","grade":"","cert":"","edition":"1st_edition|unlimited|shadowless","condition_estimate":"NM|LP|MP|HP","confidence":"high|medium|low","notes":""}

For a graded slab set "graded":true and fill grader/grade (and cert if seen). For a raw card set "graded":false and leave grader/grade/cert empty. If you truly cannot identify the card at all, make the last line exactly: {"error":"Cannot identify — please retake with better lighting"}`;

  const resp = await fetch(`${EBAY_WORKER}/vision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ base64, mediaType, prompt: PROMPT })
  });
  if (!resp.ok) throw new Error('Vision ' + resp.status);
  const respData = await resp.json();
  if (respData.error) throw new Error(respData.error);
  const text = (respData.text || '').trim();
  // The model reasons first, then emits one flat JSON object last — pull it out.
  const cleaned = text.replace(/```[a-z]*\n?/gi, '').replace(/```/g, '');
  const extractLastJson = (str) => {
    let end = str.lastIndexOf('}');
    while (end >= 0) {
      let depth = 0;
      for (let k = end; k >= 0; k--) {
        const ch = str[k];
        if (ch === '}') depth++;
        else if (ch === '{') {
          depth--;
          if (depth === 0) {
            try { return JSON.parse(str.slice(k, end + 1)); } catch (_) { break; }
          }
        }
      }
      end = str.lastIndexOf('}', end - 1);
    }
    return null;
  };
  let parsed = extractLastJson(cleaned);
  if (!parsed) {
    const lb = cleaned.lastIndexOf('{'), rb = cleaned.lastIndexOf('}');
    if (lb >= 0 && rb > lb) { try { parsed = JSON.parse(cleaned.slice(lb, rb + 1)); } catch (_) {} }
  }
  if (!parsed) throw new Error('No parseable JSON in vision response');
  return parsed;
}

async function scanCard(input) {
  const file = input.files[0]; if (!file) return;

  // Show preview immediately
  const previewURL = URL.createObjectURL(file);
  document.getElementById('scan-preview-img').src = previewURL;
  document.getElementById('scan-preview-wrap').style.display = '';
  document.getElementById('scan-loading').style.display = '';
  document.getElementById('scan-result').style.display = 'none';
  document.getElementById('scan-added').style.display = 'none';
  document.getElementById('scan-drop').style.display = 'none';
  document.getElementById('scan-matches').style.display = 'none';
  scanSelectedCard = null;
  window._scanMatches = null; window._scanParsed = null; _scanPriceToken++;

  try {
    // Step 1 — pre-process (normalise rotation & size)
    document.getElementById('scan-loading-msg').textContent = 'Processing image…';
    const { base64, mediaType } = await preprocessImage(file);

    // Step 2 — ask Claude to identify
    let parsed;
    try {
      parsed = await callClaudeVision(base64, mediaType, 'Reading card…');
    } catch(e) {
      // If JSON parse failed, try once more with a stricter prompt variant
      document.getElementById('scan-loading-msg').textContent = 'Retrying…';
      try {
        parsed = await callClaudeVision(base64, mediaType, 'Retrying identification…');
      } catch(e2) {
        showScanError('Could not read card — try better lighting or a closer shot.');
        return;
      }
    }

    if (parsed.error) { showScanError(parsed.error); return; }

    // Step 3 — apply condition suggestion
    if (parsed.condition_estimate) {
      const cond = parsed.condition_estimate.toUpperCase();
      if (['NM','LP','MP','HP'].includes(cond)) setScanCond(cond);
    }

    // Step 3b — capture detected edition (applied in showScanResultCard once the set is known)
    scanDetectedEdition = normalizeDetectedEdition(parsed);

    // Step 3c — capture graded slab info (grader + grade) read off the label
    scanIsGraded = (parsed.graded === true || parsed.type === 'graded');
    if (scanIsGraded) {
      const grader = ((parsed.grader || 'PSA').toString().toUpperCase().trim()) || 'PSA';
      let gnum = (parsed.grade || '').toString().trim();
      gnum = gnum.replace(/[^0-9.]/g, '') || (/auth/i.test(parsed.grade || '') ? 'AUTH' : '10');
      scanGrade = grader + ' ' + gnum;
    } else {
      scanGrade = '';
    }

    // Step 4 — show confidence badge if low
    if (parsed.confidence === 'low') {
      document.getElementById('scan-confidence-warn').style.display = '';
    } else {
      document.getElementById('scan-confidence-warn').style.display = 'none';
    }

    // Step 5 — look up on pokemontcg.io
    document.getElementById('scan-loading-msg').textContent = 'Looking up prices…';
    await searchAndShowMatches(parsed);

  } catch(e) {
    showScanError('Scan failed — ' + (e.message || 'check your connection'));
  }
}

async function searchAndShowMatches(parsed) {
  try {
    const rawName = (parsed.name || '').trim();
    const cleanName = rawName.replace(/[\u2018\u2019`]/g, "'");
    const looseName = rawName.replace(/[^A-Za-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
    const lastWord = looseName.split(' ').filter(Boolean).pop() || looseName;
    const ptcg = async (q) => {
      const r = await ptcgFetch(`/cards?q=${encodeURIComponent(q)}&orderBy=-set.releaseDate&pageSize=15`);
      const j = await r.json();
      return (j && j.data) || [];
    };
    let data = [];
    let q = `name:"${cleanName}"`;
    if (parsed.number) q += ` number:${parsed.number}`;
    if (parsed.set)    q += ` set.name:"${parsed.set}"`;
    data = await ptcg(q);
    if (!data.length) {
      let q2 = `name:*${looseName.replace(/ /g,'*')}*`;
      if (parsed.number) q2 += ` number:${parsed.number}`;
      data = await ptcg(q2);
    }
    if (!data.length && parsed.set) {
      data = await ptcg(`name:*${looseName.replace(/ /g,'*')}* set.name:"${parsed.set}"`);
    }
    if (!data.length && parsed.number) {
      data = await ptcg(`name:*${lastWord}* number:${parsed.number}`);
    }
    if (!data.length) {
      data = await ptcg(`name:"${cleanName}"`);
      if (!data.length) data = await ptcg(`name:*${lastWord}*`);
    }
    document.getElementById('scan-loading').style.display = 'none';
    if (!data.length) { showScanResultManual(parsed); return; }
    const j = { data };
    const scored = j.data.map(card => {
      let score = 0;
      if (parsed.number && card.number === parsed.number) score += 3;
      if (parsed.set && card.set?.name?.toLowerCase().includes(parsed.set.toLowerCase())) score += 2;
      if (card.name.toLowerCase() === parsed.name.toLowerCase()) score += 2;
      else if (card.name.toLowerCase().includes(lastWord.toLowerCase())) score += 1;
      return { card, score };
    });
    scored.sort((a,b) => b.score - a.score);
    const sorted = scored.map(x => x.card);
    if (sorted.length === 1 || scored[0].score >= 5) {
      showScanResultCard(sorted[0], parsed);
    } else {
      showScanMatches(sorted, parsed);
    }
  } catch(e) {
    // Genuine failures only (network / API shape). Both renderers now exist, so a
    // successful catalogue match no longer lands here. Logged, never swallowed.
    console.warn('[scanner] match rendering failed — falling back to manual entry:', e);
    document.getElementById('scan-loading').style.display = 'none';
    showScanResultManual(parsed);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// ── SCANNER RESULT RENDERERS (2026-08) ──
// showScanResultCard() and showScanMatches() were called by searchAndShowMatches()
// but did not exist anywhere in the file: EVERY successful catalogue match threw a
// ReferenceError into the surrounding catch and silently degraded to the manual
// form, so the scanner never actually used its own lookup. Implemented here against
// the contract the rest of the scanner already assumes:
//   • scanSelectedCard must be {id,name,set,num,img,cardId,type,rarity} — the shape
//     showScanResultManual() builds and addScannedCard() spreads.
//   • the #scan-result strip (img/name/meta/price) is the single result surface.
//   • #scan-matches / #scan-matches-list is the multi-candidate surface (markup
//     already existed, unused).
// Nothing is fabricated: no invented confidence, no placeholder price, no guessed
// set. Everything shown comes from the pokemontcg.io record or the vision read.
// ════════════════════════════════════════════════════════════════════════════

// Guards against a slow price fetch for match A landing after the user picks match B.
let _scanPriceToken = 0;

// pokemontcg.io record → the card shape this app uses internally.
function scanCardFromApi(apiCard, parsed){
  const RAW_TYPES = ['standard','holo','reverse','ex'];
  const visionType = (parsed && parsed.type || '').toString().toLowerCase();
  const card = {
    id:     '',                                     // real id assigned by addScannedCard()
    name:   apiCard.name || (parsed && parsed.name) || '',
    set:    (apiCard.set && apiCard.set.name) || (parsed && parsed.set) || '',
    num:    apiCard.number || (parsed && parsed.number) || '',
    img:    (apiCard.images && (apiCard.images.small || apiCard.images.large)) || '',
    cardId: apiCard.id || '',
    type:   scanIsGraded ? 'graded' : (RAW_TYPES.includes(visionType) ? visionType : 'standard'),
    rarity: apiCard.rarity || (parsed && parsed.rarity) || ''
  };
  if (scanIsGraded) {
    // The grade was read off the slab label in scanCard(); carry it onto the record
    // so addScannedCard() produces a real graded holding instead of a bare type flag.
    if (scanGrade) card.grade = scanGrade;
    const cert = (parsed && parsed.cert || '').toString().trim();
    if (cert) card.cert = cert;
  }
  return card;
}

// Reflect the label-read grade into the grade selects, then re-read them so
// scanGrade and the UI can never disagree (an unknown grade leaves the default).
function applyScanGradeToSelects(){
  const m = (scanGrade || '').match(/^(\S+)\s+(.+)$/);
  const graderSel = document.getElementById('scan-grader');
  const gradeSel  = document.getElementById('scan-grade-sel');
  if (m && graderSel && gradeSel) {
    const hasOpt = (sel, v) => Array.from(sel.options).some(o => o.value === v);
    if (hasOpt(graderSel, m[1])) graderSel.value = m[1];
    if (hasOpt(gradeSel,  m[2])) gradeSel.value  = m[2];
  }
  if (graderSel && gradeSel) setScanGrade();   // canonicalise scanGrade from the UI
}

// Show/hide the condition vs grade rows and the edition row for the chosen card.
function applyScanCardOptions(card){
  const gradeRow = document.getElementById('scan-grade-row');
  const condRow  = document.getElementById('scan-cond-row');
  const gradeHint= document.getElementById('scan-grade-hint');
  if (scanIsGraded) {
    if (gradeRow) gradeRow.style.display = '';
    if (condRow)  condRow.style.display  = 'none';
    if (gradeHint) gradeHint.textContent = scanGrade ? '· read from slab label' : '';
    applyScanGradeToSelects();
    if (scanSelectedCard) scanSelectedCard.grade = scanGrade;
  } else {
    if (gradeRow) gradeRow.style.display = 'none';
    if (condRow)  condRow.style.display  = '';
    if (gradeHint) gradeHint.textContent = '';
  }

  // Edition is only offered for sets that actually have editions (WOTC-era).
  const row  = document.getElementById('scan-edition-row');
  const hint = document.getElementById('scan-edition-hint');
  const shadowlessPill = document.getElementById('scan-ed-shadowless');
  const el = editionEligibility({ cardId: card.cardId, set: card.set, type: card.type });
  if (el.eligible) {
    if (row) row.style.display = '';
    if (shadowlessPill) shadowlessPill.style.display = el.shadowless ? '' : 'none';
    let pick = 'unlimited';
    if (scanDetectedEdition === 'shadowless' && el.shadowless) pick = 'shadowless';
    else if (scanDetectedEdition === '1stEdition')             pick = '1stEdition';
    else if (scanDetectedEdition === 'unlimited')              pick = 'unlimited';
    setScanEdition(pick);
    if (hint) hint.textContent = scanDetectedEdition ? '· detected from image — verify' : '';
  } else {
    if (row) row.style.display = 'none';
    if (hint) hint.textContent = '';
    setScanEdition('unlimited');
  }
}

// Live price for the identified card. Uses fetchLivePrices directly (as the
// watchlist does) rather than getPrices(), so a not-yet-owned probe never writes
// into pcache or cardHistory under a throwaway id.
async function loadScanPrice(card){
  const token = ++_scanPriceToken;
  const el = document.getElementById('scan-result-price');
  if (el) el.textContent = 'Checking price…';
  try{
    const data = await fetchLivePrices({
      id: 'scan_' + (card.cardId || card.name || 'x'),
      name: card.name, cardId: card.cardId, set: card.set, num: card.num,
      type: card.type, grade: card.grade || '', cond: scanCond || 'NM',
      edition: scanEdition || 'unlimited', img: card.img || null
    });
    if (token !== _scanPriceToken) return;                     // superseded by another pick
    const bp = bestPrice(data, card.type === 'graded');
    if (el) el.textContent = (isFinite(bp) && bp > 0) ? '$' + bp.toFixed(2) : 'No price found';
    if (!card.img && data && data.img) {
      card.img = data.img;
      const imgEl = document.getElementById('scan-result-img');
      if (imgEl) imgEl.innerHTML = `<img src="${esc(data.img)}" alt="${esc(card.name)}" style="width:100%;height:100%;object-fit:cover;">`;
    }
  }catch(e){
    if (token !== _scanPriceToken) return;
    console.warn('[scanner] price lookup failed:', e && e.message);
    if (el) el.textContent = 'Price unavailable';             // honest — never a fake number
  }
}

// SINGLE CONFIDENT MATCH — fill the result strip and arm "Add to Vault".
function showScanResultCard(apiCard, parsed, opts){
  if (!apiCard) { showScanResultManual(parsed || {}); return; }
  opts = opts || {};
  const card = scanCardFromApi(apiCard, parsed);
  scanSelectedCard = card;

  const imgEl = document.getElementById('scan-result-img');
  if (imgEl) imgEl.innerHTML = card.img
    ? `<img src="${esc(card.img)}" alt="${esc(card.name)}" style="width:100%;height:100%;object-fit:cover;">`
    : '⟡';
  document.getElementById('scan-result-name').textContent = card.name;
  document.getElementById('scan-result-meta').textContent =
    [card.set, card.num ? '#' + card.num : '', card.rarity, scanIsGraded ? (scanGrade || 'Graded') : '']
      .filter(Boolean).join(' · ');
  document.getElementById('scan-result-price').textContent = '';

  applyScanCardOptions(card);

  // Keep the candidate list on screen when the user picked from it, so they can
  // change their mind; hide it on a direct single-match result.
  const matches = document.getElementById('scan-matches');
  if (matches && !opts.keepMatches) matches.style.display = 'none';

  document.getElementById('scan-loading').style.display = 'none';
  document.getElementById('scan-result').style.display = '';
  loadScanPrice(card);
}

// MULTIPLE CANDIDATES — the user must pick before anything can be added.
function showScanMatches(cards, parsed){
  const list = document.getElementById('scan-matches-list');
  const wrap = document.getElementById('scan-matches');
  if (!list || !wrap || !Array.isArray(cards) || !cards.length) { showScanResultManual(parsed || {}); return; }

  // Nothing is selected yet — addScannedCard() already refuses on a null selection.
  scanSelectedCard = null;
  window._scanMatches = cards;
  window._scanParsed  = parsed || null;   // scanPickMatch() forwards this on selection

  list.innerHTML = cards.slice(0, 12).map((c, i) => {
    const img = (c.images && c.images.small) || '';
    return `<div class="sd-item" id="scan-match-${i}" onclick="scanPickMatch(${i})">
      ${img ? `<img class="sd-thumb" src="${esc(img)}" alt="${esc(c.name || '')}" loading="lazy">` : '<div class="sd-ph">⟡</div>'}
      <div style="min-width:0;flex:1;">
        <div class="sd-name">${esc(c.name || '')}</div>
        <div class="sd-meta">${esc((c.set && c.set.name) || '')}${c.number ? ' · #' + esc(c.number) : ''}${c.rarity ? ' · ' + esc(c.rarity) : ''}</div>
      </div>
      <div class="sd-price"><div class="sd-plbl">Select</div></div>
    </div>`;
  }).join('');
  wrap.style.display = '';

  // Result strip shows what the image was read as, clearly marked as unconfirmed.
  const imgEl = document.getElementById('scan-result-img');
  if (imgEl) imgEl.innerHTML = '⟡';
  document.getElementById('scan-result-name').textContent = (parsed && parsed.name) || 'Pick the matching card';
  document.getElementById('scan-result-meta').textContent = `${cards.length} possible matches — choose one below`;
  document.getElementById('scan-result-price').textContent = '';

  document.getElementById('scan-loading').style.display = 'none';
  document.getElementById('scan-result').style.display = '';
}

function scanPickMatch(idx){
  const cards = window._scanMatches || [];
  const chosen = cards[idx];
  if (!chosen) return;
  document.querySelectorAll('#scan-matches-list .sd-item').forEach((el, i) => {
    el.style.background = (i === idx) ? 'var(--bg4)' : '';
  });
  showScanResultCard(chosen, window._scanParsed, { keepMatches: true });
}

function showScanResultManual(parsed) {
  // AI identified but no API match — pre-fill what we know
  parsed = parsed || {};
  scanSelectedCard = { id: newId('c'), name: parsed.name || '', set: parsed.set || '', num: parsed.number || '', img: '', cardId: '', type: scanIsGraded ? 'graded' : (parsed.type || 'standard'), rarity: parsed.rarity || '' };
  // Carry the slab read through on this path too — previously a scanned PSA slab
  // was added as type:'graded' with NO grade and NO cert, which made it unpriceable
  // by the graded engine and blank on the PSA tiles.
  if (scanIsGraded) {
    if (scanGrade) scanSelectedCard.grade = scanGrade;
    const cert = (parsed.cert || '').toString().trim();
    if (cert) scanSelectedCard.cert = cert;
  }
  document.getElementById('scan-result-img').innerHTML = '⟡';
  document.getElementById('scan-result-name').textContent = parsed.name || 'Unidentified card';
  document.getElementById('scan-result-meta').textContent = [parsed.set, parsed.number ? '#' + parsed.number : '', parsed.rarity].filter(Boolean).join(' · ') || 'No API match — verify manually';
  document.getElementById('scan-result-price').textContent = '';
  document.getElementById('scan-matches').style.display = 'none';
  applyScanCardOptions(scanSelectedCard);
  document.getElementById('scan-loading').style.display = 'none';
  document.getElementById('scan-result').style.display = '';
}

function showScanError(msg) {
  document.getElementById('scan-loading').style.display = 'none';
  document.getElementById('scan-result').style.display = '';
  document.getElementById('scan-result-img').innerHTML = '❌';
  document.getElementById('scan-result-name').textContent = 'Could not identify card';
  document.getElementById('scan-result-meta').textContent = msg;
  document.getElementById('scan-result-price').textContent = '';
  document.getElementById('scan-matches').style.display = 'none';
}

function addScannedCard() {
  // Null when several candidates are showing and none has been picked — the honest
  // state, not a silent guess at the top match.
  if (!scanSelectedCard) { toast('Pick the matching card first', 'red'); return; }
  const paid = document.getElementById('scan-paid').value;
  const qty  = parseInt(document.getElementById('scan-qty').value) || 1;
  const card = {
    ...scanSelectedCard,
    id:   newId('c'),
    cond:  scanCond,
    edition: scanEdition,
    qty,
    paid,
    notes: 'Added via Card Scanner',
    added: new Date().toISOString(),
  };
  // Mirror saveCard()'s invariant: a record carrying a grade or cert IS a graded
  // holding, so the graded pricing engine and the PSA views classify it correctly.
  if ((card.grade && String(card.grade).trim()) || (card.cert && String(card.cert).trim())) card.type = 'graded';
  collection.push(card);
  save();
  renderAll();
  // Show confirmation
  document.getElementById('scan-result').style.display = 'none';
  document.getElementById('scan-preview-wrap').style.display = 'none';
  document.getElementById('scan-added-name').textContent = card.name;
  document.getElementById('scan-added').style.display = '';
  toast(card.name + ' added to vault', 'green');
}

function resetScanner() {
  scanSelectedCard = null; scanCond = 'NM'; scanEdition = 'unlimited'; scanDetectedEdition = null; scanGrade = ''; scanIsGraded = false;
  // Candidate-list state from a previous scan must not leak into the next one.
  window._scanMatches = null; window._scanParsed = null; _scanPriceToken++;
  const _ml = document.getElementById('scan-matches-list'); if (_ml) _ml.innerHTML = '';
  ['scan-loading','scan-result','scan-preview-wrap','scan-added','scan-edition-row','scan-grade-row','scan-matches','scan-confidence-warn'].forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; });
  const ccr = document.getElementById('scan-cond-row'); if (ccr) ccr.style.display = '';
  document.getElementById('scan-drop').style.display = '';
  document.getElementById('scan-file').value = '';
  document.getElementById('scan-paid').value = '';
  document.getElementById('scan-qty').value = '1';
  setScanCond('NM'); setScanEdition('unlimited');
}
