/* ════════════════════════════════════════════════════════════════════════════
   MyTCG Ledger V6 — state.js
   ────────────────────────────────────────────────────────────────────────────
   LAYER 3 (STATE). Depends on core.js and valuation.js only.

   OWNS:
     · AppState            the single source of truth for calculated portfolio
                           values. Every renderer READS from it; none recalculate.
     · PAGE_RENDERERS      page id -> redraw function
     · registerPageRenderer(id, fn)

   ARCHITECTURAL INVARIANT — the dependency points UI -> STATE, never the reverse.
   AppState.renderActive() dispatches through PAGE_RENDERERS and must NEVER name a
   specific renderer. The UI registers itself later via registerPageRenderers()
   (plural), which lives with the renderers in the main block, NOT in this file.
   An unregistered page is a silent no-op, not a ReferenceError.

   OUTBOUND DEPENDENCIES:
     · valuation.js — cardValue · itemQty · sealedEffectiveValue
     · two app-state globals read AT CALL TIME only, never at load:
         `collection` and `sealed`, declared in the main inline block which loads
         AFTER this file. update() is wrapped in try/catch, so an early call
         logs rather than throws. When storage.js is extracted these become
         ordinary cross-file globals.

   LOAD-TIME EXECUTION: one expression only — the initial cashPosition read from
   localStorage in the object literal. It needs nothing but localStorage, so this
   file is safe to load immediately after valuation.js. It runs BEFORE the schema
   guard in the main block, exactly as it did inline (the guard does not touch
   pkv2_cash, so the relative order is behaviourally irrelevant either way).
   ════════════════════════════════════════════════════════════════════════════ */

// ═══════════════════════════════════════════════════════════
// ── CENTRAL STATE ENGINE ──
// Single source of truth for all calculated portfolio values.
// Call AppState.update() after any data change.
// All render functions read from AppState — never recalculate.
// ═══════════════════════════════════════════════════════════
const AppState = {
  // Portfolio values
  totalValue:    0,
  totalCost:     0,
  totalPnL:      0,
  totalPnLPct:   0,
  cashPosition:  parseFloat(localStorage.getItem('pkv2_cash') || '0'),

  // Inventory counts
  singlesCount:  0,
  slabsCount:    0,
  sealedCount:   0,
  addedThisMonth:0,

  // Top performers
  bestCard:      null,   // { card, gain }
  worstCard:     null,   // { card, gain }

  // Breakdown
  concentration: [],     // [{ name, val, pct }]
  movers:        [],     // [{ card, bp, gain, pct }]

  // Meta
  lastUpdated:   null,
  _dirty:        true,   // needs recalculation

  // ── Update all calculated values from raw data ──
  update() {
    try {
      let totalVal = 0, totalPaid = 0;
      let bestGain = -Infinity, bestCard = null;
      let worstGain = Infinity, worstCard = null;
      const concentrationMap = {};
      const movers = [];

      collection.forEach(card => {
        // Live pcache wins; else the synced lastMarketValue baseline, so a freshly
        // synced device shows a non-zero total before running its own live refresh.
        const bp   = cardValue(card);
        const paid = parseFloat(card.paid || 0);
        const qty  = itemQty(card);

        if (bp > 0) {
          totalVal += bp * qty;
          concentrationMap[card.name] = (concentrationMap[card.name] || 0) + bp * qty;
        }
        if (paid > 0) totalPaid += paid * qty;

        if (bp > 0 && paid > 0) {
          const gain = (bp - paid) * qty;
          if (gain > bestGain)  { bestGain = gain;  bestCard = { card, gain, bp }; }
          if (gain < worstGain) { worstGain = gain; worstCard = { card, gain, bp }; }
          movers.push({ card, bp, gain, pct: ((gain/paid)*100).toFixed(1) });
        }
      });

      sealed.forEach(s => {
        const v = sealedEffectiveValue(s);
        const p = parseFloat(s.paid || 0);
        const q = itemQty(s);
        if (v > 0) {
          totalVal  += v * q;
          concentrationMap[s.name] = (concentrationMap[s.name] || 0) + v * q;
        }
        if (p > 0) totalPaid += p * q;
      });

      const pnl    = totalPaid > 0 ? totalVal - totalPaid : null;
      const pnlPct = pnl != null && totalPaid > 0 ? ((pnl/totalPaid)*100) : null;

      // Inventory counts
      const now   = new Date();
      const month = now.getMonth();
      const year  = now.getFullYear();

      // Concentration — top 5 + other
      const concRows = Object.entries(concentrationMap)
        .sort((a,b) => b[1]-a[1])
        .map(([name,val]) => ({ name, val, pct: totalVal>0?((val/totalVal)*100).toFixed(1):0 }));
      const top5  = concRows.slice(0,5);
      const other = concRows.slice(5).reduce((s,r)=>s+r.val,0);
      if (other > 0) top5.push({ name:'Other', val:other, pct:totalVal>0?((other/totalVal)*100).toFixed(1):0 });

      // Write to state
      this.totalValue     = totalVal;
      this.totalCost      = totalPaid;
      this.totalPnL       = pnl;
      this.totalPnLPct    = pnlPct;
      this.cashPosition   = parseFloat(localStorage.getItem('pkv2_cash') || '0');
      this.singlesCount   = collection.filter(c=>c.type!=='graded'&&c.type!=='sealed').reduce((s,c)=>s+itemQty(c),0);
      this.slabsCount     = collection.filter(c=>c.type==='graded').reduce((s,c)=>s+itemQty(c),0);
      this.sealedCount    = sealed.length;
      this.addedThisMonth = collection.filter(c=>{
        if(!c.added)return false;
        const d=new Date(c.added);
        return d.getMonth()===month&&d.getFullYear()===year;
      }).length;
      this.bestCard       = bestCard;
      this.worstCard      = worstCard;
      this.concentration  = top5;
      this.movers         = movers.sort((a,b)=>Math.abs(b.gain)-Math.abs(a.gain)).slice(0,5);
      this.lastUpdated    = new Date();
      this._dirty         = false;

    } catch(err) {
      console.error('[AppState] Update failed:', err);
    }
  },

  // ── Mark dirty and trigger a debounced re-render ──
  invalidate() {
    this._dirty = true;
    clearTimeout(this._renderTimer);
    this._renderTimer = setTimeout(() => {
      if (this._dirty) {
        this.update();
        AppState.renderActive();
      }
    }, 100);
  },

  // ── Render only the currently visible page ──
  // ARCHITECTURAL INVARIANT: AppState must not name individual renderers.
  // This used to hard-code eight `if (active === 'page-x') renderX()` branches,
  // which made the state layer depend on every UI subsystem — the one dependency
  // edge that would block extracting core/state into its own file. Renderers now
  // register themselves (see PAGE_RENDERERS below); AppState only dispatches.
  renderActive() {
    try {
      const active = document.querySelector('.page.active')?.id;
      const fn = active && PAGE_RENDERERS[active];
      if (typeof fn === 'function') fn();
    } catch(err) {
      console.error('[AppState] renderActive failed:', err);
    }
  }
};

// ════════════════════════════════════════════════════════════════════════════
// ── PAGE RENDERER REGISTRY ──
// page id → the function that redraws it. The ONLY coupling point between the
// state layer and the UI layer, and it points UI → core (registration), not
// core → UI (hard-coded calls). Registration happens at the bottom of the file,
// after every renderer is declared, so extraction order is: core first, UI last.
// Adding a page means adding one line to registerPageRenderers(), not editing
// AppState. Entries are looked up lazily, so a missing renderer is a no-op
// rather than a ReferenceError that breaks the whole update cycle.
// ════════════════════════════════════════════════════════════════════════════
const PAGE_RENDERERS = {};
function registerPageRenderer(pageId, fn){
  if (typeof fn === 'function') PAGE_RENDERERS[pageId] = fn;
}
