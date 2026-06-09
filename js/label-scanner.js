/* ============================================================
   label-scanner.js — nutrition label photo scanner
   ============================================================
   Flow:
     1. Invoke the camera (or file picker on desktop) via a
        hidden <input type="file" capture="environment">
     2. Compress/resize the photo client-side if needed
     3. POST base64 to the scan-label Netlify Function
     4. Return a validated, structured result for the
        Edit/New Food form to consume

   Resolves to null if the user cancels the camera/picker.
   ============================================================ */

const SCAN_ENDPOINT = '/.netlify/functions/scan-label';
const MAX_IMAGE_BYTES = 1024 * 1024;   // compress if larger than ~1MB
const MAX_DIMENSION = 1600;            // long-side cap when compressing
const JPEG_QUALITY = 0.85;

/* ===== Step 1: camera / file picker ===== */

function pickImage() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.capture = 'environment';
    input.style.display = 'none';
    document.body.appendChild(input);

    let settled = false;
    const finish = (file) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(file);
    };

    input.addEventListener('change', () => {
      finish(input.files && input.files[0] ? input.files[0] : null);
    });

    // Detect cancel: focus returns to the window without a change event.
    // Give iOS/Android a generous grace period before checking.
    window.addEventListener('focus', () => {
      setTimeout(() => {
        if (!settled && (!input.files || input.files.length === 0)) {
          finish(null);
        }
      }, 1000);
    }, { once: true });

    input.click();
  });
}

/* ===== Step 2: compression ===== */

async function fileToBase64(file) {
  if (file.size <= MAX_IMAGE_BYTES) {
    const dataUrl = await readAsDataURL(file);
    return splitDataURL(dataUrl);
  }
  return compressImage(file);
}

function readAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Could not read the photo.'));
    reader.readAsDataURL(file);
  });
}

function splitDataURL(dataUrl) {
  const comma = dataUrl.indexOf(',');
  const header = dataUrl.slice(0, comma);
  const mediaType = header.includes('image/png') ? 'image/png' : 'image/jpeg';
  return { base64: dataUrl.slice(comma + 1), mediaType };
}

async function compressImage(file) {
  const dataUrl = await readAsDataURL(file);
  const img = await loadImage(dataUrl);

  let { width, height } = img;
  const longSide = Math.max(width, height);
  if (longSide > MAX_DIMENSION) {
    const scale = MAX_DIMENSION / longSide;
    width = Math.round(width * scale);
    height = Math.round(height * scale);
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, width, height);

  const compressed = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
  return splitDataURL(compressed);
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not process the photo.'));
    img.src = src;
  });
}

/* ===== Step 3: call the scan function ===== */

async function callScanFunction(base64, mediaType) {
  let res;
  try {
    res = await fetch(SCAN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: base64, media_type: mediaType })
    });
  } catch (e) {
    throw new Error('Network error — check your connection and try again.');
  }

  if (!res.ok) {
    let msg = `Scan failed (${res.status})`;
    try {
      const err = await res.json();
      if (err && err.error) msg = err.error;
    } catch (_) {}
    throw new Error(msg);
  }
  return res.json();
}

/* ===== Step 4: validate the result shape ===== */

function validateResult(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Scanner returned an unexpected response.');
  }
  const toNum = v => {
    if (v == null || v === '') return null;
    const n = Number(v);
    return isNaN(n) ? null : n;
  };
  return {
    serving_desc: raw.serving_desc ? String(raw.serving_desc).trim() : null,
    calories: toNum(raw.calories),
    protein_g: toNum(raw.protein_g),
    carbs_g: toNum(raw.carbs_g),
    fat_g: toNum(raw.fat_g),
    sugar_g: toNum(raw.sugar_g),
    sodium_mg: toNum(raw.sodium_mg),
    confidence: ['high', 'medium', 'low'].includes(raw.confidence) ? raw.confidence : 'low',
    notes: raw.notes ? String(raw.notes) : null
  };
}

/* ===== Main entry ===== */

// opts.onImagePicked — optional callback fired once a photo is chosen,
// so the UI can switch from "Opening camera…" to "Reading label…"
async function scanLabel(opts) {
  const file = await pickImage();
  if (!file) return null; // user cancelled

  if (opts && typeof opts.onImagePicked === 'function') opts.onImagePicked();

  const { base64, mediaType } = await fileToBase64(file);
  const raw = await callScanFunction(base64, mediaType);
  return validateResult(raw);
}

window.LabelScanner = { scanLabel };
