'use strict';
/**
 * VRE Screen Service
 * Captures the screen or active window using OS-native tools.
 * Zero npm dependencies.
 *
 * Windows  → PowerShell + System.Drawing (built-in .NET)
 * macOS    → screencapture (built-in)
 * Linux    → scrot or gnome-screenshot (must be installed)
 *
 * After capture, the image can be:
 *   1. Described by a local vision model via Ollama (llava, moondream, etc.)
 *   2. Returned as base64 PNG for other processing
 *   3. Saved to disk in Jane's workspace
 *
 * Privacy guarantee:
 *   - Screenshots NEVER leave the local machine.
 *   - If a vision model is used, it runs via local Ollama only.
 *   - No data is sent to any internet service.
 *
 * Permission: screen.capture capability must be declared in manifest
 *             AND consent must be given by the user at runtime.
 */

const { exec, execFile } = require('child_process');
const util               = require('util');
const execAsync          = util.promisify(exec);
const fs                 = require('fs');
const path               = require('path');
const os                 = require('os');

const PLATFORM = process.platform;

// Consent flag — must be explicitly set true by the user before any capture
let consentGiven = false;

// Temp dir for screenshots
const SNAP_DIR = path.join(os.homedir(), '.visrodeck', 'screenshots');
fs.mkdirSync(SNAP_DIR, { recursive: true });

// ── Consent ──────────────────────────────────────────────────────────

function grantConsent() { consentGiven = true; }
function revokeConsent() { consentGiven = false; }
function hasConsent() { return consentGiven; }

// ── Screenshot ───────────────────────────────────────────────────────

/**
 * capture(options) — takes a screenshot.
 * Returns { imagePath, base64, width, height, timestamp }
 *
 * options.window_only: boolean — capture active window only (if supported)
 * options.monitor:     number  — monitor index (default 0 = primary)
 */
async function capture(options = {}) {
  if (!consentGiven) {
    return { error: 'Screen capture consent not granted. User must enable it explicitly.' };
  }

  const ts       = Date.now();
  const snapPath = path.join(SNAP_DIR, `snap_${ts}.png`);

  try {
    if (PLATFORM === 'win32') {
      await captureWindows(snapPath, options);
    } else if (PLATFORM === 'darwin') {
      await captureMac(snapPath, options);
    } else {
      await captureLinux(snapPath, options);
    }
  } catch (err) {
    return { error: `Screenshot failed: ${err.message}` };
  }

  if (!fs.existsSync(snapPath)) {
    return { error: 'Screenshot file was not created.' };
  }

  const stat   = fs.statSync(snapPath);
  const base64 = fs.readFileSync(snapPath).toString('base64');

  return {
    imagePath: snapPath,
    base64,
    size_bytes: stat.size,
    timestamp:  ts,
    format:     'png',
  };
}

async function captureWindows(outPath, opts) {
  // Pure PowerShell + .NET System.Drawing — no extra tools needed
  const winOnly = opts.window_only ? 'true' : 'false';
  const ps = `
Add-Type -AssemblyName System.Drawing;
Add-Type -AssemblyName System.Windows.Forms;
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds;
$bmp = New-Object System.Drawing.Bitmap($screen.Width, $screen.Height);
$g = [System.Drawing.Graphics]::FromImage($bmp);
$g.CopyFromScreen($screen.Location, [System.Drawing.Point]::Empty, $screen.Size);
$g.Dispose();
$bmp.Save('${outPath.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png);
$bmp.Dispose();
Write-Output 'ok';
`.trim().replace(/\n/g, ' ');
  await execAsync(`powershell -NoProfile -Command "${ps}"`);
}

async function captureMac(outPath, opts) {
  const args = [outPath];
  if (opts.window_only) args.unshift('-w');   // capture interactive window
  await execAsync(`screencapture -x ${args.join(' ')}`);
}

async function captureLinux(outPath, opts) {
  // Try scrot first, then gnome-screenshot, then import (ImageMagick)
  try {
    const flag = opts.window_only ? '-u' : '';
    await execAsync(`scrot ${flag} "${outPath}"`);
  } catch {
    try {
      await execAsync(`gnome-screenshot -f "${outPath}"`);
    } catch {
      throw new Error('No screenshot tool found. Install scrot: sudo apt install scrot');
    }
  }
}

// ── Vision describe (local Ollama) ───────────────────────────────────

// ── Image resize for LLaVA ────────────────────────────────────────────
// LLaVA processes images much faster at 640x360 (360p) JPEG ~40% quality.
// Full 1080p+ screenshots are unnecessary — LLaVA can read UI at lower res.

/**
 * resizeForVision(pngPath) — downscales PNG to 640x360 JPEG 40% quality.
 * Returns base64 of the smaller JPEG, or original base64 on failure.
 */
async function resizeForVision(pngPath) {
  const jpgPath = pngPath.replace('.png', '_360p.jpg');

  if (PLATFORM === 'win32') {
    const ps = `
Add-Type -AssemblyName System.Drawing;
$src = New-Object System.Drawing.Bitmap('${pngPath.replace(/\\/g, '\\\\')}');
$dst = New-Object System.Drawing.Bitmap(640, 360);
$g = [System.Drawing.Graphics]::FromImage($dst);
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic;
$g.DrawImage($src, 0, 0, 640, 360);
$g.Dispose(); $src.Dispose();
$enc = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' };
$ep = New-Object System.Drawing.Imaging.EncoderParameters(1);
$ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, 40L);
$dst.Save('${jpgPath.replace(/\\/g, '\\\\')}', $enc, $ep);
$dst.Dispose();
Write-Output 'ok';
`.trim().replace(/\n/g, ' ');
    try {
      await execAsync(`powershell -NoProfile -Command "${ps}"`);
      if (fs.existsSync(jpgPath)) {
        const b64 = fs.readFileSync(jpgPath).toString('base64');
        try { fs.unlinkSync(jpgPath); } catch {}
        return { base64: b64, mime: 'image/jpeg', resized: true };
      }
    } catch (e) { console.log('[Screen] resize failed, using original:', e.message); }
  } else if (PLATFORM === 'darwin') {
    try {
      await execAsync(`sips -z 360 640 "${pngPath}" --out "${jpgPath}" --setProperty format jpeg 2>/dev/null`);
      if (fs.existsSync(jpgPath)) {
        const b64 = fs.readFileSync(jpgPath).toString('base64');
        try { fs.unlinkSync(jpgPath); } catch {}
        return { base64: b64, mime: 'image/jpeg', resized: true };
      }
    } catch {}
  } else {
    // Linux: try convert (ImageMagick)
    try {
      await execAsync(`convert "${pngPath}" -resize 640x360! -quality 40 "${jpgPath}" 2>/dev/null`);
      if (fs.existsSync(jpgPath)) {
        const b64 = fs.readFileSync(jpgPath).toString('base64');
        try { fs.unlinkSync(jpgPath); } catch {}
        return { base64: b64, mime: 'image/jpeg', resized: true };
      }
    } catch {}
  }

  // Fallback: return original PNG base64
  return { base64: fs.readFileSync(pngPath).toString('base64'), mime: 'image/png', resized: false };
}

/**
 * describeImage — sends image to llama-server vision model (no Ollama needed).
 * Tries /v1/chat/completions multimodal first, falls back to /completion with image_data.
 */
async function describeImage(base64, prompt = 'Describe what is on this screen in detail.', _ollamaUrl = '', _model = 'llava') {
  // Use llama-server URL from env (set by main.js)
  const llamaUrl = process.env.LLAMA_SERVER_URL || 'http://127.0.0.1:18080';

  // Try OpenAI-style multimodal
  try {
    const res = await fetch(`${llamaUrl}/v1/chat/completions`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{
          role: 'user',
          content: [
            { type: 'text',      text: prompt },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } }
          ]
        }],
        stream:      false,
        temperature: 0.2,
        max_tokens:  1024,
      }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data.choices?.[0]?.message?.content || '';
  } catch {
    // Fallback to /completion with image_data (older llama.cpp)
    const res2 = await fetch(`${llamaUrl}/completion`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt,
        image_data: [{ data: base64, id: 10 }],
        stream:     false,
        temperature: 0.2,
        n_predict:  1024,
      }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!res2.ok) throw new Error(`Vision HTTP ${res2.status}`);
    const d2 = await res2.json();
    return d2.content || '';
  }
}

/**
 * captureAndDescribe(prompt, options) — one-shot: screenshot → resize → LLaVA → text.
 * Screenshots are downscaled to 640×360 JPEG 40% quality for fast LLaVA inference.
 */
async function captureAndDescribe(prompt, ollamaUrl, model, options = {}) {
  if (!consentGiven) {
    return { error: 'Screen capture consent not granted.' };
  }

  const snap = await capture(options);
  if (snap.error) return snap;

  // Downscale for faster LLaVA processing (360p JPEG, ~10-20x smaller than raw PNG)
  const { base64: visionB64, mime, resized } = await resizeForVision(snap.imagePath);

  let description;
  try {
    description = await describeImage(
      visionB64,
      prompt || 'Describe what is on this screen. Be specific about apps, text, and UI elements visible.',
      ollamaUrl,
      model || 'llava'
    );
  } catch (err) {
    description = null;
    snap.vision_error = err.message;
    snap.vision_note  = 'Vision model unavailable. Pull it: ollama pull llava';
  }

  // Clean up temp file
  if (!options.keep_file) {
    try { fs.unlinkSync(snap.imagePath); } catch {}
  }

  return {
    description,
    image_path:   options.keep_file ? snap.imagePath : null,
    size_bytes:   snap.size_bytes,
    timestamp:    snap.timestamp,
    resized_for_vision: resized,
    vision_error: snap.vision_error,
    vision_note:  snap.vision_note,
  };
}

// ── Webpage text extract (from open browser tab) ──────────────────────
// If the user asks Jane to "read the page I have open", we:
// 1. Take a screenshot
// 2. Send to vision model with a "read the text" prompt
// This works without any browser extension — pure screen reading.

async function readCurrentPage(ollamaUrl, model) {
  return captureAndDescribe(
    'This is a screenshot of a web browser. Extract and reproduce ALL visible text content from the webpage. Include headings, paragraphs, navigation items, and any other readable text. Format it cleanly.',
    ollamaUrl,
    model || 'llava',
    {}
  );
}

module.exports = {
  capture,
  captureAndDescribe,
  readCurrentPage,
  describeImage,
  grantConsent,
  revokeConsent,
  hasConsent,
};
