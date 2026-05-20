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
let _currentHousehold = null; // { id, name, members, myRole, ... }
let _isAdmin = false;

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

  let _lastAuthState = undefined;
  const fire = (user) => {
    const state = user ? user.id : null;
    if (state === _lastAuthState) return;
    _lastAuthState = state;
    onAuthChange(user);
  };

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
  const { error } = await sb.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: true }
  });
  if (error) throw error;
}

async function verifyOtpCode(email, token) {
  const sb = getClient();
  if (!sb) throw new Error('Supabase is not configured.');
  const { data, error } = await sb.auth.verifyOtp({ email, token, type: 'email' });
  if (error) throw error;
  return data;
}

async function signOut() {
  const sb = getClient();
  if (!sb) return;
  await sb.auth.signOut();
  if (_pullTimer) { clearInterval(_pullTimer); _pullTimer = null; }
  _user = null;
  _currentHousehold = null;
  _isAdmin = false;
}

function currentUser() { return _user; }
function currentHousehold() { return _currentHousehold; }
function isAdmin() { return _isAdmin; }

/* ===== Bootstrap on login ===== */

async function bootstrapAfterLogin() {
  notifyStatus('Syncing…');
  const isNewUser = await _checkAndCreateHousehold();
  try {
    await pullAll();
    await flushPending();
    await maybeSeedHousehold();
    notifyStatus(`Synced · ${new Date().toLocaleTimeString([], {hour:'numeric', minute:'2-digit'})}`);
    if (isNewUser) {
      _showWelcomeModal();
    }
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

function _showWelcomeModal() {
  const key = 'daily-log-welcome-shown';
  if (localStorage.getItem(key)) return;
  localStorage.setItem(key, '1');
  const modal = document.getElementById('modal-welcome');
  if (modal) modal.classList.remove('hidden');
}

/* ===== Household bootstrapping ===== */

async function _checkAndCreateHousehold() {
  const sb = getClient();
  if (!sb || !_user) return false;

  try {
    const { data: membership } = await sb
      .from('household_members')
      .select('household_id')
      .eq('user_id', _user.id)
      .limit(1)
      .maybeSingle();

    if (!membership) {
      await _createSoloHousehold();
      return true; // new user
    }
    return false;
  } catch (e) {
    console.warn('Household check failed:', e);
    return false;
  }
}

async function _createSoloHousehold() {
  const sb = getClient();
  const emailPrefix = (_user.email || 'user').split('@')[0];
  const householdName = `${emailPrefix}'s household`;
  const householdId = DB.uuid();

  const { error: hErr } = await sb.from('households').insert({
    id: householdId,
    name: householdName,
    created_by: _user.id
  });
  if (hErr) throw hErr;

  const { error: mErr } = await sb.from('household_members').insert({
    household_id: householdId,
    user_id: _user.id,
    role: 'owner'
  });
  if (mErr) throw mErr;

  return householdId;
}

/* ===== PULL (server -> local) ===== */

async function pullAll() {
  if (!_user) return;
  await pullHousehold();
  await pullAdminStatus();
  await Promise.all([pullFoods(), pullMeals(), pullWeights(), pullTargets(), pullNotes()]);
}

async function pullHousehold() {
  const sb = getClient();
  if (!sb || !_user) return;

  const { data: membership } = await sb
    .from('household_members')
    .select('household_id, role, joined_at')
    .eq('user_id', _user.id)
    .maybeSingle();

  if (!membership) {
    _currentHousehold = null;
    return;
  }

  const { data: household } = await sb
    .from('households')
    .select('*')
    .eq('id', membership.household_id)
    .single();

  const { data: members } = await sb
    .from('household_members')
    .select('user_id, role, joined_at')
    .eq('household_id', membership.household_id);

  // Fetch profile info for each member (email, display_name)
  const memberList = members || [];
  const userIds = memberList.map(m => m.user_id);
  let profileMap = new Map();
  if (userIds.length > 0) {
    const { data: profiles } = await sb
      .from('profiles')
      .select('id, email, display_name')
      .in('id', userIds);
    profileMap = new Map((profiles || []).map(p => [p.id, p]));
  }

  const enrichedMembers = memberList.map(m => {
    const p = profileMap.get(m.user_id);
    return {
      ...m,
      email: p?.email || null,
      display_name: p?.display_name || null
    };
  });

  _currentHousehold = {
    ...household,
    members: enrichedMembers,
    myRole: membership.role
  };

  await DB.put('households', { household_id: membership.household_id, ..._currentHousehold });
}

async function pullAdminStatus() {
  const sb = getClient();
  if (!sb || !_user) return;
  try {
    const { data } = await sb
      .from('admins')
      .select('user_id')
      .eq('user_id', _user.id)
      .maybeSingle();
    _isAdmin = !!data;
    await DB.metaSet('isAdmin', _isAdmin);
  } catch (e) {
    console.warn('Admin check failed:', e);
  }
}

async function pullFoods() {
  const sb = getClient();
  if (!sb) return;

  const householdId = _currentHousehold?.id;

  let data, error;
  if (householdId) {
    ({ data, error } = await sb
      .from('foods')
      .select('*')
      .or(`kind.eq.system,and(kind.eq.household,household_id.eq.${householdId})`)
      .order('name'));
  } else {
    ({ data, error } = await sb
      .from('foods')
      .select('*')
      .eq('kind', 'system')
      .order('name'));
  }

  if (error) throw error;
  await DB.clear('foods');
  for (const f of data) await DB.put('foods', f);
}

async function pullMeals() {
  const sb = getClient();
  const { data, error } = await sb.from('meals').select('*').eq('user_id', _user.id);
  if (error) throw error;
  const localPendingIds = new Set();
  const pending = await DB.pendingAll();
  for (const p of pending) {
    if (p.table === 'meals' && p.record?.id) localPendingIds.add(p.record.id);
  }
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
  const all = await DB.all('notes');
  for (const n of all) {
    if (n.user_id === _user.id) await DB.delete('notes', [n.user_id, n.date]);
  }
  for (const n of data) await DB.put('notes', n);
}

/* ===== First-run household seeding ===== */

async function maybeSeedHousehold() {
  const sb = getClient();
  if (!sb || !_currentHousehold) return;
  if (!window.SEED_FOODS || window.SEED_FOODS.length === 0) return;

  const householdId = _currentHousehold.id;

  const { count, error } = await sb
    .from('foods')
    .select('id', { count: 'exact', head: true })
    .eq('household_id', householdId);

  if (error) { console.warn('Seed check failed:', error); return; }
  if (count && count > 0) return;

  const rows = window.SEED_FOODS.map(f => ({
    id: DB.uuid(),
    kind: 'household',
    household_id: householdId,
    name: f.name,
    brand: f.brand || null,
    serving_desc: f.serving_desc,
    calories: f.calories,
    protein_g: f.protein_g,
    carbs_g: f.carbs_g,
    fat_g: f.fat_g,
    sugar_g: f.sugar_g ?? null,
    created_by: _user.id
  }));

  const { error: insErr } = await sb.from('foods').insert(rows);
  if (insErr) { console.warn('Seed insert failed:', insErr); return; }
  await pullFoods();
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
      break;
    }
  }
}

/* ===== High-level mutation API ===== */

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
  if (!_user) throw new Error('not signed in');
  if (!food.kind) food.kind = 'household';
  if (food.kind === 'household' && !food.household_id) {
    food.household_id = _currentHousehold?.id || null;
  }
  if (food.kind === 'system') food.household_id = null;
  food.created_by = food.created_by || _user.id;
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

/* ===== Household management ===== */

async function createHouseholdInvite() {
  const sb = getClient();
  if (!sb || !_user || !_currentHousehold) throw new Error('not in a household');

  const code = String(Math.floor(100000 + Math.random() * 900000));
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

  const { error } = await sb.from('household_invites').insert({
    code,
    household_id: _currentHousehold.id,
    invited_by: _user.id,
    expires_at: expiresAt
  });
  if (error) throw error;

  return { code, expires_at: expiresAt };
}

async function lookupInviteCode(code) {
  const sb = getClient();
  if (!sb) throw new Error('not configured');

  const { data, error } = await sb
    .from('household_invites')
    .select('*, households(id, name)')
    .eq('code', code)
    .maybeSingle();

  if (error) throw error;
  if (!data) throw Object.assign(new Error('Invalid code. Check the digits and try again.'), { kind: 'invalid' });
  if (data.consumed_at) throw Object.assign(new Error('This code has already been used.'), { kind: 'consumed' });
  if (new Date(data.expires_at) < new Date()) throw Object.assign(new Error('This code has expired. Ask for a new one.'), { kind: 'expired' });

  if (_currentHousehold?.id === data.household_id) {
    throw Object.assign(new Error('You\'re already a member of this household.'), { kind: 'already_member' });
  }

  const { count } = await sb
    .from('household_members')
    .select('user_id', { count: 'exact', head: true })
    .eq('household_id', data.household_id);

  return {
    household_id: data.household_id,
    household_name: data.households?.name || 'Unknown household',
    member_count: count || 0,
    expires_at: data.expires_at
  };
}

async function acceptInvite(code) {
  const sb = getClient();
  if (!sb || !_user) throw new Error('not signed in');

  const { data: invite, error: inviteErr } = await sb
    .from('household_invites')
    .select('*')
    .eq('code', code)
    .maybeSingle();

  if (inviteErr) throw inviteErr;
  if (!invite) throw new Error('Invalid code. Check the digits and try again.');
  if (invite.consumed_at) throw new Error('This code has already been used.');
  if (new Date(invite.expires_at) < new Date()) throw new Error('This code has expired. Ask for a new one.');

  const newHouseholdId = invite.household_id;

  // Add to new household first (idempotent via upsert)
  const { error: joinErr } = await sb.from('household_members').upsert({
    household_id: newHouseholdId,
    user_id: _user.id,
    role: 'member'
  }, { onConflict: 'household_id,user_id' });
  if (joinErr) throw joinErr;

  // Mark invite consumed
  await sb.from('household_invites')
    .update({ consumed_at: new Date().toISOString() })
    .eq('code', code);

  // Leave old household (don't create a new one)
  if (_currentHousehold) await _doLeaveHousehold(false);

  await pullHousehold();
  await pullFoods();
}

async function leaveHousehold() {
  await _doLeaveHousehold(true);
}

async function _doLeaveHousehold(createNew) {
  const sb = getClient();
  if (!sb || !_user || !_currentHousehold) return;

  const householdId = _currentHousehold.id;
  const members = _currentHousehold.members || [];
  const myRole = _currentHousehold.myRole;

  // Promote longest-tenured other member if we're the owner and others exist
  if (myRole === 'owner' && members.length > 1) {
    const others = members
      .filter(m => m.user_id !== _user.id)
      .sort((a, b) => new Date(a.joined_at) - new Date(b.joined_at));
    if (others.length > 0) {
      await sb.from('household_members')
        .update({ role: 'owner' })
        .eq('household_id', householdId)
        .eq('user_id', others[0].user_id);
    }
  }

  // Remove self
  await sb.from('household_members')
    .delete()
    .eq('household_id', householdId)
    .eq('user_id', _user.id);

  // Delete household if we were the last member
  if (members.length <= 1) {
    await sb.from('households').delete().eq('id', householdId);
  }

  _currentHousehold = null;

  if (createNew) {
    await _createSoloHousehold();
    await pullHousehold();
    await pullFoods();
  }
}

async function removeMember(userId) {
  const sb = getClient();
  if (!sb || !_user || !_currentHousehold) return;
  if (_currentHousehold.myRole !== 'owner') throw new Error('Only the household owner can remove members.');

  await sb.from('household_members')
    .delete()
    .eq('household_id', _currentHousehold.id)
    .eq('user_id', userId);

  await pullHousehold();
}

async function renameHousehold(name) {
  const sb = getClient();
  if (!sb || !_user || !_currentHousehold) return;

  const { error } = await sb
    .from('households')
    .update({ name })
    .eq('id', _currentHousehold.id);
  if (error) throw error;

  _currentHousehold.name = name;
  await DB.put('households', { household_id: _currentHousehold.id, ..._currentHousehold });
}

window.Sync = {
  init,
  sendOtpCode,
  verifyOtpCode,
  signOut,
  currentUser,
  currentHousehold,
  isAdmin,
  isConfigured,
  saveMeal, deleteMeal,
  saveWeight, deleteWeight,
  saveTargets,
  saveNote,
  saveFood, deleteFood,
  createHouseholdInvite,
  lookupInviteCode,
  acceptInvite,
  leaveHousehold,
  removeMember,
  renameHousehold,
  onStatus,
  flushPending,
  pullAll,
  pullHousehold
};
