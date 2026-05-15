/* ============================================================
   parser.js — natural-language meal parsing
   ============================================================
   Flow per parse:
     1. Send the user's text to the Netlify parse-meal function
     2. Get back a list of ingredients (name, brand, qty, unit, prep)
     3. For each ingredient, resolve macros in this order:
        a. Match in user's food library (Supabase foods table)
        b. Match in USDA FoodData Central API (free, no key)
        c. Fallback: ask the AI to estimate (low-confidence flag)
     4. Scale macros to the user's quantity
     5. Return enriched list for editing/saving in the UI
   ============================================================ */

const PARSE_ENDPOINT = '/.netlify/functions/parse-meal';
const USDA_ENDPOINT = 'https://api.nal.usda.gov/fdc/v1/foods/search';
// DEMO_KEY works for low-volume use without registering. For higher
// volume, sign up for a free USDA API key and replace below.
const USDA_API_KEY = 'DEMO_KEY';

/* ===== unit conversion ===== */

// Generic mass and volume conversions to a canonical reference.
// For mass, canonical = grams.
// For volume, canonical = milliliters.
// We never directly convert mass <-> volume without food-specific density.

const MASS_TO_G = {
  g: 1, gram: 1, grams: 1,
  kg: 1000, kilogram: 1000, kilograms: 1000,
  oz: 28.3495, ounce: 28.3495, ounces: 28.3495,
  lb: 453.592, lbs: 453.592, pound: 453.592, pounds: 453.592,
};

const VOLUME_TO_ML = {
  ml: 1, milliliter: 1, milliliters: 1,
  l: 1000, liter: 1000, liters: 1000,
  tsp: 4.92892, teaspoon: 4.92892, teaspoons: 4.92892,
  tbsp: 14.7868, tablespoon: 14.7868, tablespoons: 14.7868,
  fl_oz: 29.5735, 'fl oz': 29.5735, floz: 29.5735,
  cup: 236.588, cups: 236.588,
};

// Items where "1 of the unit" means a specific count, not mass/volume
const COUNT_UNITS = new Set(['count', 'piece', 'pieces', 'slice', 'slices', 'serving', 'servings']);

function normalizeUnit(u) {
  if (!u) return null;
  return u.toLowerCase().replace(/\s+/g, '_').replace(/\.$/, '');
}

function isMass(u) { return MASS_TO_G[u] != null; }
function isVolume(u) { return VOLUME_TO_ML[u] != null; }
function isCount(u) { return COUNT_UNITS.has(u); }

/* ===== Step 1: send text to the parser endpoint ===== */

async function parseText(text) {
  const res = await fetch(PARSE_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'parse', text })
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Parser failed: ${err}`);
  }
  return res.json();
}

async function estimateMacros(item) {
  const res = await fetch(PARSE_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'estimate', item })
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Estimator failed: ${err}`);
  }
  return res.json();
}

/* ===== Step 2: library lookup ===== */

async function findInLibrary(item) {
  const allFoods = await DB.all('foods');
  if (!allFoods || allFoods.length === 0) return null;

  const nameLower = item.name.toLowerCase();
  const brandLower = item.brand ? item.brand.toLowerCase() : null;

  // Tier 1: exact brand + name match (substring on name)
  if (brandLower) {
    const exact = allFoods.find(f =>
      f.brand && f.brand.toLowerCase() === brandLower &&
      f.name.toLowerCase().includes(nameLower)
    );
    if (exact) return exact;

    // Tier 2: brand match, fuzzier name
    const brandFuzzy = allFoods.find(f =>
      f.brand && f.brand.toLowerCase() === brandLower &&
      tokenOverlap(f.name.toLowerCase(), nameLower) >= 1
    );
    if (brandFuzzy) return brandFuzzy;
  }

  // Tier 3: name-only exact (case-insensitive)
  const nameExact = allFoods.find(f =>
    !f.brand &&
    f.name.toLowerCase() === nameLower
  );
  if (nameExact) return nameExact;

  // Tier 4: name-only substring (only consider unbranded matches to avoid
  // accidentally pulling a different brand's macros)
  const nameSub = allFoods.find(f =>
    !f.brand &&
    (f.name.toLowerCase().includes(nameLower) || nameLower.includes(f.name.toLowerCase()))
  );
  if (nameSub) return nameSub;

  return null;
}

function tokenOverlap(a, b) {
  const ta = new Set(a.split(/\s+/));
  const tb = new Set(b.split(/\s+/));
  let count = 0;
  for (const t of ta) if (tb.has(t)) count++;
  return count;
}

/* ===== Step 3: USDA lookup ===== */

async function findInUSDA(item) {
  // Build a search query — USDA's search is quite forgiving
  const query = item.brand ? `${item.brand} ${item.name}` : item.name;
  // Include Branded data type so we can find brand-specific entries when user gave a brand
  const dataTypes = item.brand
    ? 'Branded,Foundation,SR%20Legacy,Survey%20(FNDDS)'
    : 'Foundation,SR%20Legacy,Survey%20(FNDDS)';
  const url = `${USDA_ENDPOINT}?api_key=${USDA_API_KEY}&query=${encodeURIComponent(query)}&pageSize=10&dataType=${dataTypes}`;

  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.foods || data.foods.length === 0) return null;

    // Score each candidate and pick the best confident match
    const scored = data.foods.map(f => ({
      food: f,
      score: scoreUSDAMatch(f, item)
    })).filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score);

    if (scored.length === 0) return null;

    // Require a meaningful score — if best candidate is weak, fall through to AI
    // Try candidates in score order, skipping any that fail to parse
    for (const { score, food } of scored) {
      if (score < 2) break;
      const parsed = parseUSDAFood(food, item);
      if (parsed) return parsed;
    }
    return null;
  } catch (e) {
    console.warn('USDA lookup error:', e);
    return null;
  }
}

/* Score a USDA candidate against the user's item.
   - Brand match (when user supplied brand) is essential.
   - Name token overlap adds confidence.
   - Penalize wildly-different categories. */
function scoreUSDAMatch(usdaFood, item) {
  const desc = (usdaFood.description || '').toLowerCase();
  const brandOwner = (usdaFood.brandOwner || '').toLowerCase();
  const brandName = (usdaFood.brandName || '').toLowerCase();
  const userName = (item.name || '').toLowerCase();
  const userBrand = (item.brand || '').toLowerCase();

  let score = 0;

  // Hard requirement: if user specified a brand, the USDA item must reference it
  if (userBrand) {
    const brandText = brandOwner + ' ' + brandName + ' ' + desc;
    if (!brandText.includes(userBrand)) {
      return 0; // strict reject
    }
    score += 3;
  }

  // Name token overlap — count meaningful shared words
  const userTokens = tokenize(userName);
  const descTokens = tokenize(desc);
  let overlap = 0;
  for (const t of userTokens) {
    if (descTokens.has(t)) overlap++;
  }
  // Require at least one meaningful overlap (so "pasta" doesn't match "sauce")
  if (overlap === 0 && userBrand === '') return 0;
  score += overlap * 2;

  // Penalize obvious wrong categories
  // If user said "sauce" but USDA item doesn't mention sauce/dressing/condiment...
  const userIsSauce = /sauce|dressing|marinade|condiment/.test(userName);
  const descIsSauce = /sauce|dressing|marinade|condiment|salsa|ketchup|mayo/.test(desc);
  if (userIsSauce !== descIsSauce) score -= 2;

  // Cooked/raw mismatches (rough heuristic)
  if (item.prep === 'cooked' && /raw|uncooked/.test(desc)) score -= 1;
  if (item.prep === 'raw' && /cooked/.test(desc)) score -= 1;

  return score;
}

const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'with', 'and', 'or', 'in', 'on']);
function tokenize(s) {
  return new Set(
    s.toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 2 && !STOPWORDS.has(t))
  );
}

function parseUSDAFood(usdaFood, originalItem) {
  // USDA nutrients use specific IDs — find by nutrientNumber
  // For Foundation/SR Legacy/FNDDS: values are per 100g
  // For Branded: foodNutrients are also per 100g (normalized), but labelNutrients are per serving
  const nutrients = {};
  for (const n of (usdaFood.foodNutrients || [])) {
    const num = n.nutrientNumber || (n.nutrient && n.nutrient.number);
    const val = n.value != null ? n.value : (n.amount != null ? n.amount : null);
    if (num != null && val != null) {
      nutrients[num] = val;
    }
  }

  // Standard nutrient numbers:
  //   208 - Energy (kcal)
  //   203 - Protein
  //   204 - Total fat
  //   205 - Carbs
  //   269 - Total sugars
  // Some Branded entries also use 1008/1003/1004/1005/2000 — fall back if needed
  const getNutrient = (...keys) => {
    for (const k of keys) {
      if (nutrients[k] != null) return nutrients[k];
    }
    return null;
  };

  const per100g = {
    calories: getNutrient('208', '1008') || 0,
    protein_g: getNutrient('203', '1003') || 0,
    fat_g: getNutrient('204', '1004') || 0,
    carbs_g: getNutrient('205', '1005') || 0,
    sugar_g: getNutrient('269', '2000')
  };

  // Sanity: if calories are 0 but other values aren't, the data is in a weird state
  if (per100g.calories === 0 && per100g.protein_g === 0 && per100g.carbs_g === 0 && per100g.fat_g === 0) {
    return null;
  }

  return {
    source: 'usda',
    name: usdaFood.description || originalItem.name,
    brand: usdaFood.brandOwner || usdaFood.brandName || null,
    fdc_id: usdaFood.fdcId,
    per100g
  };
}

/* ===== Step 4: macro scaling ===== */

// Approximate densities (g per ml) for common foods.
// Used when user specifies a volume unit (cup, tbsp) but USDA data is per 100g.
// This is intentionally a small table — we cover the common cases and otherwise
// flag the result as approximate.
const FOOD_DENSITY_G_PER_ML = {
  // grains / starches (cooked)
  rice: 0.78, pasta: 0.95, oatmeal: 0.93, quinoa: 0.7,
  // sauces / liquids
  sauce: 1.0, oil: 0.92, milk: 1.03, water: 1.0, juice: 1.04,
  // dry / loose
  flour: 0.55, sugar: 0.85, salt: 1.2, nuts: 0.6, pistachios: 0.6,
  almonds: 0.6, walnuts: 0.5, peanuts: 0.6,
  // produce (chunked)
  berries: 0.6, grapes: 0.6,
  // dairy
  yogurt: 1.04, butter: 0.91, cheese: 1.05,
};

function approxDensity(name) {
  const lower = name.toLowerCase();
  for (const key of Object.keys(FOOD_DENSITY_G_PER_ML)) {
    if (lower.includes(key)) return FOOD_DENSITY_G_PER_ML[key];
  }
  return null;
}

// Convert the user's quantity into grams (when we have per-100g macros)
function quantityToGrams(item) {
  const unit = normalizeUnit(item.unit);
  const qty = item.quantity;

  if (isMass(unit)) {
    return { grams: qty * MASS_TO_G[unit], approx: false };
  }

  if (isVolume(unit)) {
    const ml = qty * VOLUME_TO_ML[unit];
    const density = approxDensity(item.name);
    if (density != null) {
      return { grams: ml * density, approx: true };
    }
    // Default density of 1.0 g/ml if we don't have a better number
    return { grams: ml, approx: true };
  }

  // Counted items: we can't convert without per-piece data.
  // Return null and let the caller use serving-based math instead.
  return null;
}

function scaleMacros(per100g, grams) {
  const factor = grams / 100;
  return {
    calories: Math.round(per100g.calories * factor),
    protein_g: Math.round(per100g.protein_g * factor * 10) / 10,
    carbs_g: Math.round(per100g.carbs_g * factor * 10) / 10,
    fat_g: Math.round(per100g.fat_g * factor * 10) / 10,
    sugar_g: per100g.sugar_g == null ? null : Math.round(per100g.sugar_g * factor * 10) / 10
  };
}

/* ===== Step 5: resolve a single ingredient ===== */

async function resolveItem(item) {
  // Library first
  const libMatch = await findInLibrary(item);
  if (libMatch) {
    // Library entries store macros per their own serving_desc — we use them as-is
    // for the quantity the user gave, scaling by servings.
    // This means: if user said "1 cup" and library has "1 cup cooked, 205 cal",
    // we use 205 cal. If user said "2 cups", we use 410 cal.
    // The library's serving unit should match the user's typical unit.
    return {
      source: 'library',
      food_id: libMatch.id,
      display_name: libMatch.brand ? `${libMatch.brand} ${libMatch.name}` : libMatch.name,
      servings: estimateServings(item, libMatch),
      base_macros: {
        calories: libMatch.calories,
        protein_g: libMatch.protein_g,
        carbs_g: libMatch.carbs_g,
        fat_g: libMatch.fat_g,
        sugar_g: libMatch.sugar_g
      },
      confidence: 'high',
      original_quantity: item.quantity,
      original_unit: item.unit
    };
  }

  // USDA next
  const usda = await findInUSDA(item);
  if (usda) {
    const massInfo = quantityToGrams(item);
    if (massInfo) {
      const scaled = scaleMacros(usda.per100g, massInfo.grams);
      return {
        source: 'usda',
        food_id: null,
        display_name: item.brand ? `${item.brand} ${item.name}` : item.name,
        servings: 1, // already scaled to the requested quantity
        base_macros: scaled,
        confidence: massInfo.approx ? 'medium' : 'high',
        original_quantity: item.quantity,
        original_unit: item.unit,
        usda_match: usda.name,
        note: massInfo.approx ? 'volume converted via density estimate' : null
      };
    }
    // Count units fall through to AI estimate (USDA can't help us per-piece reliably)
  }

  // AI estimate (last resort)
  const est = await estimateMacros(item);
  return {
    source: 'ai',
    food_id: null,
    display_name: item.brand ? `${item.brand} ${item.name}` : item.name,
    servings: 1,
    base_macros: {
      calories: est.calories,
      protein_g: est.protein_g,
      carbs_g: est.carbs_g,
      fat_g: est.fat_g,
      sugar_g: est.sugar_g
    },
    confidence: est.confidence,
    original_quantity: item.quantity,
    original_unit: item.unit,
    note: est.notes
  };
}

function estimateServings(item, libMatch) {
  // Library items have a serving_desc like "1 cup cooked" or "4 oz" — we try
  // to extract a number+unit and figure out how many of those servings the
  // user's quantity equals.
  if (!libMatch.serving_desc) return 1;
  const m = libMatch.serving_desc.match(/([\d.\/]+)\s*([a-zA-Z]+)/);
  if (!m) return 1;
  const baseQty = parseFraction(m[1]);
  const baseUnit = normalizeUnit(m[2]);
  const userUnit = normalizeUnit(item.unit);
  if (!baseQty) return 1;

  // Same unit family → straight ratio
  if (baseUnit === userUnit) return item.quantity / baseQty;
  if (isMass(baseUnit) && isMass(userUnit)) {
    const baseG = baseQty * MASS_TO_G[baseUnit];
    const userG = item.quantity * MASS_TO_G[userUnit];
    return userG / baseG;
  }
  if (isVolume(baseUnit) && isVolume(userUnit)) {
    const baseMl = baseQty * VOLUME_TO_ML[baseUnit];
    const userMl = item.quantity * VOLUME_TO_ML[userUnit];
    return userMl / baseMl;
  }
  return 1;
}

function parseFraction(s) {
  if (!s) return null;
  if (s.includes('/')) {
    const [n, d] = s.split('/').map(Number);
    return d ? n / d : null;
  }
  return Number(s) || null;
}

/* ===== Main entry: parse and resolve everything ===== */

async function parseAndResolve(text) {
  const parsed = await parseText(text);
  if (!parsed.items || parsed.items.length === 0) {
    return { items: [] };
  }

  // Resolve items in parallel
  const resolved = await Promise.all(
    parsed.items.map(async item => {
      try {
        const r = await resolveItem(item);
        return { ...r, ok: true, original_item: item };
      } catch (e) {
        return {
          ok: false,
          error: e.message || 'Resolution failed',
          original_item: item,
          display_name: item.brand ? `${item.brand} ${item.name}` : item.name,
          source: 'failed',
          confidence: 'low',
          base_macros: { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0, sugar_g: null },
          servings: 1,
          original_quantity: item.quantity,
          original_unit: item.unit
        };
      }
    })
  );

  return { items: resolved };
}

window.Parser = {
  parseAndResolve,
  // exposed for debugging
  _internals: { parseText, findInLibrary, findInUSDA, resolveItem, quantityToGrams, scaleMacros }
};
