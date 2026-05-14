/* ============================================================
   sync.js — Supabase sync layer
   ============================================================
   Strategy: local-first.
     - Reads always come from IndexedDB (instant, offline-safe).
     - Writes go to IndexedDB immediately, then enqueue a pending
       op that gets pushed to Supabase when online.
     - On startup + on auth + periodically, we pull fresh data
       from Supabase and merge into IndexedDB (last-write-wins
       via updated_at).
   ============================================================ */

let _supabase = null;
let _user = null;
let _pullTimer = null;
let _onAuthChange = null;
let _statusListeners = [];

function notifyStatus(msg) {
  _statusListeners.forEach(fn => fn(msg));
}

function onStatus(fn) { _statusListeners.push(fn); }

function isConfigured() {
  const c = window.APP_CONFIG;
  return c &&
    c.SUPABASE_URL &&
    !c.SUPABASE_URL.includes('YOUR-PROJECT-ID') &&
    c.SUPABASE_ANON_KEY &&
    !c.SUPABASE_ANON_KEY.includes('YOUR-ANON-KEY');
}

function getClient() {
  if (_supabase) return _supabase;
  if (!isConfigured()) return null;
  _supabase = supabase.createClient(window.APP_CONFIG.SUPABASE_URL, window.APP_CONFIG.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });
  return _supabase;
}

/* ===== Auth ===== */

async function init(onAuthChange) {
  _onAuthChange = onAuthChange;
  const sb = getClient();
  if (!sb) {
    onAuthChange(null);
    return;
  }

  // Track last-fired state so we don't double-invoke the UI init
  let _lastAuthState = undefined;
  const fire = (user) => {
    const state = user ? user.id : null;
    if (state === _lastAuthState) return;
    _lastAuthState = state;
    onAuthChange(user);
  };

  // Subscribe FIRST so we catch the session restore through the official channel.
  sb.auth.onAuthStateChange((event, session) => {
    if (session?.user) {
      _user = session.user;
      fire(_user);
      bootstrapAfterLogin();
    } else {
      _user = null;
      fire(null);
    }
  });

  // Then check for an existing session in case onAuthStateChange's INITIAL_SESSION
  // event has already fired or is delayed. The fire() guard above prevents dupes.
  const { data: { session } } = await sb.auth.getSession();
  if (session) {
    _user = session.user;
    fire(_user);
    bootstrapAfterLogin();
  } else {
    fire(null);
  }
}

async function sendOtpCode(email) {
  const sb = getClient();
  if (!sb) throw new Error('Supabase is not configured. Edit /js/config.js with your project URL and anon key.');

  // Send a one-time code (no clickable link). The shouldCreateUser flag stays true
  // so first-time sign-ups also work.
  const { error } = await sb.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: true }
  });
  if (error) throw error;
}

async function verifyOtpCode(email, token) {
  const sb = getClient();
  if (!sb) throw new Error('Supabase is not configured.');
  const { data, error } = await sb.auth.verifyOtp({
    email,
    token,
    type: 'email'
  });
  if (error) throw error;
  return data;
}

async function signOut() {
  const sb = getClient();
  if (!sb) return;
  await sb.auth.signOut();
  if (_pullTimer) { clearInterval(_pullTimer); _pullTimer = null; }
  _user = null;
}

function currentUser() { return _user; }

/* ===== Bootstrap on login ===== */

async function bootstrapAfterLogin() {
  notifyStatus('Syncing…');
  try {
    await pullAll();
    await flushPending();
    await maybeSeedFoods();
    notifyStatus(`Synced · ${new Date().toLocaleTimeString([], {hour:'numeric', minute:'2-digit'})}`);
  } catch (e) {
    console.warn('Initial sync error:', e);
    notifyStatus('Offline — using local data');
  }

  if (_pullTimer) clearInterval(_pullTimer);
  _pullTimer = setInterval(() => {
    if (navigator.onLine) {
      flushPending().then(pullAll).then(() => {
        notifyStatus(`Synced · ${new Date().toLocaleTimeString([], {hour:'numeric', minute:'2-digit'})}`);
      }).catch(() => notifyStatus('Sync paused — will retry'));
    }
  }, 60_000);

  window.addEventListener('online', () => {
    flushPending().then(pullAll).catch(() => {});
  });
}

/* ===== First-run food seeding (shared) ===== */

async function maybeSeedFoods() {
  const sb = getClient();
  if (!sb) return;

  const { count, error } = await sb.from('foods').select('id', { count: 'exact', head: true });
  if (error) { console.warn('Seed check failed:', error); return; }
  if (count && count > 0) return;

  // Insert seeds — both users get the same library
  const rows = window.SEED_FOODS.map(f => ({
    id: DB.uuid(),
    name: f.name,
    brand: f.brand || null,
    serving_desc: f.serving_desc,
    calories: f.calories,
    protein_g: f.protein_g,
    carbs_g: f.carbs_g,
    fat_g: f.fat_g,
    sugar_g: f.sugar_g
  }));
  const { error: insErr } = await sb.from('foods').insert(rows);
  if (insErr) { console.warn('Seed insert failed:', insErr); return; }
  // Repull to populate local
  await pullFoods();
}

/* ===== PULL (server -> local) ===== */

async function pullAll() {
  if (!_user) return;
  await Promise.all([pullFoods(), pullMeals(), pullWeights(), pullTargets(), pullNotes()]);
}

async function pullFoods() {
  const sb = getClient();
  const { data, error } = await sb.from('foods').select('*').order('name');
  if (error) throw error;
  // Replace local foods with server's view (foods are shared)
  await DB.clear('foods');
  for (const f of data) await DB.put('foods', f);
}

async function pullMeals() {
  const sb = getClient();
  const { data, error } = await sb.from('meals').select('*').eq('user_id', _user.id);
  if (error) throw error;
  // Merge: keep local rows that are pending (not yet on server)
  const localPendingIds = new Set();
  const pending = await DB.pendingAll();
  for (const p of pending) {
    if (p.table === 'meals' && p.record?.id) localPendingIds.add(p.record.id);
  }
  // Replace except pending
  const localAll = await DB.all('meals');
  for (const row of localAll) {
    if (row.user_id === _user.id && !localPendingIds.has(row.id)) {
      await DB.delete('meals', row.id);
    }
  }
  for (const m of data) {
    if (!localPendingIds.has(m.id)) await DB.put('meals', m);
  }
}

async function pullWeights() {
  const sb = getClient();
  const { data, error } = await sb.from('weights').select('*').eq('user_id', _user.id);
  if (error) throw error;
  const pending = await DB.pendingAll();
  const pendingIds = new Set(pending.filter(p => p.table === 'weights').map(p => p.record.id));
  const localAll = await DB.all('weights');
  for (const row of localAll) {
    if (row.user_id === _user.id && !pendingIds.has(row.id)) {
      await DB.delete('weights', row.id);
    }
  }
  for (const w of data) {
    if (!pendingIds.has(w.id)) await DB.put('weights', w);
  }
}

async function pullTargets() {
  const sb = getClient();
  const { data, error } = await sb.from('targets').select('*').eq('user_id', _user.id).maybeSingle();
  if (error) { console.warn('pullTargets:', error); return; }
  if (data) {
    await DB.put('targets', data);
  } else {
    // Create defaults
    const t = {
      user_id: _user.id,
      protein_g: window.APP_CONFIG.DEFAULT_TARGETS.protein_g,
      calories: window.APP_CONFIG.DEFAULT_TARGETS.calories,
      updated_at: new Date().toISOString()
    };
    await DB.put('targets', t);
    await sb.from('targets').upsert(t);
  }
}

async function pullNotes() {
  const sb = getClient();
  const { data, error } = await sb.from('notes').select('*').eq('user_id', _user.id);
  if (error) throw error;
  // Replace local notes for this user
  const all = await DB.all('notes');
  for (const n of all) {
    if (n.user_id === _user.id) await DB.delete('notes', [n.user_id, n.date]);
  }
  for (const n of data) await DB.put('notes', n);
}

/* ===== PUSH (local -> server) ===== */

async function flushPending() {
  if (!_user || !navigator.onLine) return;
  const sb = getClient();
  const ops = await DB.pendingAll();
  for (const op of ops) {
    try {
      if (op.op === 'upsert') {
        const { error } = await sb.from(op.table).upsert(op.record);
        if (error) throw error;
      } else if (op.op === 'delete') {
        const { error } = await sb.from(op.table).delete().match(op.match);
        if (error) throw error;
      }
      await DB.pendingRemove(op.id);
    } catch (e) {
      console.warn('Pending op failed, will retry:', op, e);
      // Stop draining on first error to preserve order
      break;
    }
  }
}

/* ===== High-level mutation API ===== */
/* All mutations: write local, enqueue, kick flush. */

async function saveMeal(meal) {
  if (!_user) throw new Error('not signed in');
  meal.user_id = _user.id;
  meal.updated_at = new Date().toISOString();
  await DB.put('meals', meal);
  await DB.enqueue({ op: 'upsert', table: 'meals', record: meal });
  flushPending().catch(() => {});
}

async function deleteMeal(id) {
  await DB.delete('meals', id);
  await DB.enqueue({ op: 'delete', table: 'meals', match: { id, user_id: _user.id } });
  flushPending().catch(() => {});
}

async function saveWeight(w) {
  if (!_user) throw new Error('not signed in');
  w.user_id = _user.id;
  w.updated_at = new Date().toISOString();
  await DB.put('weights', w);
  await DB.enqueue({ op: 'upsert', table: 'weights', record: w });
  flushPending().catch(() => {});
}

async function deleteWeight(id) {
  await DB.delete('weights', id);
  await DB.enqueue({ op: 'delete', table: 'weights', match: { id, user_id: _user.id } });
  flushPending().catch(() => {});
}

async function saveTargets(t) {
  if (!_user) throw new Error('not signed in');
  t.user_id = _user.id;
  t.updated_at = new Date().toISOString();
  await DB.put('targets', t);
  await DB.enqueue({ op: 'upsert', table: 'targets', record: t });
  flushPending().catch(() => {});
}

async function saveNote(date, text) {
  if (!_user) throw new Error('not signed in');
  const n = {
    user_id: _user.id,
    date,
    text: text || '',
    updated_at: new Date().toISOString()
  };
  await DB.put('notes', n);
  await DB.enqueue({ op: 'upsert', table: 'notes', record: n });
  flushPending().catch(() => {});
}

async function saveFood(food) {
  // Foods are shared (no user_id)
  food.updated_at = new Date().toISOString();
  await DB.put('foods', food);
  await DB.enqueue({ op: 'upsert', table: 'foods', record: food });
  flushPending().catch(() => {});
}

async function deleteFood(id) {
  await DB.delete('foods', id);
  await DB.enqueue({ op: 'delete', table: 'foods', match: { id } });
  flushPending().catch(() => {});
}

window.Sync = {
  init,
  sendOtpCode,
  verifyOtpCode,
  signOut,
  currentUser,
  isConfigured,
  saveMeal, deleteMeal,
  saveWeight, deleteWeight,
  saveTargets,
  saveNote,
  saveFood, deleteFood,
  onStatus,
  flushPending,
  pullAll
};
