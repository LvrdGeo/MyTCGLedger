/* ════════════════════════════════════════════════════════════════════════════
   MyTCG Ledger V6 - settings.js
   ────────────────────────────────────────────────────────────────────────────
   DOMAIN MODULE (settings screen). API keys, NRV preferences, connection status
   and the duplicate-cleanup action - the Settings page's own behaviour.

   OWNS: loadKeys, saveKey, loadNrvForm, saveNrvForm, toggleNrvShown,
         updateStatusDots, cleanupDuplicatesUI.

   DOES NOT OWN: the `keys` / `prefs` / `NRV` state itself (app-state.js and
   valuation.js), the identity engine (cleanupDuplicatesUI CALLS
   runDuplicateCleanup and then persists + redraws - the long-standing contract
   from Batch 4 that identity returns `changed` and the CALLER saves), storage,
   sync, or any renderer it merely triggers.

   LOAD-TIME EXECUTION: none. Function declarations only.

   CALL-TIME DEPENDENCIES: core (toast, showConfirm), app-state (keys, prefs),
   valuation (NRV settings), identity (runDuplicateCleanup), storage (save),
   app (renderAll).
   ════════════════════════════════════════════════════════════════════════════ */

function loadKeys(){document.getElementById('k-ptcg').value=keys.ptcg||'';document.getElementById('k-ppt').value=keys.ppt||'';document.getElementById('k-psa').value=keys.psa||'';}

function saveKey(k){keys[k]=document.getElementById('k-'+k).value.trim();localStorage.setItem(STORAGE_KEYS.keys,JSON.stringify(keys));updateStatusDots();toast('Key saved','green');}

// ── NRV settings form (Settings → Realizable Value) ──
function loadNrvForm(){
  const g=id=>document.getElementById(id); if(!g('nrv-discount'))return;
  g('nrv-shown').checked       = !!NRV.shown;
  g('nrv-discount').value      = Math.round((NRV.discount||0)*100);
  g('nrv-fee').value           = +(((NRV.feePct!=null?NRV.feePct:0.136)*100).toFixed(2));
  g('nrv-ship-standard').value = NRV.shipping.standard;
  g('nrv-ship-graded').value   = NRV.shipping.graded;
  g('nrv-ship-sealed').value   = NRV.shipping.sealed;
  g('nrv-tax-on').checked      = !!NRV.taxEnabled;
  g('nrv-tax-pct').value       = Math.round((NRV.taxPct||0)*100);
}

function saveNrvForm(){
  const g=id=>document.getElementById(id); if(!g('nrv-discount'))return;
  const n=(id,d)=>{const v=parseFloat(g(id).value); return isFinite(v)?v:d;};
  NRV.shown             = g('nrv-shown').checked;
  NRV.discount          = Math.min(Math.max(n('nrv-discount',5)/100,0),0.95);
  NRV.feePct            = Math.min(Math.max(n('nrv-fee',13.6)/100,0),0.5);
  NRV.shipping.standard = Math.max(n('nrv-ship-standard',1.5),0);
  NRV.shipping.graded   = Math.max(n('nrv-ship-graded',6),0);
  NRV.shipping.sealed   = Math.max(n('nrv-ship-sealed',18),0);
  NRV.taxEnabled        = g('nrv-tax-on').checked;
  NRV.taxPct            = Math.min(Math.max(n('nrv-tax-pct',28)/100,0),0.6);
  saveNrvSettings();
  if(document.querySelector('.page.active')?.id==='page-portfolio') renderPortfolio();
}

function toggleNrvShown(){
  NRV.shown=!NRV.shown; saveNrvSettings();
  const f=document.getElementById('nrv-shown'); if(f)f.checked=NRV.shown;
  if(document.querySelector('.page.active')?.id==='page-portfolio') renderPortfolio();
}

function updateStatusDots(){document.getElementById('s1').className='dot '+(keys.ptcg?'dot-on':'dot-warn');document.getElementById('s2').className='dot '+(keys.ppt?'dot-on':'dot-off');document.getElementById('s3').className='dot '+(keys.psa?'dot-on':'dot-off');}

function cleanupDuplicatesUI(){
  let r;
  try { r = runDuplicateCleanup({ dryRun:true }); }
  catch(e){ toast('Duplicate scan failed','red'); return; }
  if(!r || r.groups===0){ toast('No duplicates found','green'); return; }
  const msg = `Found ${r.groups} duplicate group${r.groups>1?'s':''} (${r.retired} extra record${r.retired>1?'s':''}). `
    + `This merges each into one card — keeping cost basis and the best price — and removes the duplicate${r.retired>1?'s':''}. `
    + `Portfolio: ${money(r.before)} → ${money(r.after)} (minus ${money(r.removed)}). Proceed?`;
  showConfirm('Clean up duplicates', msg, () => {
    const res = runDuplicateCleanup();
    // The UI owns persistence + redraw; identity just reports what it changed.
    if (res.changed) { save(); renderAll(); }
    toast(`Merged ${res.retired} duplicate${res.retired>1?'s':''}`,'green');
  });
}
