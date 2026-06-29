/* ============================================================
   parse-meal.js — Netlify Function
   ============================================================
   POST endpoint that takes a natural-language meal description
   and returns a structured ingredient list.
   
   It does NOT estimate macros — that's done by the frontend
   using the user's food library + USDA + (for unknowns) a 
   second AI call via this function's "estimate" mode.
   
   Env vars required:
     ANTHROPIC_API_KEY — set in Netlify dashboard → Site → 
                         Environment variables
   ============================================================ */

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';

exports.handler = async function (event, context) {
  // CORS for browser calls
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders, body: 'Method not allowed' };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured on the server.' })
    };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Invalid JSON in request body.' })
    };
  }

  const mode = body.mode || 'parse';

  try {
    let result;
    if (mode === 'parse') {
      result = await parseMeal(body.text, apiKey);
    } else if (mode === 'estimate') {
      result = await estimateMacros(body.item, apiKey);
    } else {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'Unknown mode. Use "parse" or "estimate".' })
      };
    }

    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify(result)
    };
  } catch (err) {
    console.error('Function error:', err);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: err.message || 'Internal error' })
    };
  }
};

/* ============================================================
   parseMeal — break a natural language meal into ingredients
   ============================================================ */

async function parseMeal(text, apiKey) {
  if (!text || typeof text !== 'string' || text.length > 1000) {
    throw new Error('Invalid or oversized text input.');
  }

  const systemPrompt = `You parse natural-language food/meal descriptions into structured ingredient lists.

Output ONLY valid JSON. No prose, no markdown, no code fences. Just a JSON object.

Schema:
{
  "items": [
    {
      "name": "lowercase common name of the ingredient, no brand",
      "brand": "brand name if mentioned, otherwise null",
      "quantity": number,
      "unit": "g" | "oz" | "lb" | "kg" | "ml" | "fl_oz" | "cup" | "tbsp" | "tsp" | "slice" | "piece" | "count" | "serving",
      "prep": "cooked" | "raw" | "dry" | "uncooked" | null
    }
  ]
}

Rules:
- ALWAYS break compound DISHES (multiple distinct foods served together) into individual ingredients. "Spaghetti with Rao's sauce and beef" → 3 items.
- But a compound PRODUCT NAME is a SINGLE ingredient — do NOT split its modifier words into separate items. "honey walnut cream cheese" is ONE item (name: "honey walnut cream cheese"), not "honey" + "walnut" + "cream cheese". Same for "brown sugar cinnamon oatmeal", "roasted garlic hummus", "sea salt caramel gelato". Only split when the user clearly describes separate foods (e.g. "eggs and bacon", "rice with chicken").
- Extract brand names when present (e.g. "Rao's", "Graziano", "Chobani"). Brand should NOT appear in the name field — only in the brand field.
- The name field is generic ("tomato basil sauce" not "Rao's tomato basil sauce").
- For prep state: if user says "cooked", note that. If they say "raw" or "dry" or "uncooked", note that. Otherwise null.
- For quantities: convert fractions to decimals (1/4 → 0.25, 1/2 → 0.5).
- Default unit for countable items (eggs, slices of bread, apples): "count".
- If a user says "1 cup of pasta" without specifying cooked vs dry, assume cooked. If they say "1 cup pasta cooked", set prep="cooked".
- For sauces/dressings/condiments: use tbsp or fl_oz when small amounts, oz when larger.
- Do NOT add items the user didn't mention. Do NOT estimate or guess macros.
- If the input is gibberish or contains no food, return {"items": []}.

Examples:

Input: "6oz cooked Rao's pasta with 4oz Graziano sausage and 4oz Rao's tomato basil sauce. 1 cup purple grapes. 1/4 cup pistachios"
Output:
{"items":[
  {"name":"pasta","brand":"Rao's","quantity":6,"unit":"oz","prep":"cooked"},
  {"name":"sausage","brand":"Graziano","quantity":4,"unit":"oz","prep":null},
  {"name":"tomato basil sauce","brand":"Rao's","quantity":4,"unit":"oz","prep":null},
  {"name":"purple grapes","brand":null,"quantity":1,"unit":"cup","prep":null},
  {"name":"pistachios","brand":null,"quantity":0.25,"unit":"cup","prep":null}
]}

Input: "2 tbsp Philadelphia honey walnut cream cheese on a bagel"
Output:
{"items":[
  {"name":"honey walnut cream cheese","brand":"Philadelphia","quantity":2,"unit":"tbsp","prep":null},
  {"name":"bagel","brand":null,"quantity":1,"unit":"count","prep":null}
]}

Input: "Two eggs scrambled and 3 strips of bacon"
Output:
{"items":[
  {"name":"eggs","brand":null,"quantity":2,"unit":"count","prep":null},
  {"name":"bacon","brand":null,"quantity":3,"unit":"slice","prep":null}
]}

Input: "Cheeseburger fries and a beer"
Output:
{"items":[
  {"name":"cheeseburger","brand":null,"quantity":1,"unit":"count","prep":null},
  {"name":"fries","brand":null,"quantity":1,"unit":"serving","prep":null},
  {"name":"beer","brand":null,"quantity":1,"unit":"serving","prep":null}
]}`;

  const response = await callAnthropic({
    apiKey,
    system: systemPrompt,
    userMessage: text,
    maxTokens: 800
  });

  const parsed = extractJSON(response);
  if (!parsed || !Array.isArray(parsed.items)) {
    throw new Error('Parser returned malformed output.');
  }

  // Sanity-check each item
  parsed.items = parsed.items.filter(it => 
    it && typeof it.name === 'string' && it.name.length > 0 &&
    typeof it.quantity === 'number' && it.quantity > 0 &&
    typeof it.unit === 'string'
  ).map(it => ({
    name: it.name.trim().toLowerCase(),
    brand: it.brand ? String(it.brand).trim() : null,
    quantity: Number(it.quantity),
    unit: it.unit.trim(),
    prep: it.prep || null
  }));

  return parsed;
}

/* ============================================================
   estimateMacros — fallback for items not found in lib or USDA
   ============================================================ */

async function estimateMacros(item, apiKey) {
  if (!item || !item.name) {
    throw new Error('Invalid item for estimation.');
  }

  const brandPart = item.brand ? `${item.brand} ` : '';
  const prepPart = item.prep ? ` (${item.prep})` : '';
  const fullDesc = `${brandPart}${item.name}${prepPart}, ${item.quantity} ${item.unit}`;

  const systemPrompt = `You estimate nutrition information for foods. You are aware your estimates may be imprecise — that is acceptable for this use case.

Output ONLY valid JSON. No prose, no markdown.

Schema:
{
  "calories": number,
  "protein_g": number,
  "carbs_g": number,
  "fat_g": number,
  "sugar_g": number,
  "sodium_mg": number,
  "confidence": "high" | "medium" | "low",
  "notes": "optional brief note if assumptions were made, max 50 chars"
}

Rules:
- Return values for the SPECIFIC quantity given, not per-100g or per-serving.
- "confidence" should reflect your certainty: "high" for common generic foods, "medium" for variations, "low" for unknown/regional brands.
- For sugar: only include added + natural sugars. If unknown, use 0 and note it.
- For sodium: estimate milligrams of sodium for the given quantity. If genuinely unknown, use null.
- All numeric values must be numbers (not strings).
- Round to nearest whole number.

Example input: "Graziano sausage, 4 oz"
Example output: {"calories":320,"protein_g":18,"carbs_g":1,"fat_g":28,"sugar_g":0,"sodium_mg":820,"confidence":"low","notes":"estimated; local brand"}`;

  const response = await callAnthropic({
    apiKey,
    system: systemPrompt,
    userMessage: fullDesc,
    maxTokens: 200
  });

  const parsed = extractJSON(response);
  if (!parsed || typeof parsed.calories !== 'number') {
    throw new Error('Estimator returned malformed output.');
  }

  return {
    calories: Number(parsed.calories) || 0,
    protein_g: Number(parsed.protein_g) || 0,
    carbs_g: Number(parsed.carbs_g) || 0,
    fat_g: Number(parsed.fat_g) || 0,
    sugar_g: parsed.sugar_g == null ? null : Number(parsed.sugar_g),
    sodium_mg: parsed.sodium_mg == null ? null : Number(parsed.sodium_mg),
    confidence: parsed.confidence || 'low',
    notes: parsed.notes || null
  };
}

/* ============================================================
   helpers
   ============================================================ */

async function callAnthropic({ apiKey, system, userMessage, maxTokens }) {
  const res = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: userMessage }]
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Anthropic API error (${res.status}): ${errText.slice(0, 200)}`);
  }

  const data = await res.json();
  const text = (data.content || [])
    .filter(c => c.type === 'text')
    .map(c => c.text)
    .join('');
  return text;
}

function extractJSON(text) {
  if (!text) return null;
  // Strip code fences if any model leaks them despite instructions
  let cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  // Find the outermost JSON object/array
  const firstBrace = cleaned.search(/[{[]/);
  if (firstBrace === -1) return null;
  cleaned = cleaned.slice(firstBrace);
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    // Try to find the matching closing brace
    let depth = 0;
    let endIdx = -1;
    for (let i = 0; i < cleaned.length; i++) {
      const ch = cleaned[i];
      if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') {
        depth--;
        if (depth === 0) { endIdx = i + 1; break; }
      }
    }
    if (endIdx > 0) {
      try { return JSON.parse(cleaned.slice(0, endIdx)); } catch (_) {}
    }
    return null;
  }
}
