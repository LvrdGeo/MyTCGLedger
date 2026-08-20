/* ════════════════════════════════════════════════════════════════════════════
   MyTCG Ledger V6 - auth.js
   ────────────────────────────────────────────────────────────────────────────
   DOMAIN MODULE (identity / account). Deferred since BATCH 7, where sync.js was
   extracted and auth was deliberately left inline so that sync could read
   supa/currentUser per call without owning them. That reasoning still holds -
   this batch simply gives auth its own file without changing the relationship.

   LOGIN IS OPTIONAL. The app works fully offline and signed out; every consumer
   guards on supa/currentUser being null. Nothing here is required for the app
   to run.

   OWNS:
     - identity state  supa, currentUser, _authMode
     - lifecycle       initAuth (client creation, session restore,
                       onAuthStateChange), cleanAuthUrl
     - auth modal      openAuthModal, authToggleMode, applyAuthMode
     - credentials     authSubmit (email sign-in / sign-up), authGoogle (OAuth),
                       authSignOut
     - account UI      syncBadge, updateAuthUI, renderAccountSection

   THE BATCH 7 EDGE, NOW EXPLICIT AND UNCHANGED: sync.js's setSyncStatus() calls
   renderAccountSection() and updateAuthUI(); syncBadge() reads sync's
   _syncState/_syncPending. That mutual, call-time relationship was documented in
   Batch 7 as the reason account UI stayed with auth rather than moving into
   sync. It is preserved verbatim - not rewired, not guarded, not inverted.
   Direction: sync -> auth for the status UI, auth -> sync for syncReconcile()
   on sign-in. Neither resolves at load.

   DOES NOT OWN: the sync engine (sync.js), Supabase Storage uploads (sealed.js
   owns the sealed-images bucket), the analytics dbWrite guard (analytics.js),
   API keys (`keys` stays inline - it is read by pricing, search and the JP
   catalogue, not by auth), persistence, or any domain state. It mutates NO
   collection, sealed, wishlist, deals, soldHistory, pcache or ledger.

   CONSUMERS (all call-time): sync.js reads supa/currentUser on every push/pull
   and calls the two UI functions; analytics.js's dbWrite guards on both;
   sealed.js's photo upload uses supa.storage; inline init() calls initAuth();
   goPage/refreshCurrentPage refresh the account UI; inline HTML drives the modal.

   LOAD-TIME EXECUTION: three declarations (supa = null, currentUser = null,
   _authMode = 'signin'). No client is created, no session is fetched, no
   network call and no DOM write happen until init() calls initAuth().
   ════════════════════════════════════════════════════════════════════════════ */

// ══════════════════════════════════════════════════════════
// STAGE 1 — AUTHENTICATION (Supabase)
// Login is OPTIONAL. The app works fully offline / signed out.
// This stage only establishes identity — no data syncs yet.
// ══════════════════════════════════════════════════════════
let supa = null;
let currentUser = null;
let _authMode = 'signin'; // 'signin' | 'signup'

function initAuth() {
  try {
    if (!window.supabase || !window.SUPABASE_URL) { console.warn('[Auth] Supabase not loaded'); return; }
    // Explicit auth options so the email-confirmation redirect is handled reliably.
    supa = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY, {
      auth: {
        detectSessionInUrl: true,   // parse the token in the URL after email-confirm redirect
        persistSession: true,       // keep the session across refreshes/app reopens
        autoRefreshToken: true,     // keep the session alive
        flowType: 'pkce'            // modern, secure confirmation flow
      }
    });

    // Restore existing session if present (already-logged-in users)
    supa.auth.getSession().then(({ data }) => {
      currentUser = data?.session?.user || null;
      renderAccountSection();
      updateAuthUI();
      // If we just arrived from an email-confirmation/login redirect, clean the URL
      // so a refresh doesn't try to re-process a one-time token.
      if (currentUser && (location.hash.includes('access_token') || location.search.includes('code='))) {
        cleanAuthUrl();
        toast('Signed in as ' + (currentUser.email || 'your account'), 'green');
      }
      // If already signed in on app open, reconcile cloud ↔ local
      if (currentUser) syncReconcile();
    });

    // React to login/logout/confirmation in real time
    supa.auth.onAuthStateChange((event, session) => {
      currentUser = session?.user || null;
      renderAccountSection();
      updateAuthUI();
      if (event === 'SIGNED_IN') {
        if (location.hash.includes('access_token') || location.search.includes('code=')) {
          cleanAuthUrl();
          const m = document.getElementById('auth-modal');
          if (m && m.classList.contains('open')) closeModal('auth-modal');
          toast('Account confirmed — you are signed in', 'green');
        }
        // Pull cloud + merge local on every sign-in
        syncReconcile();
      }
    });
  } catch (e) { console.error('[Auth] init failed', e); }
}

// Remove auth tokens from the address bar after they're processed (cosmetic + safety)
function cleanAuthUrl() {
  try {
    const clean = location.origin + location.pathname;
    history.replaceState(null, '', clean);
  } catch (e) { /* non-critical */ }
}

function openAuthModal() {
  _authMode = 'signin';
  applyAuthMode();
  document.getElementById('auth-error').textContent = '';
  document.getElementById('auth-email').value = '';
  document.getElementById('auth-pass').value = '';
  openModal('auth-modal');
}

function authToggleMode() {
  _authMode = (_authMode === 'signin') ? 'signup' : 'signin';
  applyAuthMode();
}

function applyAuthMode() {
  const signup = _authMode === 'signup';
  document.getElementById('auth-title').textContent       = signup ? 'Create Account' : 'Sign In';
  document.getElementById('auth-submit').textContent      = signup ? 'Create Account' : 'Sign In';
  document.getElementById('auth-toggle-text').textContent = signup ? 'Already have an account?' : "Don't have an account?";
  document.getElementById('auth-toggle-link').textContent = signup ? 'Sign in' : 'Sign up';
  document.getElementById('auth-error').textContent = '';
}

async function authSubmit() {
  const email = document.getElementById('auth-email').value.trim();
  const pass  = document.getElementById('auth-pass').value;
  const errEl = document.getElementById('auth-error');
  const btn   = document.getElementById('auth-submit');
  errEl.textContent = '';
  if (!email || !pass) { errEl.textContent = 'Email and password required.'; return; }
  if (!supa) { errEl.textContent = 'Auth not ready — try again in a moment.'; return; }

  btn.disabled = true; const orig = btn.textContent; btn.textContent = 'Please wait…';
  try {
    let result;
    if (_authMode === 'signup') {
      result = await supa.auth.signUp({ email, password: pass, options: { emailRedirectTo: location.origin + location.pathname } });
      if (result.error) throw result.error;
      if (!result.data.session) {
        errEl.style.color = 'var(--green)';
        errEl.textContent = '✓ Account created! Check your email and click the confirmation link — it brings you right back here, signed in.';
        btn.disabled = false; btn.textContent = orig;
        return;
      }
    } else {
      result = await supa.auth.signInWithPassword({ email, password: pass });
      if (result.error) throw result.error;
    }
    currentUser = result.data.user;
    closeModal('auth-modal');
    toast('Signed in as ' + email, 'green');
  } catch (e) {
    errEl.style.color = 'var(--red)';
    errEl.textContent = e.message || 'Authentication failed.';
  } finally {
    btn.disabled = false; btn.textContent = orig;
  }
}

async function authGoogle() {
  if (!supa) { toast('Auth not ready', 'red'); return; }
  try {
    const { error } = await supa.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.href }
    });
    if (error) throw error;
    // Browser redirects to Google; session resolves on return.
  } catch (e) {
    document.getElementById('auth-error').textContent = e.message || 'Google sign-in unavailable.';
  }
}

async function authSignOut() {
  if (!supa) return;
  try { await supa.auth.signOut(); currentUser = null; _syncReconciled = false; toast('Signed out', 'gold'); }
  catch (e) { console.error('[Auth] signout', e); }
}

// Reflect auth state in the sidebar status + account section
// Pure, read-only: derives the always-visible sync badge from existing signals.
// Reads currentUser / navigator.onLine / _syncPending / _syncState — writes nothing.
function syncBadge(){
  if (!currentUser)      return { c:'var(--muted2)', t:'Local only' };
  if (_syncPending)      return { c:'var(--gold)',   t:'Pending changes' };
  if (!navigator.onLine) return { c:'var(--gold)',   t:'Offline' };
  switch (_syncState){
    case 'syncing': return { c:'var(--gold)',  t:'Syncing…' };
    case 'error':   return { c:'var(--red)',   t:'Sync failed' };
    case 'synced':  return { c:'var(--green)', t:'Synced' };
    default:        return { c:'var(--green)', t:'Synced' };   // idle / connected steady state
  }
}

function updateAuthUI() {
  const el = document.getElementById('auth-status-pill');
  if (el) {
    if (currentUser) {
      const b = syncBadge();
      el.innerHTML = '<span style="width:6px;height:6px;border-radius:50%;background:'+b.c+';display:inline-block;"></span> ' +
        b.t + ' · ' + (currentUser.email || 'Signed in');
    } else {
      el.innerHTML = '<span style="width:6px;height:6px;border-radius:50%;background:var(--muted2);display:inline-block;"></span> Local only · <a href="#" onclick="openAuthModal();return false;" style="color:var(--gold);text-decoration:none;">Sign in</a>';
    }
  }
}

function renderAccountSection() {
  const box = document.getElementById('account-section');
  if (!box) return;
  if (currentUser) {
    const syncMap = {
      idle:    { c:'var(--muted2)', t:'Connected' },
      syncing: { c:'var(--gold)',   t:'Syncing…' },
      synced:  { c:'var(--green)',  t:'✓ Synced to cloud' },
      offline: { c:'var(--gold)',   t:'Offline · will sync when online' },
      error:   { c:'var(--red)',    t:'Sync error · will retry' }
    };
    const s = syncMap[_syncState] || syncMap.idle;
    box.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;">
        <div>
          <div style="font-size:13px;font-weight:600;">${currentUser.email || 'Signed in'}</div>
          <div style="font-size:11px;color:${s.c};font-family:var(--mono);margin-top:2px;">● ${s.t}</div>
        </div>
        <div style="display:flex;gap:6px;">
          <button class="btn btn-ghost btn-sm" onclick="syncReconcile()" title="Sync now">↻</button>
          <button class="btn btn-ghost btn-sm" onclick="authSignOut()">Sign Out</button>
        </div>
      </div>`;
  } else {
    box.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;">
        <div>
          <div style="font-size:13px;font-weight:600;">Not signed in</div>
          <div style="font-size:11px;color:var(--muted2);margin-top:2px;">Using this device only. Sign in to sync across devices.</div>
        </div>
        <button class="btn btn-primary btn-sm" onclick="openAuthModal()">Sign In</button>
      </div>`;
  }
}
