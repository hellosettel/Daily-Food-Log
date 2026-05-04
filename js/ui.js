/* ============================================================
   ui.js — rendering + event handlers
   ============================================================ */

const $ = sel => document.querySelector(sel);
const $$ = sel => document.querySelectorAll(sel);

const STATE = {
  currentDate: DB.todayLocalDate(),
  currentMonth: new Date().getMonth(),
  currentYear: new Date().getFullYear(),
  pendingMeal: null,        // for serving modal: { mealType, food, servings }
  pendingMealType: null,    // for add modal: which meal we're adding to
  editingFoodId: null       // for edit-food modal
};

/* ============================================================
   Helpers
   ============================================================ */

function showToast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.classList.add('hidden'), 220);
  }, 1800);
}

function fmtDate(date) {
  const opts = { weekday: 'long', month: 'long', day: 'numeric' };
  return date.toLocaleDateString(undefined, opts);
}

function eyebrowFor(dateStr) {
  const today = DB.todayLocalDate();
  if (dateStr === today) return 'Today';
  const d = DB.parseYMD(dateStr);
  const t = DB.parseYMD(today);
  const diff = Math.round((t - d) / 86400000);
  if (diff === 1) return 'Yesterday';
  if (diff === -1) return 'Tomorrow';
  if (diff > 0 && diff <= 7) return `${diff} days ago`;
  if (diff < 0 && diff >= -7) return `In ${-diff} days`;
  return d.toLocaleDateString(undefined, { weekday: 'long' });
}

async function getMealsForDate(date) {
  const user = Sync.currentUser();
  if (!user) return [];
  const all = await DB.allByIndex('meals', 'by_date', date);
  return all.filter(m => m.user_id === user.id);
}

async function getTargets() {
  const user = Sync.currentUser();
  if (!user) return window.APP_CONFIG.DEFAULT_TARGETS;
  const t = await DB.get('targets', user.id);
  return t || {
    user_id: user.id,
    ...window.APP_CONFIG.DEFAULT_TARGETS
  };
}

/* ============================================================
   TODAY VIEW
   ============================================================ */

async function renderToday() {
  const date = STATE.currentDate;
  const dateObj = DB.parseYMD(date);

  $('#day-eyebrow').textContent = eyebrowFor(date);
  $('#day-date').textContent = fmtDate(dateObj);

  const meals = await getMealsForDate(date);
  const targets = await getTargets();

  $('#protein-target').textContent = targets.protein_g;
  $('#calories-target').textContent = targets.calories;

  // Macro totals
  let p = 0, c = 0, ca = 0, f = 0, s = 0, sUnknown = false;
  for (const m of meals) {
    const mult = m.servings || 1;
    p += (m.protein_g || 0) * mult;
    c += (m.calories || 0) * mult;
    ca += (m.carbs_g || 0) * mult;
    f += (m.fat_g || 0) * mult;
    if (m.sugar_g === null || m.sugar_g === undefined) {
      sUnknown = true;
    } else {
      s += m.sugar_g * mult;
    }
  }

  $('#protein-current').textContent = Math.round(p);
  $('#calories-current').textContent = Math.round(c);
  $('#carbs-current').textContent = Math.round(ca);
  $('#fat-current').textContent = Math.round(f);
  $('#sugar-current').textContent = Math.round(s);
  $('#sugar-asterisk').classList.toggle('hidden', !sUnknown);

  // Bars
  const pPct = Math.min(100, (p / targets.protein_g) * 100);
  const cPct = Math.min(100, (c / targets.calories) * 100);
  const pFill = $('#protein-fill');
  const cFill = $('#calories-fill');
  pFill.style.width = pPct + '%';
  cFill.style.width = cPct + '%';
  pFill.classList.toggle('hit', p >= targets.protein_g);
  cFill.classList.toggle('over', c > targets.calories * 1.05);

  // Render meals by type
  const grouped = { breakfast: [], lunch: [], dinner: [], snack: [] };
  for (const m of meals) {
    if (grouped[m.meal_type]) grouped[m.meal_type].push(m);
  }

  for (const type of Object.keys(grouped)) {
    const ul = $('#items-' + type);
    ul.innerHTML = '';
    for (const m of grouped[type]) {
      ul.appendChild(renderMealItem(m));
    }
  }

  // Day note
  const user = Sync.currentUser();
  if (user) {
    const note = await DB.get('notes', [user.id, date]);
    $('#day-note').value = note?.text || '';
  }
}

function renderMealItem(m) {
  const li = document.createElement('li');
  li.className = 'meal-item';
  const mult = m.servings || 1;
  const cal = Math.round((m.calories || 0) * mult);
  const pro = Math.round((m.protein_g || 0) * mult);
  const carb = Math.round((m.carbs_g || 0) * mult);
  const fat = Math.round((m.fat_g || 0) * mult);
  const sug = (m.sugar_g === null || m.sugar_g === undefined) ? null : Math.round(m.sugar_g * mult);

  const servingLabel = mult === 1 ? '' : `${mult}× `;
  const sugarLabel = sug === null ? 'sugar —' : `${sug}g sugar`;

  li.innerHTML = `
    <div class="meal-item-info">
      <div class="meal-item-name">${servingLabel}${escapeHTML(m.food_name)}</div>
      <div class="meal-item-detail">
        <span>${cal} cal</span>
        <span>${pro}g P</span>
        <span>${carb}g C</span>
        <span>${fat}g F</span>
        <span>${sugarLabel}</span>
      </div>
    </div>
    <button class="meal-item-delete" aria-label="Remove">×</button>
  `;
  li.querySelector('.meal-item-delete').addEventListener('click', async () => {
    await Sync.deleteMeal(m.id);
    renderToday();
  });
  return li;
}

function escapeHTML(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

/* ============================================================
   DAY NAVIGATION
   ============================================================ */

function bindDayNav() {
  $('#day-prev').addEventListener('click', () => shiftDay(-1));
  $('#day-next').addEventListener('click', () => shiftDay(1));

  // Swipe to change day
  let touchStartX = 0;
  let touchStartY = 0;
  let touchStartT = 0;
  const view = $('#view-today');
  view.addEventListener('touchstart', e => {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
    touchStartT = Date.now();
  }, { passive: true });
  view.addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - touchStartX;
    const dy = e.changedTouches[0].clientY - touchStartY;
    const dt = Date.now() - touchStartT;
    if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.8 && dt < 500) {
      shiftDay(dx < 0 ? 1 : -1);
    }
  }, { passive: true });
}

function shiftDay(delta) {
  const d = DB.parseYMD(STATE.currentDate);
  d.setDate(d.getDate() + delta);
  STATE.currentDate = DB.ymd(d);
  renderToday();
}

/* ============================================================
   ADD MEAL FLOW
   ============================================================ */

function bindAddFlow() {
  $$('.meal-add-btn').forEach(btn => {
    btn.addEventListener('click', () => openAddModal(btn.dataset.meal));
  });
  $('#food-search').addEventListener('input', renderFoodList);
  $('#custom-add-btn').addEventListener('click', openCustomModal);

  $('#serving-up').addEventListener('click', () => stepServing(1));
  $('#serving-down').addEventListener('click', () => stepServing(-1));
  $('#serving-confirm').addEventListener('click', confirmServing);

  $('#custom-confirm').addEventListener('click', confirmCustom);

  // Close handlers
  $$('[data-close]').forEach(el => {
    el.addEventListener('click', () => closeModal(el.dataset.close));
  });
}

async function openAddModal(mealType) {
  STATE.pendingMealType = mealType;
  $('#modal-add-title').textContent = `Add to ${capitalize(mealType)}`;
  $('#food-search').value = '';
  await renderFavorites();
  await renderFoodList();
  showModal('modal-add');
}

function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

async function renderFavorites() {
  const user = Sync.currentUser();
  if (!user) return;

  // Top 6 most-logged foods over the past 30 days
  const allMeals = await DB.allByIndex('meals', 'by_user', user.id);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  const cutoffStr = DB.ymd(cutoff);

  const counts = {};
  for (const m of allMeals) {
    if (!m.food_id || m.date < cutoffStr) continue;
    counts[m.food_id] = (counts[m.food_id] || 0) + 1;
  }

  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 6);

  const grid = $('#favorites-grid');
  const section = $('#favorites-section');
  grid.innerHTML = '';

  if (sorted.length === 0) {
    section.classList.add('hidden');
    return;
  }
  section.classList.remove('hidden');

  for (const [foodId] of sorted) {
    const food = await DB.get('foods', foodId);
    if (!food) continue;
    const tile = document.createElement('button');
    tile.className = 'fav-tile';
    tile.innerHTML = `
      <div class="fav-tile-name">${escapeHTML(food.name)}</div>
      <div class="fav-tile-meta">${food.calories} cal · ${food.protein_g}g P</div>
    `;
    tile.addEventListener('click', () => openServingModal(food));
    grid.appendChild(tile);
  }
}

async function renderFoodList() {
  const q = $('#food-search').value.toLowerCase().trim();
  const all = await DB.all('foods');
  const filtered = q
    ? all.filter(f => f.name.toLowerCase().includes(q))
    : all;
  filtered.sort((a, b) => a.name.localeCompare(b.name));

  const ul = $('#food-list');
  ul.innerHTML = '';
  for (const f of filtered) {
    const li = document.createElement('li');
    li.className = 'food-row';
    li.innerHTML = `
      <div class="food-row-info">
        <div class="food-row-name">${escapeHTML(f.name)}</div>
        <div class="food-row-meta">${escapeHTML(f.serving_desc || '')} · ${f.calories} cal · ${f.protein_g}g P</div>
      </div>
    `;
    li.addEventListener('click', () => openServingModal(f));
    ul.appendChild(li);
  }
}

function openServingModal(food) {
  STATE.pendingMeal = { food, servings: 1 };
  $('#serving-food-name').textContent = food.name;
  $('#serving-unit').textContent = food.serving_desc || 'serving';
  $('#serving-count').textContent = '1';
  updateServingPreview();
  hideModal('modal-add');
  showModal('modal-serving');
}

function stepServing(delta) {
  if (!STATE.pendingMeal) return;
  let s = STATE.pendingMeal.servings + delta * 0.5;
  if (s < 0.5) s = 0.5;
  if (s > 20) s = 20;
  STATE.pendingMeal.servings = s;
  $('#serving-count').textContent = s % 1 === 0 ? s.toString() : s.toFixed(1);
  updateServingPreview();
}

function updateServingPreview() {
  if (!STATE.pendingMeal) return;
  const { food, servings } = STATE.pendingMeal;
  const cal = Math.round(food.calories * servings);
  const p = Math.round(food.protein_g * servings);
  const sug = food.sugar_g == null ? '—' : Math.round(food.sugar_g * servings) + 'g';
  $('#serving-preview').textContent = `${cal} cal · ${p}g protein · ${sug} sugar`;
}

async function confirmServing() {
  if (!STATE.pendingMeal) return;
  const { food, servings } = STATE.pendingMeal;
  const meal = {
    id: DB.uuid(),
    date: STATE.currentDate,
    meal_type: STATE.pendingMealType,
    food_id: food.id,
    food_name: food.name,
    servings,
    calories: food.calories,
    protein_g: food.protein_g,
    carbs_g: food.carbs_g,
    fat_g: food.fat_g,
    sugar_g: food.sugar_g  // may be null
  };
  await Sync.saveMeal(meal);
  hideModal('modal-serving');
  STATE.pendingMeal = null;
  renderToday();
  showToast('Logged');
}

/* ===== Custom one-off ===== */

function openCustomModal() {
  ['custom-name', 'custom-cal', 'custom-protein', 'custom-carbs', 'custom-fat', 'custom-sugar'].forEach(id => {
    $('#' + id).value = '';
  });
  hideModal('modal-add');
  showModal('modal-custom');
}

async function confirmCustom() {
  const name = $('#custom-name').value.trim();
  if (!name) { showToast('Name is required'); return; }
  const num = id => {
    const v = $('#' + id).value;
    if (v === '') return 0;
    return parseFloat(v) || 0;
  };
  const sugarRaw = $('#custom-sugar').value;
  const sugar = sugarRaw === '' ? null : parseFloat(sugarRaw);

  const meal = {
    id: DB.uuid(),
    date: STATE.currentDate,
    meal_type: STATE.pendingMealType,
    food_id: null,
    food_name: name,
    servings: 1,
    calories: num('custom-cal'),
    protein_g: num('custom-protein'),
    carbs_g: num('custom-carbs'),
    fat_g: num('custom-fat'),
    sugar_g: sugar
  };
  await Sync.saveMeal(meal);
  hideModal('modal-custom');
  renderToday();
  showToast('Logged');
}

/* ===== Day note ===== */

let _noteTimer = null;
function bindNote() {
  $('#day-note').addEventListener('input', e => {
    const text = e.target.value;
    if (_noteTimer) clearTimeout(_noteTimer);
    _noteTimer = setTimeout(() => {
      Sync.saveNote(STATE.currentDate, text);
    }, 600);
  });
}

/* ============================================================
   CALENDAR VIEW
   ============================================================ */

function bindCalNav() {
  $('#cal-prev').addEventListener('click', () => shiftMonth(-1));
  $('#cal-next').addEventListener('click', () => shiftMonth(1));
}

function shiftMonth(delta) {
  let m = STATE.currentMonth + delta;
  let y = STATE.currentYear;
  if (m < 0) { m = 11; y--; }
  if (m > 11) { m = 0; y++; }
  STATE.currentMonth = m;
  STATE.currentYear = y;
  renderCalendar();
}

async function renderCalendar() {
  const y = STATE.currentYear;
  const m = STATE.currentMonth;
  const monthName = new Date(y, m, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  $('#cal-month-label').textContent = monthName;

  const firstDay = new Date(y, m, 1).getDay();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const todayStr = DB.todayLocalDate();
  const targets = await getTargets();
  const threshold = window.APP_CONFIG.PROTEIN_HIT_THRESHOLD;

  const grid = $('#cal-grid');
  grid.innerHTML = '';

  for (let i = 0; i < firstDay; i++) {
    const cell = document.createElement('div');
    cell.className = 'cal-cell empty';
    grid.appendChild(cell);
  }

  let hits = 0, logged = 0, totalLogged = 0;

  for (let day = 1; day <= daysInMonth; day++) {
    const ds = `${y}-${String(m + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const meals = await getMealsForDate(ds);
    const isFuture = ds > todayStr;

    let totalP = 0;
    for (const me of meals) totalP += (me.protein_g || 0) * (me.servings || 1);

    const cell = document.createElement('button');
    cell.className = 'cal-cell';
    cell.textContent = day;

    if (isFuture) {
      cell.classList.add('future');
    } else if (totalP >= threshold) {
      cell.classList.add('hit');
      hits++; totalLogged++;
    } else if (meals.length > 0) {
      cell.classList.add('logged');
      logged++; totalLogged++;
    }

    if (ds === todayStr) cell.classList.add('today');

    cell.addEventListener('click', () => {
      STATE.currentDate = ds;
      switchView('today');
    });

    grid.appendChild(cell);
  }

  // Summary line
  const sum = $('#cal-summary');
  if (totalLogged === 0) {
    sum.textContent = 'No days logged this month yet.';
  } else {
    const pct = Math.round((hits / totalLogged) * 100);
    sum.textContent = `${hits} of ${totalLogged} logged days hit protein · ${pct}%`;
  }
}

/* ============================================================
   WEIGHT VIEW
   ============================================================ */

function bindWeight() {
  $('#weight-log-btn').addEventListener('click', logWeight);
  $('#weight-input').addEventListener('keypress', e => {
    if (e.key === 'Enter') logWeight();
  });
}

async function logWeight() {
  const v = parseFloat($('#weight-input').value);
  if (isNaN(v) || v <= 0 || v > 800) { showToast('Enter a valid weight'); return; }

  // One per date — overwrite if exists for today
  const today = DB.todayLocalDate();
  const all = await DB.all('weights');
  const user = Sync.currentUser();
  const existing = all.find(w => w.user_id === user.id && w.date === today);

  const w = {
    id: existing?.id || DB.uuid(),
    date: today,
    weight_lbs: v
  };
  await Sync.saveWeight(w);
  $('#weight-input').value = '';
  showToast('Logged');
  renderWeight();
}

async function renderWeight() {
  const user = Sync.currentUser();
  if (!user) return;
  const all = (await DB.all('weights')).filter(w => w.user_id === user.id);
  all.sort((a, b) => a.date.localeCompare(b.date));

  // Chart
  const svg = $('#weight-chart');
  svg.innerHTML = '';

  if (all.length < 2) {
    svg.innerHTML = `
      <text x="300" y="120" text-anchor="middle" fill="#8b8275"
            font-family="Fraunces, serif" font-style="italic" font-size="16">
        ${all.length === 0 ? 'Log your weight to see your trend' : 'Log a few more times to see your trend'}
      </text>
    `;
  } else {
    drawWeightChart(svg, all);
  }

  // Stats
  const stats = $('#weight-stats');
  if (all.length >= 2) {
    const latest = all[all.length - 1].weight_lbs;
    const first = all[0].weight_lbs;
    const min = Math.min(...all.map(w => w.weight_lbs));
    const max = Math.max(...all.map(w => w.weight_lbs));
    const change = latest - first;
    const sign = change > 0 ? '+' : '';
    stats.innerHTML = `
      <div class="wstat"><div class="wstat-label">Current</div><div class="wstat-value">${latest.toFixed(1)}</div></div>
      <div class="wstat"><div class="wstat-label">Range</div><div class="wstat-value">${min.toFixed(1)}–${max.toFixed(1)}</div></div>
      <div class="wstat"><div class="wstat-label">Change</div><div class="wstat-value">${sign}${change.toFixed(1)}</div></div>
    `;
  } else if (all.length === 1) {
    stats.innerHTML = `<div class="wstat"><div class="wstat-label">Current</div><div class="wstat-value">${all[0].weight_lbs.toFixed(1)}</div></div>`;
  } else {
    stats.innerHTML = '';
  }

  // History
  const hist = $('#weight-history');
  hist.innerHTML = '';
  const recent = all.slice(-12).reverse();
  for (const w of recent) {
    const row = document.createElement('div');
    row.className = 'wh-row';
    const d = DB.parseYMD(w.date);
    row.innerHTML = `
      <span class="wh-date">${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</span>
      <span class="wh-val">${w.weight_lbs.toFixed(1)} lbs</span>
    `;
    hist.appendChild(row);
  }
}

function drawWeightChart(svg, points) {
  const W = 600, H = 240;
  const pad = { top: 20, right: 20, bottom: 30, left: 40 };
  const minV = Math.min(...points.map(p => p.weight_lbs));
  const maxV = Math.max(...points.map(p => p.weight_lbs));
  const range = Math.max(1, maxV - minV);
  const yPad = range * 0.15;
  const yMin = minV - yPad;
  const yMax = maxV + yPad;

  const xFor = i => pad.left + (i / (points.length - 1)) * (W - pad.left - pad.right);
  const yFor = v => pad.top + (1 - (v - yMin) / (yMax - yMin)) * (H - pad.top - pad.bottom);

  // Gridlines
  let svgContent = '';
  for (let i = 0; i <= 3; i++) {
    const yv = yMin + (i / 3) * (yMax - yMin);
    const yp = yFor(yv);
    svgContent += `<line x1="${pad.left}" y1="${yp}" x2="${W - pad.right}" y2="${yp}" stroke="#e8e0d0" stroke-width="1" />`;
    svgContent += `<text x="${pad.left - 6}" y="${yp + 3}" text-anchor="end" font-size="10" fill="#8b8275" font-family="Inter Tight">${yv.toFixed(0)}</text>`;
  }

  // Path
  let d = '';
  points.forEach((p, i) => {
    const x = xFor(i), y = yFor(p.weight_lbs);
    d += (i === 0 ? 'M' : 'L') + x + ',' + y + ' ';
  });
  svgContent += `<path d="${d}" fill="none" stroke="#1a1814" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />`;

  // Dots
  points.forEach((p, i) => {
    const x = xFor(i), y = yFor(p.weight_lbs);
    svgContent += `<circle cx="${x}" cy="${y}" r="3" fill="#c44827" />`;
  });

  svg.innerHTML = svgContent;
}

/* ============================================================
   SETTINGS VIEW
   ============================================================ */

function bindSettings() {
  $('#targets-save').addEventListener('click', async () => {
    const p = parseInt($('#target-protein').value);
    const c = parseInt($('#target-calories').value);
    if (isNaN(p) || isNaN(c) || p <= 0 || c <= 0) { showToast('Invalid values'); return; }
    await Sync.saveTargets({ protein_g: p, calories: c });
    showToast('Targets saved');
    if ($('#view-today').classList.contains('active')) renderToday();
  });

  $('#manage-foods-btn').addEventListener('click', openManageFoods);
  $('#add-food-btn').addEventListener('click', () => openEditFood(null));
  $('#ef-save').addEventListener('click', saveEditFood);
  $('#ef-delete').addEventListener('click', deleteEditFood);

  $('#export-btn').addEventListener('click', exportData);
  $('#signout-btn').addEventListener('click', async () => {
    await Sync.signOut();
    showToast('Signed out');
    location.reload();
  });

  Sync.onStatus(msg => { $('#sync-status').textContent = msg; });
}

async function renderSettings() {
  const targets = await getTargets();
  $('#target-protein').value = targets.protein_g;
  $('#target-calories').value = targets.calories;
  const user = Sync.currentUser();
  if (user) $('#settings-user').textContent = user.email;
}

async function openManageFoods() {
  const all = await DB.all('foods');
  all.sort((a, b) => a.name.localeCompare(b.name));
  const ul = $('#food-manage-list');
  ul.innerHTML = '';
  for (const f of all) {
    const li = document.createElement('li');
    li.className = 'food-row';
    li.innerHTML = `
      <div class="food-row-info">
        <div class="food-row-name">${escapeHTML(f.name)}</div>
        <div class="food-row-meta">${escapeHTML(f.serving_desc || '')} · ${f.calories} cal</div>
      </div>
    `;
    li.addEventListener('click', () => openEditFood(f.id));
    ul.appendChild(li);
  }
  showModal('modal-foods');
}

async function openEditFood(id) {
  STATE.editingFoodId = id;
  if (id) {
    const f = await DB.get('foods', id);
    if (!f) return;
    $('#edit-food-title').textContent = 'Edit food';
    $('#ef-name').value = f.name;
    $('#ef-serving-desc').value = f.serving_desc || '';
    $('#ef-cal').value = f.calories;
    $('#ef-protein').value = f.protein_g;
    $('#ef-carbs').value = f.carbs_g;
    $('#ef-fat').value = f.fat_g;
    $('#ef-sugar').value = f.sugar_g == null ? '' : f.sugar_g;
    $('#ef-delete').classList.remove('hidden');
  } else {
    $('#edit-food-title').textContent = 'New food';
    ['ef-name', 'ef-serving-desc', 'ef-cal', 'ef-protein', 'ef-carbs', 'ef-fat', 'ef-sugar'].forEach(i => $('#' + i).value = '');
    $('#ef-delete').classList.add('hidden');
  }
  hideModal('modal-foods');
  showModal('modal-edit-food');
}

async function saveEditFood() {
  const name = $('#ef-name').value.trim();
  if (!name) { showToast('Name required'); return; }
  const num = id => {
    const v = $('#' + id).value;
    return v === '' ? 0 : (parseFloat(v) || 0);
  };
  const sugarRaw = $('#ef-sugar').value;
  const food = {
    id: STATE.editingFoodId || DB.uuid(),
    name,
    serving_desc: $('#ef-serving-desc').value.trim(),
    calories: num('ef-cal'),
    protein_g: num('ef-protein'),
    carbs_g: num('ef-carbs'),
    fat_g: num('ef-fat'),
    sugar_g: sugarRaw === '' ? null : parseFloat(sugarRaw)
  };
  await Sync.saveFood(food);
  hideModal('modal-edit-food');
  STATE.editingFoodId = null;
  showToast('Saved');
  openManageFoods();
}

async function deleteEditFood() {
  if (!STATE.editingFoodId) return;
  if (!confirm('Delete this food? It will be removed from the shared library.')) return;
  await Sync.deleteFood(STATE.editingFoodId);
  hideModal('modal-edit-food');
  STATE.editingFoodId = null;
  showToast('Deleted');
  openManageFoods();
}

async function exportData() {
  const user = Sync.currentUser();
  if (!user) return;
  const meals = (await DB.all('meals')).filter(m => m.user_id === user.id);
  const weights = (await DB.all('weights')).filter(w => w.user_id === user.id);
  const notes = (await DB.all('notes')).filter(n => n.user_id === user.id);
  const targets = await DB.get('targets', user.id);
  const foods = await DB.all('foods');
  const blob = new Blob([JSON.stringify({
    exported_at: new Date().toISOString(),
    user_email: user.email,
    targets, meals, weights, notes, foods
  }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `daily-log-export-${DB.todayLocalDate()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

/* ============================================================
   NAV / MODAL helpers
   ============================================================ */

function bindNav() {
  $$('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });
}

function switchView(name) {
  $$('.view').forEach(v => v.classList.remove('active'));
  $('#view-' + name).classList.add('active');
  $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === name));

  if (name === 'today') renderToday();
  if (name === 'calendar') renderCalendar();
  if (name === 'weight') renderWeight();
  if (name === 'settings') renderSettings();
}

function showModal(id) {
  $('#' + id).classList.remove('hidden');
}
function hideModal(id) {
  $('#' + id).classList.add('hidden');
}
function closeModal(id) {
  hideModal(id);
}

/* ============================================================
   Init
   ============================================================ */

async function initUI() {
  bindNav();
  bindDayNav();
  bindAddFlow();
  bindNote();
  bindCalNav();
  bindWeight();
  bindSettings();
  await renderToday();
}

window.UI = { initUI, renderToday, renderCalendar, renderWeight, renderSettings, switchView, showToast };
