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
  editingFoodId: null,      // for edit-food modal
  parsedItems: []           // for quick-log parser results
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

  // Sugar trend (today + 7-day avg)
  await renderSugarTrend(date);
}

async function renderSugarTrend(currentDate) {
  const user = Sync.currentUser();
  if (!user) return;

  // Collect last 7 days of sugar totals from logged days
  const sugarByDate = new Map();
  const allMeals = await DB.allByIndex('meals', 'by_user', user.id);

  const baseDate = DB.parseYMD(currentDate);
  const last7 = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(baseDate);
    d.setDate(d.getDate() - i);
    last7.push(DB.ymd(d));
  }

  for (const ds of last7) {
    const meals = allMeals.filter(m => m.date === ds);
    if (meals.length === 0) continue; // unlogged days excluded
    let total = 0;
    let hadKnown = false;
    for (const m of meals) {
      if (m.sugar_g == null) continue;
      total += m.sugar_g * (m.servings || 1);
      hadKnown = true;
    }
    // Only include days with at least one known sugar value
    if (hadKnown || meals.length > 0) {
      sugarByDate.set(ds, total);
    }
  }

  // Today's value (separate read so it's accurate even if today has zero known sugar)
  const todayMeals = allMeals.filter(m => m.date === currentDate);
  let todayTotal = 0;
  for (const m of todayMeals) {
    if (m.sugar_g == null) continue;
    todayTotal += m.sugar_g * (m.servings || 1);
  }
  $('#sugar-today-val').textContent = `${Math.round(todayTotal)}g`;

  // Compute average across logged days, excluding today (so today vs. recent baseline)
  const past = [...sugarByDate.entries()].filter(([d]) => d !== currentDate);
  const arrowEl = $('#sugar-trend-arrow');
  const footnoteEl = $('#sugar-trend-footnote');

  if (past.length === 0) {
    $('#sugar-avg-val').textContent = '—';
    arrowEl.innerHTML = '';
    arrowEl.className = 'trend-arrow';
    footnoteEl.textContent = 'Not enough history yet.';
    return;
  }

  const avg = past.reduce((s, [, v]) => s + v, 0) / past.length;
  $('#sugar-avg-val').textContent = `${Math.round(avg)}g`;

  // Trend arrow: today vs avg
  const isToday = currentDate === DB.todayLocalDate();
  if (isToday && todayTotal > 0) {
    const delta = todayTotal - avg;
    const pct = avg > 0 ? Math.abs(delta) / avg : 0;
    if (pct < 0.10) {
      arrowEl.innerHTML = '<span class="arrow-symbol">→</span> in line with average';
      arrowEl.className = 'trend-arrow flat';
    } else if (delta > 0) {
      arrowEl.innerHTML = '<span class="arrow-symbol">↑</span> above average';
      arrowEl.className = 'trend-arrow up';
    } else {
      arrowEl.innerHTML = '<span class="arrow-symbol">↓</span> below average';
      arrowEl.className = 'trend-arrow down';
    }
  } else {
    arrowEl.innerHTML = '';
    arrowEl.className = 'trend-arrow';
  }

  footnoteEl.textContent = `Average based on ${past.length} logged ${past.length === 1 ? 'day' : 'days'}.`;
}

async function openSugarAttribution(date) {
  const user = Sync.currentUser();
  if (!user) return;
  const meals = (await DB.allByIndex('meals', 'by_date', date)).filter(m => m.user_id === user.id);

  // Build sorted list of contributors
  const contributors = meals.map(m => ({
    name: m.food_name,
    sugar: m.sugar_g == null ? null : m.sugar_g * (m.servings || 1),
    meal_type: m.meal_type
  }));

  // Separate known from unknown
  const known = contributors.filter(c => c.sugar != null && c.sugar > 0);
  known.sort((a, b) => b.sugar - a.sugar);
  const unknownCount = contributors.filter(c => c.sugar == null).length;
  const totalKnown = known.reduce((s, c) => s + c.sugar, 0);

  // Title — context for which day
  const todayStr = DB.todayLocalDate();
  let titleText = 'Sugar — Today';
  if (date !== todayStr) {
    const d = DB.parseYMD(date);
    titleText = 'Sugar — ' + d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  }
  $('#sugar-attr-title').textContent = titleText;
  $('#sugar-attr-total-val').textContent = `${Math.round(totalKnown)}g${unknownCount > 0 ? '*' : ''}`;

  // Build list
  const list = $('#sugar-attr-list');
  list.innerHTML = '';

  const max = known[0]?.sugar || 1;
  for (const c of known) {
    const li = document.createElement('li');
    li.className = 'sugar-attr-row';
    const pct = (c.sugar / max) * 100;
    li.innerHTML = `
      <div class="sugar-attr-info">
        <div class="sugar-attr-name">${escapeHTML(c.name)}</div>
        <div class="sugar-attr-meta">${capitalize(c.meal_type)}</div>
        <div class="sugar-attr-bar"><div class="sugar-attr-fill" style="width:${pct}%"></div></div>
      </div>
      <div class="sugar-attr-val">${Math.round(c.sugar * 10) / 10}g</div>
    `;
    list.appendChild(li);
  }

  const noteEl = $('#sugar-attr-note');
  if (unknownCount > 0) {
    noteEl.textContent = `${unknownCount} logged item${unknownCount === 1 ? '' : 's'} had no sugar value. Actual total may be higher.`;
    noteEl.classList.remove('hidden');
  } else {
    noteEl.classList.add('hidden');
  }

  showModal('modal-sugar');
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

  // Sugar attribution
  $('#sugar-tap').addEventListener('click', () => openSugarAttribution(STATE.currentDate));

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

  // Tab switching
  $$('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Quick log (parser)
  $('#quicklog-parse').addEventListener('click', runParse);
  $('#quicklog-save').addEventListener('click', saveParsedMeal);
  $('#quicklog-save-as-meal').addEventListener('click', showMealNamePrompt);
  $('#meal-prompt-cancel').addEventListener('click', hideMealNamePrompt);
  $('#meal-prompt-confirm').addEventListener('click', confirmSaveAsMeal);

  // Close handlers
  $$('[data-close]').forEach(el => {
    el.addEventListener('click', () => closeModal(el.dataset.close));
  });
}

function switchTab(name) {
  $$('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  $$('.tab-pane').forEach(p => p.classList.toggle('active', p.id === 'tab-' + name));
}

async function openAddModal(mealType) {
  STATE.pendingMealType = mealType;
  $('#modal-add-title').textContent = `Add to ${capitalize(mealType)}`;
  $('#food-search').value = '';

  // Reset to Search tab
  switchTab('search');

  // Reset Quick log tab
  $('#quicklog-input').value = '';
  $('#quicklog-status').textContent = '';
  $('#quicklog-status').classList.remove('error', 'working');
  $('#quicklog-results').classList.add('hidden');
  $('#quicklog-results').innerHTML = '';
  $('#quicklog-totals').classList.add('hidden');
  $('#meal-name-prompt').classList.add('hidden');
  STATE.parsedItems = [];

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
    ? all.filter(f => {
        const haystack = ((f.brand || '') + ' ' + f.name).toLowerCase();
        return haystack.includes(q);
      })
    : all;
  filtered.sort((a, b) => {
    const aLabel = (a.brand ? a.brand + ' ' : '') + a.name;
    const bLabel = (b.brand ? b.brand + ' ' : '') + b.name;
    return aLabel.localeCompare(bLabel);
  });

  const ul = $('#food-list');
  ul.innerHTML = '';
  for (const f of filtered) {
    const li = document.createElement('li');
    li.className = 'food-row';
    if (f.kind === 'system') li.classList.add('food-row-system');
    const label = f.brand ? `<span class="food-brand">${escapeHTML(f.brand)}</span> ${escapeHTML(f.name)}` : escapeHTML(f.name);
    li.innerHTML = `
      <div class="food-row-info">
        <div class="food-row-name">${label}</div>
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

/* ===== Parser (Quick log) ===== */

async function runParse() {
  const text = $('#quicklog-input').value.trim();
  if (!text) {
    setParseStatus('Type a meal first', 'error');
    return;
  }
  if (text.length > 800) {
    setParseStatus('Too long — try a shorter description', 'error');
    return;
  }

  setParseStatus('Parsing…', 'working');
  $('#quicklog-parse').disabled = true;
  $('#quicklog-results').classList.add('hidden');
  $('#quicklog-totals').classList.add('hidden');

  try {
    const result = await Parser.parseAndResolve(text);
    if (!result.items || result.items.length === 0) {
      setParseStatus('Nothing parseable — try again with quantities and items', 'error');
      $('#quicklog-parse').disabled = false;
      return;
    }
    STATE.parsedItems = result.items;
    renderParseResults();
    updateParseTotals();
    $('#quicklog-results').classList.remove('hidden');
    $('#quicklog-totals').classList.remove('hidden');
    setParseStatus('', '');
  } catch (e) {
    setParseStatus('Parser error: ' + (e.message || 'try again'), 'error');
  } finally {
    $('#quicklog-parse').disabled = false;
  }
}

function setParseStatus(msg, cls) {
  const el = $('#quicklog-status');
  el.textContent = msg;
  el.classList.remove('error', 'working');
  if (cls) el.classList.add(cls);
}

function renderParseResults() {
  const container = $('#quicklog-results');
  container.innerHTML = '';

  STATE.parsedItems.forEach((item, idx) => {
    const row = document.createElement('div');
    row.className = 'qresult-row';

    const macros = computeItemMacros(item);
    const sugarVal = macros.sugar_g == null ? '' : macros.sugar_g;

    row.innerHTML = `
      <div class="qresult-head">
        <div class="qresult-name">${escapeHTML(item.display_name)}</div>
        <span class="qresult-source source-${item.source}">${labelForSource(item.source)}</span>
      </div>
      <div class="qresult-controls">
        <input type="number" step="0.1" min="0" data-field="quantity" value="${item.original_quantity}" />
        <input type="text" data-field="unit" value="${escapeHTML(item.original_unit)}" />
        <span class="qresult-meta">${item.source === 'usda' && item.usda_match ? 'matched: ' + escapeHTML(item.usda_match.slice(0, 40)) : ''}</span>
      </div>
      <div class="qresult-macros">
        <div class="qmacro"><span class="qmacro-label">Cal</span><input class="qmacro-input" type="number" data-macro="calories" value="${macros.calories}" /></div>
        <div class="qmacro"><span class="qmacro-label">Pro</span><input class="qmacro-input" type="number" step="0.1" data-macro="protein_g" value="${macros.protein_g}" /></div>
        <div class="qmacro"><span class="qmacro-label">Carb</span><input class="qmacro-input" type="number" step="0.1" data-macro="carbs_g" value="${macros.carbs_g}" /></div>
        <div class="qmacro"><span class="qmacro-label">Fat</span><input class="qmacro-input" type="number" step="0.1" data-macro="fat_g" value="${macros.fat_g}" /></div>
        <div class="qmacro"><span class="qmacro-label">Sug</span><input class="qmacro-input" type="number" step="0.1" data-macro="sugar_g" value="${sugarVal}" placeholder="—" /></div>
      </div>
      ${item.note ? `<div class="qresult-note">${escapeHTML(item.note)}</div>` : ''}
      <div class="qresult-actions">
        <label>
          <input type="checkbox" data-save-lib ${item.source === 'ai' || item.source === 'usda' ? 'checked' : ''} />
          Save to food library
        </label>
        <button class="qresult-remove" data-remove>×</button>
      </div>
    `;

    // Wire up edits
    const qInput = row.querySelector('[data-field="quantity"]');
    const uInput = row.querySelector('[data-field="unit"]');
    qInput.addEventListener('input', () => {
      const newQty = parseFloat(qInput.value);
      if (!isNaN(newQty) && newQty > 0) {
        const ratio = newQty / item.original_quantity;
        item.original_quantity = newQty;
        // Scale macros from current displayed values
        row.querySelectorAll('[data-macro]').forEach(input => {
          const cur = parseFloat(input.value);
          if (!isNaN(cur)) {
            const macro = input.dataset.macro;
            const newVal = cur * ratio;
            input.value = macro === 'calories' ? Math.round(newVal) : Math.round(newVal * 10) / 10;
          }
        });
        updateParseTotals();
      }
    });
    uInput.addEventListener('input', () => { item.original_unit = uInput.value; });

    row.querySelectorAll('[data-macro]').forEach(input => {
      input.addEventListener('input', () => {
        item._user_overrides = item._user_overrides || {};
        const val = input.value === '' ? null : parseFloat(input.value);
        item._user_overrides[input.dataset.macro] = val;
        updateParseTotals();
      });
    });

    row.querySelector('[data-save-lib]').addEventListener('change', e => {
      item._save_to_library = e.target.checked;
    });
    // initialize from default-checked state
    item._save_to_library = row.querySelector('[data-save-lib]').checked;

    row.querySelector('[data-remove]').addEventListener('click', () => {
      STATE.parsedItems.splice(idx, 1);
      renderParseResults();
      updateParseTotals();
    });

    container.appendChild(row);
  });

  if (STATE.parsedItems.length === 0) {
    $('#quicklog-results').classList.add('hidden');
    $('#quicklog-totals').classList.add('hidden');
  }
}

function labelForSource(s) {
  return { library: 'Library', usda: 'USDA', ai: 'AI · check', failed: 'Failed' }[s] || s;
}

function computeItemMacros(item) {
  const base = item.base_macros || {};
  const servings = item.servings || 1;
  const m = item._user_overrides || {};
  const scale = (key) => {
    if (m[key] !== undefined) return m[key];
    const v = base[key];
    return v == null ? null : (v * servings);
  };
  const round = (v, p = 0) => v == null ? null : (p > 0 ? Math.round(v * 10) / 10 : Math.round(v));
  return {
    calories: round(scale('calories'), 0),
    protein_g: round(scale('protein_g'), 1),
    carbs_g: round(scale('carbs_g'), 1),
    fat_g: round(scale('fat_g'), 1),
    sugar_g: round(scale('sugar_g'), 1)
  };
}

function readItemMacrosFromInputs(rowEl) {
  const out = {};
  rowEl.querySelectorAll('[data-macro]').forEach(input => {
    const key = input.dataset.macro;
    if (input.value === '') {
      out[key] = key === 'sugar_g' ? null : 0;
    } else {
      out[key] = parseFloat(input.value) || 0;
    }
  });
  return out;
}

function updateParseTotals() {
  const container = $('#quicklog-results');
  let cal = 0, p = 0, sugar = 0, sugarUnknown = false;
  container.querySelectorAll('.qresult-row').forEach(row => {
    const m = readItemMacrosFromInputs(row);
    cal += m.calories || 0;
    p += m.protein_g || 0;
    if (m.sugar_g == null) sugarUnknown = true;
    else sugar += m.sugar_g;
  });
  $('#qtotal-cal').textContent = Math.round(cal);
  $('#qtotal-p').textContent = Math.round(p);
  $('#qtotal-sugar').textContent = Math.round(sugar);
  $('#qtotal-sugar-asterisk').classList.toggle('hidden', !sugarUnknown);
}

async function saveParsedMeal() {
  const rows = $('#quicklog-results').querySelectorAll('.qresult-row');
  if (rows.length === 0) return;

  const saveBtn = $('#quicklog-save');
  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving…';

  try {
    for (let i = 0; i < rows.length; i++) {
      const item = STATE.parsedItems[i];
      const macros = readItemMacrosFromInputs(rows[i]);

      // Optionally save to library
      let foodId = item.food_id;
      if (item._save_to_library && !foodId) {
        // Parse the brand+name from display_name
        const newFood = {
          id: DB.uuid(),
          name: item.original_item.name,
          brand: item.original_item.brand || null,
          serving_desc: `${item.original_quantity} ${item.original_unit}${item.original_item.prep ? ' ' + item.original_item.prep : ''}`,
          calories: macros.calories,
          protein_g: macros.protein_g,
          carbs_g: macros.carbs_g,
          fat_g: macros.fat_g,
          sugar_g: macros.sugar_g
        };
        await Sync.saveFood(newFood);
        foodId = newFood.id;
      }

      const meal = {
        id: DB.uuid(),
        date: STATE.currentDate,
        meal_type: STATE.pendingMealType,
        food_id: foodId,
        food_name: item.display_name,
        servings: 1, // already scaled at parse time
        calories: macros.calories,
        protein_g: macros.protein_g,
        carbs_g: macros.carbs_g,
        fat_g: macros.fat_g,
        sugar_g: macros.sugar_g
      };
      await Sync.saveMeal(meal);
    }

    hideModal('modal-add');
    renderToday();
    showToast(`${rows.length} item${rows.length === 1 ? '' : 's'} logged`);
  } catch (e) {
    showToast('Save failed — try again');
    console.warn(e);
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save items to log';
  }
}

/* ===== Save as meal & log ===== */

function showMealNamePrompt() {
  if (STATE.parsedItems.length === 0) {
    showToast('Nothing to save yet');
    return;
  }
  $('#meal-name-input').value = '';
  $('#meal-brand-input').value = 'Settel';
  $('#meal-name-prompt').classList.remove('hidden');
  setTimeout(() => $('#meal-name-input').focus(), 100);
}

function hideMealNamePrompt() {
  $('#meal-name-prompt').classList.add('hidden');
}

async function confirmSaveAsMeal() {
  const mealName = $('#meal-name-input').value.trim();
  const mealBrand = $('#meal-brand-input').value.trim();
  if (!mealName) {
    showToast('Name your meal first');
    $('#meal-name-input').focus();
    return;
  }

  const rows = $('#quicklog-results').querySelectorAll('.qresult-row');
  if (rows.length === 0) return;

  const btn = $('#meal-prompt-confirm');
  btn.disabled = true;
  btn.textContent = 'Saving…';

  try {
    // Sum macros across all parsed rows
    let totals = { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0, sugar_g: 0 };
    let sugarUnknown = false;
    const breakdownParts = [];

    rows.forEach((row, idx) => {
      const m = readItemMacrosFromInputs(row);
      totals.calories += m.calories || 0;
      totals.protein_g += m.protein_g || 0;
      totals.carbs_g += m.carbs_g || 0;
      totals.fat_g += m.fat_g || 0;
      if (m.sugar_g == null) sugarUnknown = true;
      else totals.sugar_g += m.sugar_g;

      const item = STATE.parsedItems[idx];
      if (item) {
        const qty = item.original_quantity;
        const unit = item.original_unit;
        const nm = item.original_item.brand
          ? `${item.original_item.brand} ${item.original_item.name}`
          : item.original_item.name;
        breakdownParts.push(`${qty}${unit} ${nm}`);
      }
    });

    // Round
    totals.calories = Math.round(totals.calories);
    totals.protein_g = Math.round(totals.protein_g * 10) / 10;
    totals.carbs_g = Math.round(totals.carbs_g * 10) / 10;
    totals.fat_g = Math.round(totals.fat_g * 10) / 10;
    const finalSugar = sugarUnknown ? null : Math.round(totals.sugar_g * 10) / 10;

    // Create the new food (the meal as a single library item)
    const newMeal = {
      id: DB.uuid(),
      brand: mealBrand || null,
      name: mealName,
      serving_desc: breakdownParts.join(', '),
      calories: totals.calories,
      protein_g: totals.protein_g,
      carbs_g: totals.carbs_g,
      fat_g: totals.fat_g,
      sugar_g: finalSugar
    };
    await Sync.saveFood(newMeal);

    // Log it as one entry under the current meal slot
    const displayName = mealBrand ? `${mealBrand} ${mealName}` : mealName;
    const logEntry = {
      id: DB.uuid(),
      date: STATE.currentDate,
      meal_type: STATE.pendingMealType,
      food_id: newMeal.id,
      food_name: displayName,
      servings: 1,
      calories: totals.calories,
      protein_g: totals.protein_g,
      carbs_g: totals.carbs_g,
      fat_g: totals.fat_g,
      sugar_g: finalSugar
    };
    await Sync.saveMeal(logEntry);

    hideMealNamePrompt();
    hideModal('modal-add');
    renderToday();
    showToast(`Saved & logged: ${displayName}`);
  } catch (e) {
    showToast('Save failed — try again');
    console.warn(e);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save & log';
  }
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

/* ============================================================
   HOUSEHOLD UI
   ============================================================ */

function bindHousehold() {
  $('#household-manage-btn').addEventListener('click', openHouseholdModal);

  $('#hh-name-save').addEventListener('click', async () => {
    const name = $('#hh-name-input').value.trim();
    if (!name) { showToast('Name cannot be empty'); return; }
    try {
      await Sync.renameHousehold(name);
      $('#household-name').textContent = name;
      showToast('Renamed');
    } catch (e) {
      showToast('Rename failed');
    }
  });

  $('#hh-invite-btn').addEventListener('click', async () => {
    const btn = $('#hh-invite-btn');
    btn.disabled = true;
    btn.textContent = 'Generating…';
    try {
      const { code, expires_at } = await Sync.createHouseholdInvite();
      $('#hh-invite-code').textContent = code;
      $('#hh-invite-display').classList.remove('hidden');
      _startInviteCountdown(new Date(expires_at));
    } catch (e) {
      showToast('Failed to generate invite');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Invite member';
    }
  });

  $('#hh-invite-copy').addEventListener('click', () => {
    const code = $('#hh-invite-code').textContent;
    navigator.clipboard?.writeText(code).then(() => showToast('Code copied'));
  });

  $('#hh-leave-btn').addEventListener('click', async () => {
    const hh = Sync.currentHousehold();
    const memberCount = hh?.members?.length || 1;
    const msg = memberCount > 1
      ? 'Leave this household? You\'ll be moved to a new solo household.'
      : 'You\'re the only member. Leaving will delete the household.';
    if (!confirm(msg)) return;
    try {
      await Sync.leaveHousehold();
      hideModal('modal-household');
      renderSettings();
      showToast('Left household');
    } catch (e) {
      showToast('Failed to leave: ' + (e.message || 'try again'));
    }
  });

  $('#hh-join-different-btn').addEventListener('click', () => {
    hideModal('modal-household');
    openJoinHouseholdModal();
  });

  // Join flow
  $('#join-code-input').addEventListener('input', _onJoinCodeInput);
  $('#join-confirm-btn').addEventListener('click', _onJoinConfirm);

  // Welcome modal
  const welcomeBtn = $('#welcome-dismiss-btn');
  if (welcomeBtn) {
    welcomeBtn.addEventListener('click', () => hideModal('modal-welcome'));
  }
}

let _inviteCountdownTimer = null;

function _startInviteCountdown(expiresAt) {
  if (_inviteCountdownTimer) clearInterval(_inviteCountdownTimer);
  const el = $('#hh-invite-countdown');
  const update = () => {
    const secsLeft = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
    const m = Math.floor(secsLeft / 60);
    const s = secsLeft % 60;
    el.textContent = `Expires in ${m}:${String(s).padStart(2, '0')}`;
    if (secsLeft === 0) {
      clearInterval(_inviteCountdownTimer);
      el.textContent = 'Expired';
    }
  };
  update();
  _inviteCountdownTimer = setInterval(update, 1000);
}

async function openHouseholdModal() {
  const hh = Sync.currentHousehold();
  $('#hh-name-input').value = hh?.name || '';
  $('#hh-invite-display').classList.add('hidden');
  $('#hh-invite-code').textContent = '——————';
  if (_inviteCountdownTimer) { clearInterval(_inviteCountdownTimer); _inviteCountdownTimer = null; }

  _renderHouseholdMembers(hh);
  showModal('modal-household');
}

function _renderHouseholdMembers(hh) {
  const ul = $('#hh-members-list');
  ul.innerHTML = '';
  if (!hh) return;

  const me = Sync.currentUser();
  const isOwner = hh.myRole === 'owner';

  for (const m of (hh.members || [])) {
    const li = document.createElement('li');
    li.className = 'hh-member-row';
    const isSelf = m.user_id === me?.id;
    let label;
    if (isSelf) {
      label = (me.email || m.email || 'You') + ' (you)';
    } else {
      label = m.email || m.display_name || `Member ···${m.user_id.slice(-8)}`;
    }
    const roleTag = m.role === 'owner' ? '<span class="member-role-tag">owner</span>' : '';

    li.innerHTML = `
      <div class="member-info">
        <div class="member-label">${escapeHTML(label)} ${roleTag}</div>
      </div>
    `;

    if (isOwner && !isSelf) {
      const removeBtn = document.createElement('button');
      removeBtn.className = 'btn-text danger member-remove-btn';
      removeBtn.textContent = 'Remove';
      removeBtn.addEventListener('click', async () => {
        if (!confirm('Remove this member from your household?')) return;
        try {
          await Sync.removeMember(m.user_id);
          const updated = Sync.currentHousehold();
          _renderHouseholdMembers(updated);
          showToast('Member removed');
        } catch (e) {
          showToast('Failed to remove member');
        }
      });
      li.appendChild(removeBtn);
    }
    ul.appendChild(li);
  }
}

let _joinLookupTimer = null;
let _joinLookupResult = null;

function openJoinHouseholdModal() {
  $('#join-code-input').value = '';
  $('#join-code-status').textContent = '';
  $('#join-code-status').className = 'join-code-status';
  $('#join-confirm-box').classList.add('hidden');
  _joinLookupResult = null;
  showModal('modal-join-household');
  setTimeout(() => $('#join-code-input').focus(), 150);
}

async function _onJoinCodeInput() {
  const code = $('#join-code-input').value.replace(/\D/g, '').slice(0, 6);
  $('#join-code-input').value = code;

  const statusEl = $('#join-code-status');
  $('#join-confirm-box').classList.add('hidden');
  _joinLookupResult = null;

  if (code.length < 6) {
    statusEl.textContent = '';
    return;
  }

  statusEl.textContent = 'Looking up…';
  statusEl.className = 'join-code-status';

  try {
    const result = await Sync.lookupInviteCode(code);
    _joinLookupResult = result;
    const memberWord = result.member_count === 1 ? 'member' : 'members';
    $('#join-confirm-text').textContent =
      `You're joining "${result.household_name}" (${result.member_count} ${memberWord}). Continue?`;
    $('#join-confirm-box').classList.remove('hidden');
    statusEl.textContent = '';
  } catch (e) {
    statusEl.textContent = e.message || 'Invalid code.';
    statusEl.className = 'join-code-status error';
  }
}

async function _onJoinConfirm() {
  if (!_joinLookupResult) return;
  const code = $('#join-code-input').value;
  const btn = $('#join-confirm-btn');
  btn.disabled = true;
  btn.textContent = 'Joining…';
  try {
    await Sync.acceptInvite(code);
    hideModal('modal-join-household');
    renderSettings();
    showToast('Joined household');
  } catch (e) {
    showToast(e.message || 'Failed to join — try again');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Join household';
  }
}

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

  $('#export-log-btn').addEventListener('click', exportLog);
  $('#export-all-btn').addEventListener('click', exportAll);
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

  const hh = Sync.currentHousehold();
  $('#household-name').textContent = hh?.name || '—';
  const members = hh?.members || [];
  const count = members.length;
  $('#household-members-preview').textContent =
    count === 1 ? '1 member (just you)' : `${count} members`;
}

function _buildFoodRow(f, clickable = true) {
  const li = document.createElement('li');
  li.className = 'food-row';
  if (f.kind === 'system') li.classList.add('food-row-system');
  const label = f.brand
    ? `<span class="food-brand">${escapeHTML(f.brand)}</span> ${escapeHTML(f.name)}`
    : escapeHTML(f.name);
  li.innerHTML = `
    <div class="food-row-info">
      <div class="food-row-name">${label}</div>
      <div class="food-row-meta">${escapeHTML(f.serving_desc || '')} · ${f.calories} cal</div>
    </div>
  `;
  if (clickable) li.addEventListener('click', () => openEditFood(f.id));
  return li;
}

async function openManageFoods() {
  const all = await DB.all('foods');
  const admin = Sync.isAdmin();

  const household = all.filter(f => f.kind !== 'system');
  const system = all.filter(f => f.kind === 'system');

  const sort = arr => arr.sort((a, b) => {
    const aLabel = (a.brand ? a.brand + ' ' : '') + a.name;
    const bLabel = (b.brand ? b.brand + ' ' : '') + b.name;
    return aLabel.localeCompare(bLabel);
  });

  const ul = $('#food-manage-list');
  ul.innerHTML = '';
  for (const f of sort(household)) ul.appendChild(_buildFoodRow(f));

  // Admin: show system foods section
  const adminSection = $('#admin-system-section');
  if (admin) {
    adminSection.classList.remove('hidden');
    const sysUl = $('#system-food-manage-list');
    sysUl.innerHTML = '';
    for (const f of sort(system)) sysUl.appendChild(_buildFoodRow(f));
  } else {
    adminSection.classList.add('hidden');
  }

  showModal('modal-foods');
}

async function openEditFood(id) {
  STATE.editingFoodId = id;
  const admin = Sync.isAdmin();
  const adminSection = $('#ef-admin-section');

  if (id) {
    const f = await DB.get('foods', id);
    if (!f) return;

    // Non-admins cannot edit system foods
    if (f.kind === 'system' && !admin) return;

    $('#edit-food-title').textContent = 'Edit food';
    $('#ef-brand').value = f.brand || '';
    $('#ef-name').value = f.name;
    $('#ef-serving-desc').value = f.serving_desc || '';
    $('#ef-cal').value = f.calories;
    $('#ef-protein').value = f.protein_g;
    $('#ef-carbs').value = f.carbs_g;
    $('#ef-fat').value = f.fat_g;
    $('#ef-sugar').value = f.sugar_g == null ? '' : f.sugar_g;
    $('#ef-delete').classList.remove('hidden');

    if (admin) {
      adminSection.classList.remove('hidden');
      $('#ef-publish-system').checked = f.kind === 'system';
    } else {
      adminSection.classList.add('hidden');
    }
  } else {
    $('#edit-food-title').textContent = 'New food';
    ['ef-brand', 'ef-name', 'ef-serving-desc', 'ef-cal', 'ef-protein', 'ef-carbs', 'ef-fat', 'ef-sugar'].forEach(i => $('#' + i).value = '');
    $('#ef-delete').classList.add('hidden');

    if (admin) {
      adminSection.classList.remove('hidden');
      $('#ef-publish-system').checked = false;
    } else {
      adminSection.classList.add('hidden');
    }
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
  const brand = $('#ef-brand').value.trim();
  const admin = Sync.isAdmin();
  const publishAsSystem = admin && $('#ef-publish-system').checked;

  const food = {
    id: STATE.editingFoodId || DB.uuid(),
    brand: brand || null,
    name,
    serving_desc: $('#ef-serving-desc').value.trim(),
    calories: num('ef-cal'),
    protein_g: num('ef-protein'),
    carbs_g: num('ef-carbs'),
    fat_g: num('ef-fat'),
    sugar_g: sugarRaw === '' ? null : parseFloat(sugarRaw),
    kind: publishAsSystem ? 'system' : 'household'
  };

  await Sync.saveFood(food);
  hideModal('modal-edit-food');
  STATE.editingFoodId = null;
  showToast('Saved');
  openManageFoods();
}

async function deleteEditFood() {
  if (!STATE.editingFoodId) return;
  if (!confirm('Delete this food? It will be removed from the food library.')) return;
  await Sync.deleteFood(STATE.editingFoodId);
  hideModal('modal-edit-food');
  STATE.editingFoodId = null;
  showToast('Deleted');
  openManageFoods();
}

async function exportLog() {
  await exportData(false);
}

async function exportAll() {
  await exportData(true);
}

async function exportData(includeFoods) {
  const user = Sync.currentUser();
  if (!user) return;
  const meals = (await DB.all('meals')).filter(m => m.user_id === user.id);
  const weights = (await DB.all('weights')).filter(w => w.user_id === user.id);
  const notes = (await DB.all('notes')).filter(n => n.user_id === user.id);
  const targets = await DB.get('targets', user.id);

  const payload = {
    exported_at: new Date().toISOString(),
    user_email: user.email,
    export_kind: includeFoods ? 'full' : 'log',
    targets,
    meals,
    weights,
    notes
  };
  if (includeFoods) {
    payload.foods = await DB.all('foods');
  }

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const kind = includeFoods ? 'full' : 'log';
  a.download = `daily-log-${kind}-${DB.todayLocalDate()}.json`;
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

let _uiInitialized = false;

async function initUI() {
  if (!_uiInitialized) {
    bindNav();
    bindDayNav();
    bindAddFlow();
    bindNote();
    bindCalNav();
    bindWeight();
    bindSettings();
    bindHousehold();
    _uiInitialized = true;
  }
  await renderToday();
}

window.UI = { initUI, renderToday, renderCalendar, renderWeight, renderSettings, switchView, showToast };
