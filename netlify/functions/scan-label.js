/* ============================================================
   scan-label.js — Netlify Function
   ============================================================
   POST endpoint that takes a base64-encoded photo of a
   nutrition facts label and returns structured nutrition data
   for pre-filling the New Food form.

   Env vars required:
     ANTHROPIC_API_KEY — set in Netlify dashboard → Site →
                         Environment variables
   ============================================================ */

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';

// ~1.4MB of base64 ≈ ~1MB binary; client compresses before upload,
// but reject anything wildly oversized to protect the function.
const MAX_BASE64_LENGTH = 5 * 1024 * 1024;

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

  const image = body.image;
  if (!image || typeof image !== 'string') {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Missing "image" — expected a base64-encoded photo.' })
    };
  }
  if (image.length > MAX_BASE64_LENGTH) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Image too large — try retaking the photo.' })
    };
  }

  try {
    const result = await scanLabel(image, body.media_type, apiKey);
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
   scanLabel — extract nutrition facts from a label photo
   ============================================================ */

async function scanLabel(base64Image, mediaType, apiKey) {
  const systemPrompt = `You extract nutrition facts from photos of nutrition labels.

Output ONLY valid JSON. No prose, no markdown, no code fences. Just a JSON object.

Schema:
{
  "serving_desc": "first listed serving as written on label, e.g. '1 cup' or '2 tbsp (30g)' — capture the unit AND any parenthetical grams if present, or null if unreadable",
  "calories": number | null,
  "protein_g": number | null,
  "carbs_g": number | null,
  "fat_g": number | null,
  "sugar_g": number | null,
  "sodium_mg": number | null,
  "confidence": "high" | "medium" | "low",
  "notes": "optional brief note, max 80 chars"
}

Rules:
- All numeric values must be NUMBERS, not strings. Use null for any field that couldn't be read clearly — never fabricate.
- Sugar: extract "Total Sugars" specifically. Older labels showing just "Sugars" → use that. Never use "Added Sugars" as the sugar value.
- Sodium: extract the milligram value from the Sodium row. Do NOT convert from percentage daily value — if only % is shown without mg, return null.
- Serving size: capture the FIRST listed serving as written. If the label shows "Serving size: 1 cup (227g)", set serving_desc to "1 cup (227g)". If "1 bar", just "1 bar".
- All macro numbers must be per SINGLE SERVING, not per container.
- Confidence: "high" for clearly readable mainstream US-style nutrition labels, "medium" for slightly blurry or unusual layouts, "low" for partial extraction.
- If the image is not a nutrition label (random photo, blank, illegible), return all numeric fields as null, serving_desc as null, and set confidence to "low" with a note explaining.`;

  const response = await callAnthropicVision({
    apiKey,
    system: systemPrompt,
    base64Image,
    mediaType: mediaType === 'image/png' ? 'image/png' : 'image/jpeg',
    maxTokens: 300
  });

  const parsed = extractJSON(response);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Scanner returned malformed output.');
  }

  const toNum = v => {
    if (v == null || v === '') return null;
    const n = Number(v);
    return isNaN(n) ? null : n;
  };

  return {
    serving_desc: parsed.serving_desc ? String(parsed.serving_desc).trim() : null,
    calories: toNum(parsed.calories),
    protein_g: toNum(parsed.protein_g),
    carbs_g: toNum(parsed.carbs_g),
    fat_g: toNum(parsed.fat_g),
    sugar_g: toNum(parsed.sugar_g),
    sodium_mg: toNum(parsed.sodium_mg),
    confidence: ['high', 'medium', 'low'].includes(parsed.confidence) ? parsed.confidence : 'low',
    notes: parsed.notes ? String(parsed.notes).slice(0, 80) : null
  };
}

/* ============================================================
   helpers
   ============================================================ */

async function callAnthropicVision({ apiKey, system, base64Image, mediaType, maxTokens }) {
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
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Image } },
          { type: 'text', text: 'Extract nutrition facts from this label.' }
        ]
      }]
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
