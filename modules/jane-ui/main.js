'use strict';

const { app, BrowserWindow, ipcMain, nativeTheme, globalShortcut, screen, desktopCapturer } = require('electron');
const { spawn, exec }  = require('child_process');
const path             = require('path');
const fs               = require('fs');
const os               = require('os');
const crypto           = require('crypto');
const https            = require('https');
const http             = require('http');

// ── Resource budget ────────────────────────────────────────────────────
const CPU_COUNT          = os.cpus().length;
const CPU_THREAD_DEFAULT = Math.max(2, Math.floor(CPU_COUNT * 0.50));
const CPU_THREAD_MAX     = Math.max(4, Math.floor(CPU_COUNT * 0.80));

const SUPPORTED_MODELS = ['llava:1.5', 'llama3.2:3b', 'dolphin-mistral:7b'];

// ── GGUF model filenames ───────────────────────────────────────────────
const GGUF_FILES = {
  'llama3.2:3b':        'Llama-3.2-3B-Instruct-Q4_K_M.gguf',
  'llava:1.5':          'llava-v1.5-7b-Q4_K.gguf',
  'dolphin-mistral:7b': 'dolphin-2.6-mistral-7b-Q4_K_M.gguf',
};

// Multiple mirror URLs per model for redundancy — checks in order and uses first that works
const GGUF_URLS = {
  'llama3.2:3b': [
    // unsloth
    'https://huggingface.co/unsloth/Llama-3.2-3B-Instruct-GGUF/resolve/main/Llama-3.2-3B-Instruct-Q4_K_M.gguf',
    // hugging-quants
    'https://huggingface.co/hugging-quants/Llama-3.2-3B-Instruct-Q4_K_M-GGUF/resolve/main/llama-3.2-3b-instruct-q4_k_m.gguf',
    // QuantFactory
    'https://huggingface.co/QuantFactory/Llama-3.2-3B-Instruct-GGUF/resolve/main/Llama-3.2-3B-Instruct-Q4_K_M.gguf',
  ],
  'llava:1.5': [
    // jartine 
    'https://huggingface.co/jartine/llava-v1.5-7B-GGUF/resolve/main/llava-v1.5-7b-Q4_K.gguf',
    // mozilla-ai 
    'https://huggingface.co/Mozilla/llava-v1.5-7b-llamafile/resolve/main/llava-v1.5-7b-Q4_K.gguf',
  ],
  'dolphin-mistral:7b': [
    // TheBloke dolphin-2.6 
    'https://huggingface.co/TheBloke/dolphin-2.6-mistral-7B-GGUF/resolve/main/dolphin-2.6-mistral-7b.Q4_K_M.gguf',
    // TheBloke dolphin-2.2.1 
    'https://huggingface.co/TheBloke/dolphin-2.2.1-mistral-7B-GGUF/resolve/main/dolphin-2.2.1-mistral-7b.Q4_K_M.gguf',
  ],
};

// Minimum valid file sizes — anything smaller is a corrupt download
const MIN_MODEL_SIZES = {
  'llama3.2:3b':        1.5 * 1024 * 1024 * 1024,
  'llava:1.5':          3.0 * 1024 * 1024 * 1024,
  'dolphin-mistral:7b': 3.0 * 1024 * 1024 * 1024,
};

// llama-server binary name by platform
const LLAMA_SERVER_BIN  = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
const LLAMA_SERVER_PORT = 8080;
const LLAMA_SERVER_URL  = `http://127.0.0.1:${LLAMA_SERVER_PORT}`;

// GitHub release URL for llama-server (CPU build)
// Filename pattern: llama-bXXXX-bin-win-noavx-x64.zip
const LLAMA_GITHUB_API  = 'https://api.github.com/repos/ggml-org/llama.cpp/releases/latest';
const LLAMA_BIN_DIR_HOME = path.join(os.homedir(), '.visrodeck', 'bin');

// ── Path resolution ───────────────────────────────────────────────────
const IS_PACKED = app.isPackaged;
const RESOURCES = IS_PACKED ? process.resourcesPath : path.resolve(__dirname, '..', '..');
const VRE_ENTRY = path.join(RESOURCES, 'vre', 'src', 'index.js');

const JANE_SRC      = IS_PACKED ? path.join(RESOURCES, 'modules', 'jane', 'src') : path.resolve(__dirname, '..', 'jane', 'src');
const MANIFEST_PATH = IS_PACKED ? path.join(RESOURCES, 'modules', 'jane', 'manifest.json') : path.resolve(__dirname, '..', 'jane', 'manifest.json');

const activation = require('./activation');
const VREClient  = require(path.join(JANE_SRC, 'vre_client'));
const { JaneAgent } = require(path.join(JANE_SRC, 'agent_loop'));

const WORKSPACE    = path.join(os.homedir(), '.visrodeck', 'workspaces', 'jane');
const MODELS_DIR   = path.join(os.homedir(), '.visrodeck', 'models');
const STORAGE_DIR  = path.join(os.homedir(), '.visrodeck', 'encrypted');
const HISTORY_FILE = path.join(STORAGE_DIR, 'chat_history.enc');
const PREFS_FILE   = path.join(STORAGE_DIR, 'preferences.enc');

// Dependencies folder 
const DEPS_DIR       = path.join(RESOURCES, 'dependencies');
const DEPS_LLAMA_DIR = path.join(DEPS_DIR, 'llama.cpp');
const DEPS_WHISPER_DIR = path.join(DEPS_DIR, 'whisper.cpp');
const ASSETS_MODELS_DIR = path.join(RESOURCES, 'assets', 'models');

const WHISPER_BIN_NAME = process.platform === 'win32' ? 'whisper-server.exe' : 'whisper-server';
const WHISPER_MAIN_NAME = process.platform === 'win32' ? 'main.exe' : 'main';
const WHISPER_MODEL_NAMES = ['ggml-base.en.bin', 'ggml-small.en.bin', 'ggml-medium.en.bin', 'ggml-base.bin'];

function findWhisperBin() {
  const sub = { nvidia:'cuda', amd:'vulkan', intel:'vulkan', cpu:'cpu' }[prefs.gpu || 'cpu'] || 'cpu';
  const homeWhisper = path.join(os.homedir(), '.visrodeck', 'whisper');
  const candidates = [
    // auto-downloaded location (highest priority)
    path.join(homeWhisper, WHISPER_BIN_NAME),
    path.join(homeWhisper, WHISPER_MAIN_NAME),
    path.join(homeWhisper, 'whisper-cli.exe'),
    path.join(homeWhisper, 'whisper-cli'),
    // dependencies folder (manual install)
    path.join(DEPS_WHISPER_DIR, sub,  WHISPER_BIN_NAME),
    path.join(DEPS_WHISPER_DIR, sub,  WHISPER_MAIN_NAME),
    path.join(DEPS_WHISPER_DIR, WHISPER_BIN_NAME),
    path.join(DEPS_WHISPER_DIR, WHISPER_MAIN_NAME),
    path.join(DEPS_WHISPER_DIR, 'cuda',   WHISPER_BIN_NAME),
    path.join(DEPS_WHISPER_DIR, 'vulkan', WHISPER_BIN_NAME),
    path.join(DEPS_WHISPER_DIR, 'cpu',    WHISPER_BIN_NAME),
    path.join(os.homedir(), '.visrodeck', 'bin', WHISPER_BIN_NAME),
    path.join(os.homedir(), '.visrodeck', 'bin', WHISPER_MAIN_NAME),
  ];
  return candidates.find(p => fs.existsSync(p)) || null;
}

function findWhisperModel() {
  const searchDirs = [DEPS_WHISPER_DIR, ASSETS_MODELS_DIR, MODELS_DIR,
                      path.join(os.homedir(), '.visrodeck', 'models')];
  for (const dir of searchDirs) {
    for (const name of WHISPER_MODEL_NAMES) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

// Possible locations for llama-server binary
const LLAMA_BIN_BUNDLED = path.join(RESOURCES, 'bin', LLAMA_SERVER_BIN);
const LLAMA_BIN_HOME    = path.join(LLAMA_BIN_DIR_HOME, LLAMA_SERVER_BIN);
// winget installs llama.cpp here on Windows
const LLAMA_BIN_WINGET  = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages',
                            'ggml-org.llama.cpp_Microsoft.Winget.Source_8wekyb3d8bbwe', 'bin', LLAMA_SERVER_BIN);

function getLlamaBin() {
  if (fs.existsSync(LLAMA_BIN_BUNDLED)) return LLAMA_BIN_BUNDLED;
  if (fs.existsSync(LLAMA_BIN_HOME))    return LLAMA_BIN_HOME;
  if (fs.existsSync(LLAMA_BIN_WINGET))  return LLAMA_BIN_WINGET;

  // Check dependencies/llama.cpp/<gpu-subfolder>/ based on selected GPU from prefs
  const gpuFolder = {
    'nvidia': 'cuda',
    'amd':    'vulkan',
    'intel':  'vulkan',
    'cpu':    'cpu',
  }[prefs.gpu || 'cpu'] || 'cpu';

  // Try GPU-specific folder first, then fallback to other folders in priority order
  const subfolderPriority = [gpuFolder, 'cuda', 'vulkan', 'cpu', ''];
  for (const sub of subfolderPriority) {
    const p = sub
      ? path.join(DEPS_LLAMA_DIR, sub, LLAMA_SERVER_BIN)
      : path.join(DEPS_LLAMA_DIR, LLAMA_SERVER_BIN);
    if (fs.existsSync(p)) return p;
  }

  return LLAMA_SERVER_BIN; // rely on PATH (winget adds it)
}

function getLlamaBinDir() {
  const bin = getLlamaBin();
  return fs.existsSync(bin) ? path.dirname(path.resolve(bin)) : LLAMA_BIN_DIR_HOME;
}

async function isBinOnPath(bin) {
  return new Promise(r => exec(`"${bin}" --version`, { timeout: 3000 }, err => r(!err)));
}

const MODEL_DEFAULT = process.env.JANE_MODEL || 'llama3.2:3b';

// ═══════════════════════════════════════════════════════════
//  AES-256-GCM ENCRYPTED STORAGE
// ═══════════════════════════════════════════════════════════
function getEncryptionKey() {
  const fp = `${os.hostname()}-${os.platform()}-${os.arch()}-visrodeck-jane-v1`;
  return crypto.createHash('sha256').update(fp).digest();
}

function encryptData(plaintext) {
  const key = getEncryptionKey();
  const iv  = crypto.randomBytes(12);
  const c   = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}

function decryptData(b64) {
  const key = getEncryptionKey();
  const buf = Buffer.from(b64, 'base64');
  const d   = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return d.update(buf.subarray(28), undefined, 'utf8') + d.final('utf8');
}

function encRead(file, fallback) {
  try { return JSON.parse(decryptData(fs.readFileSync(file, 'utf8'))); }
  catch { return fallback; }
}

function encWrite(file, data) {
  fs.mkdirSync(STORAGE_DIR, { recursive: true });
  fs.writeFileSync(file, encryptData(JSON.stringify(data)), 'utf8');
}

// ── History IPC ───────────────────────────────────────────────────────
ipcMain.handle('history:save', async (_, data) => {
  try { encWrite(HISTORY_FILE, data); return { success: true }; }
  catch (e) { return { success: false, error: e.message }; }
});
ipcMain.handle('history:load', async () => {
  return encRead(HISTORY_FILE, []);
});

// ── Preferences IPC ───────────────────────────────────────────────────
let prefs = {};

function loadPrefs() {
  prefs = encRead(PREFS_FILE, {
    userName:           'User',
    aiName:             'Jane',
    wakeWord:           'Hey Jane',
    tone:               'balanced',         // balanced | casual | professional | direct
    customInstructions: '',
    theme:              'original',          // original | white | custom
    accentColor:        '#7c3aed',
    autoModelSwitch:    true,
  });
}

function savePrefs() {
  try { encWrite(PREFS_FILE, prefs); } catch (e) { console.error('[Prefs]', e.message); }
}

ipcMain.handle('prefs:get', async () => prefs);
ipcMain.handle('prefs:set', async (_, updates) => {
  prefs = { ...prefs, ...updates };
  savePrefs();
  // Rebuild agent with new persona
  if (agent && connected) {
    agent = new JaneAgent(vre, currentModel, buildPersonalization());
  }
  // Re-register hotkeys if they changed
  if (updates.hotkeys) {
    globalShortcut.unregisterAll();
    globalShortcut.register(prefs.hotkeys?.main  || 'Alt+Space', () => {
      if (!overlayWin || overlayWin.isDestroyed()) createOverlay();
      else overlayWin.isVisible() ? overlayWin.hide() : (overlayWin.show(), overlayWin.focus());
    });
    globalShortcut.register(prefs.hotkeys?.float || 'Alt+J', () => {
      floatEnabled = !floatEnabled; floatEnabled ? createFloat() : destroyFloat();
    });
    globalShortcut.register(prefs.hotkeys?.screen || 'Alt+S', () => {
      bcast('hotkey:screen_capture', {});
    });
  }
  // Trigger whisper download if requested
  if (updates.whisperPullRequested) {
    prefs.whisperPullRequested = false;
    savePrefs();
    autoDownloadWhisper().catch(err => {
      bcast('whisper:download:error', { error: err.message });
    });
  }
  return { success: true };
});

// ── System info ───────────────────────────────────────────────────────
ipcMain.handle('system:cpu_info', async () => {
  const cpus = os.cpus();
  const model = cpus?.[0]?.model || 'Unknown CPU';
  const threads = cpus?.length || os.availableParallelism?.() || 4;
  const ramGB = Math.round(os.totalmem() / (1024 ** 3));
  return { model, threads, platform: process.platform, ramGB };
});

// ── Setup / Dep check ─────────────────────────────────────────────────
ipcMain.handle('setup:check_deps', async (_, gpuHint) => {
  // Use GPU from params 
  const gpu = gpuHint || prefs.gpu || 'cpu';
  const sub = { nvidia:'cuda', amd:'vulkan', intel:'vulkan', cpu:'cpu' }[gpu] || 'cpu';
  const llamaBin     = getLlamaBin();
  const llamaOk      = fs.existsSync(llamaBin) || await isBinOnPath(LLAMA_SERVER_BIN);
  const whisperBin   = findWhisperBin();
  const whisperModel = findWhisperModel();
  const expectedPath = path.join(DEPS_LLAMA_DIR, sub, LLAMA_SERVER_BIN);
  return {
    llama:             llamaOk,
    llamaPath:         llamaOk ? llamaBin : expectedPath,
    whisper:           !!whisperBin,
    whisperPath:       whisperBin || path.join(DEPS_WHISPER_DIR, sub, WHISPER_BIN_NAME),
    whisperModel:      !!whisperModel,
    whisperModelPath:  whisperModel || path.join('assets', 'models', 'ggml-base.en.bin'),
    gpu, sub,
  };
});

ipcMain.handle('setup:complete', async (_, cfg) => {
  if (!cfg.skipped) {
    prefs = {
      ...prefs,
      userName:    cfg.userName    || prefs.userName,
      aiName:      cfg.aiName      || prefs.aiName,
      wakeWord:    cfg.wakeWord    || prefs.wakeWord,
      tone:        cfg.tone        || prefs.tone,
      gpu:         cfg.gpu,
      threads:     cfg.threads,
      onboardDone: true,
    };
    savePrefs();
    // Rebuild agent persona immediately
    if (agent && connected) agent = new JaneAgent(vre, currentModel, buildPersonalization());
  } else {
    prefs = { ...prefs, onboardDone: true };
    savePrefs();
  }
  return { ok: true };
});

function buildPersonalization() {
  return {
    aiName:             prefs.aiName             || 'Jane',
    userName:           prefs.userName           || 'User',
    tone:               prefs.tone               || 'balanced',
    customInstructions: prefs.customInstructions || '',
    lewdMode:           prefs.lewdMode           || false,
    thinkExtended:      prefs.thinkExtended      || false,
    recallMode:         prefs.recallMode         || false,
  };
}

// ═══════════════════════════════════════════════════════════
//  llama-server MANAGEMENT
// ═══════════════════════════════════════════════════════════
let llamaProc = null;
let llamaLoadedModel = null;

// Search paths for GGUF files — checks multiple locations
const MODEL_SEARCH_DIRS = [
  MODELS_DIR,                          // primary: ~/.visrodeck/models/
  ASSETS_MODELS_DIR,                   // assets/models/ inside jane dir
  DEPS_LLAMA_DIR,                      // deps folder
  __dirname,                           // jane-ui dir (migration)
  path.join(__dirname, 'renderer'),
  path.join(RESOURCES, 'models'),
];

function getModelPath(modelId) {
  // Custom model: prefix
  if (modelId && modelId.startsWith('custom:')) {
    const fname = modelId.replace('custom:', '') + '.gguf';
    return path.join(MODELS_DIR, fname);
  }
  const fname = GGUF_FILES[modelId];
  if (!fname) return null;

  // Check all search dirs
  for (const dir of MODEL_SEARCH_DIRS) {
    const p = path.join(dir, fname);
    if (fs.existsSync(p)) return p;
  }

  // Return the canonical path even if doesn't exist 
  return path.join(MODELS_DIR, fname);
}

function isModelInstalled(modelId) {
  const fname = GGUF_FILES[modelId];
  if (!fname) return false;
  return MODEL_SEARCH_DIRS.some(dir => fs.existsSync(path.join(dir, fname)));
}

function listInstalledModels() {
  return SUPPORTED_MODELS.filter(m => isModelInstalled(m));
}

// Migrate any GGUFs found in wrong locations  ~/.visrodeck/models/
async function migrateModels() {
  fs.mkdirSync(MODELS_DIR, { recursive: true });
  for (const [modelId, fname] of Object.entries(GGUF_FILES)) {
    const canonical = path.join(MODELS_DIR, fname);
    if (fs.existsSync(canonical)) continue; // already in right place
    // Check other dirs
    for (const dir of MODEL_SEARCH_DIRS.slice(1)) {
      const src = path.join(dir, fname);
      if (fs.existsSync(src)) {
        console.log(`[models] Migrating ${fname} → ${MODELS_DIR}`);
        try {
          fs.renameSync(src, canonical);
          console.log(`[models] Moved ${fname} to models dir`);
        } catch {
          // rename fails cross-drive — copy instead
          try {
            fs.copyFileSync(src, canonical);
            fs.unlinkSync(src);
            console.log(`[models] Copied+deleted ${fname} to models dir`);
          } catch (e) {
            console.warn(`[models] Migration failed for ${fname}: ${e.message}`);
          }
        }
        break;
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════
//  AUTO-DOWNLOAD llama-server FROM GITHUB RELEASES
// ═══════════════════════════════════════════════════════════
async function autoDownloadLlamaServer() {
  if (fs.existsSync(getLlamaBin())) return getLlamaBin();

  const gpu = prefs.gpu || 'cpu'; // from onboarding selection
  console.log(`[llama-auto] GPU type from prefs: ${gpu}`);

  bcast('llama:download:start', { file: 'llama-server', gpu });
  bcast('status', { connected: false, model: currentModel, message: `Fetching llama.cpp release info (GPU: ${gpu})…` });

  try {
    const releaseJson = await new Promise((res, rej) => {
      https.get(LLAMA_GITHUB_API, { headers: { 'User-Agent': 'Jane-Visrodeck/1.8.0' } }, r => {
        let d = '';
        r.on('data', c => d += c);
        r.on('end', () => { try { res(JSON.parse(d)); } catch(e) { rej(e); } });
      }).on('error', rej);
    });

    const assets    = releaseJson.assets || [];
    const isWin     = process.platform === 'win32';
    const isMainBin = a => /^llama-b\d+/i.test(a.name);

    let asset = null;
    if (isWin) {
      // Pick build based on GPU type selected in onboarding
      if (gpu === 'nvidia') {
        // CUDA 12 — works on all RTX/GTX with CUDA 12.x
        asset = assets.find(a => isMainBin(a) && /bin-win-cuda-cu12.*x64\.zip$/i.test(a.name));
        if (!asset) asset = assets.find(a => isMainBin(a) && /bin-win-cuda.*x64\.zip$/i.test(a.name));
        console.log('[llama-auto] Selected CUDA build:', asset?.name);
      } else if (gpu === 'amd' || gpu === 'intel') {
        // Vulkan — works on AMD Radeon + Intel Arc/Iris via Vulkan drivers
        asset = assets.find(a => isMainBin(a) && /bin-win-vulkan-x64\.zip$/i.test(a.name));
        console.log('[llama-auto] Selected Vulkan build:', asset?.name);
      }
      // CPU-only or fallback
      if (!asset) asset = assets.find(a => isMainBin(a) && /bin-win-avx2-x64\.zip$/i.test(a.name));
      if (!asset) asset = assets.find(a => isMainBin(a) && /bin-win-noavx-x64\.zip$/i.test(a.name));
      if (!asset) asset = assets.find(a => isMainBin(a) && /bin-win.*x64\.zip$/i.test(a.name));
    } else if (process.platform === 'darwin') {
      asset = assets.find(a => isMainBin(a) && /macos.*zip$/i.test(a.name));
    } else {
      asset = assets.find(a => isMainBin(a) && /linux.*x64.*zip$/i.test(a.name));
    }

    if (!asset) throw new Error(`No compatible build found for GPU=${gpu}. Assets: ${assets.map(a=>a.name).slice(0,5).join(', ')}`);

    const sizeMB = (asset.size / 1024 / 1024).toFixed(0);
    console.log(`[llama-auto] Downloading: ${asset.name} (${sizeMB} MB)`);
    bcast('llama:download:progress', { file: 'llama-server', name: asset.name, pct: 0, sizeMB, gpu });
    bcast('status', { connected: false, model: currentModel, message: `Downloading llama-server for ${gpu.toUpperCase()} (${sizeMB} MB)…` });

    const tmpZip = path.join(os.tmpdir(), `llama_dl_${Date.now()}.zip`);
    let lastBroadcast = 0;
    await downloadFile(asset.browser_download_url, tmpZip, (pct, dlBytes, total) => {
      const now = Date.now();
      if (now - lastBroadcast > 400) {
        lastBroadcast = now;
        bcast('llama:download:progress', { file: 'llama-server', name: asset.name, pct, gpu, sizeMB });
        bcast('status', { connected: false, model: currentModel, message: `Downloading llama-server (${gpu.toUpperCase()})… ${pct}%` });
      }
    });

    await new Promise(r => setTimeout(r, 500));

    bcast('llama:download:progress', { file: 'llama-server', pct: 100, status: 'extracting', gpu });
    bcast('status', { connected: false, model: currentModel, message: 'Extracting llama-server…' });

    fs.mkdirSync(LLAMA_BIN_DIR_HOME, { recursive: true });
    const extractDest = path.join(os.tmpdir(), `llama_ext_${Date.now()}`);
    fs.mkdirSync(extractDest, { recursive: true });

    await new Promise((res, rej) => {
      let cmd, args;
      if (process.platform === 'win32') {
        const psScript = `$src='${tmpZip.replace(/'/g,"''")}';$dst='${extractDest.replace(/'/g,"''")}';Expand-Archive -LiteralPath $src -DestinationPath $dst -Force;Write-Host 'DONE'`;
        cmd = 'powershell'; args = ['-NoProfile', '-NonInteractive', '-Command', psScript];
      } else {
        cmd = 'unzip'; args = ['-o', tmpZip, '-d', extractDest];
      }
      const proc = spawn(cmd, args, { stdio: ['ignore','pipe','pipe'] });
      let out = '', err = '';
      proc.stdout.on('data', d => { out += d; });
      proc.stderr.on('data', d => { err += d; });
      proc.on('close', code => { (code !== 0 && !out.includes('DONE')) ? rej(new Error(`Extract failed: ${err.slice(0,200)}`)) : res(); });
      proc.on('error', rej);
    });

    function findBin(dir, depth = 0) {
      if (depth > 5) return null;
      let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { const r = findBin(full, depth + 1); if (r) return r; }
        if (e.name.toLowerCase() === LLAMA_SERVER_BIN.toLowerCase()) return full;
      }
      return null;
    }

    const found = findBin(extractDest);
    if (!found) throw new Error(`llama-server.exe not found in zip (asset: ${asset.name})`);

    fs.copyFileSync(found, LLAMA_BIN_HOME);
    if (process.platform !== 'win32') fs.chmodSync(LLAMA_BIN_HOME, 0o755);

    if (process.platform === 'win32') {
      const srcDir = path.dirname(found);
      for (const f of fs.readdirSync(srcDir)) {
        if (f.toLowerCase().endsWith('.dll')) {
          try { fs.copyFileSync(path.join(srcDir, f), path.join(LLAMA_BIN_DIR_HOME, f)); } catch {}
        }
      }
    }

    try { fs.unlinkSync(tmpZip); } catch {}
    try { fs.rmSync(extractDest, { recursive: true, force: true }); } catch {}

    console.log(`[llama-auto] Installed: ${LLAMA_BIN_HOME}`);
    bcast('llama:download:done', { file: 'llama-server', success: true, gpu });
    return LLAMA_BIN_HOME;

  } catch (err) {
    console.error('[llama-auto] Failed:', err.message);
    bcast('llama:download:done', { file: 'llama-server', success: false, error: err.message, gpu });
    bcast('status', { connected: false, model: currentModel,
      message: `llama-server download failed. Manually download the ${gpu === 'nvidia' ? 'CUDA' : gpu === 'amd' || gpu === 'intel' ? 'Vulkan' : 'AVX2'} build from github.com/ggml-org/llama.cpp/releases` });
    return null;
  }
}

// ═══════════════════════════════════════════════════════════
//  AUTO-DOWNLOAD Whisper.cpp FROM GITHUB RELEASES
// ═══════════════════════════════════════════════════════════
const WHISPER_GITHUB_API   = 'https://api.github.com/repos/ggerganov/whisper.cpp/releases/latest';
const WHISPER_MODEL_URL    = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin';
const WHISPER_BIN_DIR_HOME = path.join(os.homedir(), '.visrodeck', 'whisper');
const WHISPER_MODEL_DEST   = path.join(os.homedir(), '.visrodeck', 'models', 'ggml-base.en.bin');

async function autoDownloadWhisper() {
  bcast('whisper:download:start', {});
  bcast('status', { connected, model: currentModel, message: 'Fetching Whisper.cpp release info…' });

  try {
    // ── Step 1: get latest release ──────────────────────────
    const releaseJson = await new Promise((res, rej) => {
      https.get(WHISPER_GITHUB_API, { headers: { 'User-Agent': 'Jane-Visrodeck/1.8.0' } }, r => {
        let d = ''; r.on('data', c => d += c);
        r.on('end', () => { try { res(JSON.parse(d)); } catch(e) { rej(e); } });
      }).on('error', rej);
    });

    const assets  = releaseJson.assets || [];
    const isWin   = process.platform === 'win32';
    const isMac   = process.platform === 'darwin';
    const gpu     = prefs.gpu || 'cpu';

    let asset = null;
    if (isWin) {
      // whisper.cpp releases: whisper-bin-win-x64.zip, whisper-cublas-11.7.1-bin-win-x64.zip
      if (gpu === 'nvidia') {
        asset = assets.find(a => /cublas.*bin.*win.*x64.*zip$/i.test(a.name));
        if (!asset) asset = assets.find(a => /whisper.*cuda.*win.*zip$/i.test(a.name));
      }
      if (!asset) asset = assets.find(a => /bin.*win.*x64.*zip$/i.test(a.name));
      if (!asset) asset = assets.find(a => /win.*x64.*zip$/i.test(a.name) && !/openvino|sycl/i.test(a.name));
      if (!asset) asset = assets.find(a => /\.zip$/i.test(a.name) && /win/i.test(a.name));
    } else if (isMac) {
      asset = assets.find(a => /macos.*zip$/i.test(a.name));
      if (!asset) asset = assets.find(a => /osx.*zip$/i.test(a.name) || /mac.*zip$/i.test(a.name));
    } else {
      asset = assets.find(a => /bin.*linux.*x64.*zip$/i.test(a.name));
      if (!asset) asset = assets.find(a => /linux.*x64.*zip$/i.test(a.name));
    }

    if (!asset) {
      const names = assets.map(a => a.name).join(', ');
      console.error('[whisper-auto] Available assets:', names);
      throw new Error(`No Whisper binary found for ${process.platform}/${gpu}. Available: ${names.slice(0, 300)}`);
    }
    console.log('[whisper-auto] Selected:', asset.name);

    const sizeMB = (asset.size / 1024 / 1024).toFixed(0);
    bcast('whisper:download:progress', { stage: 'binary', pct: 0, sizeMB });
    bcast('status', { connected, model: currentModel, message: `Downloading Whisper (${sizeMB} MB)…` });

    // ── Step 2: download binary zip ─────────────────────────
    const tmpZip = path.join(os.tmpdir(), `whisper_dl_${Date.now()}.zip`);
    let lastBcast = 0;
    await downloadFile(asset.browser_download_url, tmpZip, (pct) => {
      const now = Date.now();
      if (now - lastBcast > 500) {
        lastBcast = now;
        bcast('whisper:download:progress', { stage: 'binary', pct });
        bcast('status', { connected, model: currentModel, message: `Downloading Whisper… ${pct}%` });
      }
    });

    // ── Step 3: extract ─────────────────────────────────────
    bcast('whisper:download:progress', { stage: 'extract', pct: 80 });
    bcast('status', { connected, model: currentModel, message: 'Extracting Whisper…' });

    fs.mkdirSync(WHISPER_BIN_DIR_HOME, { recursive: true });
    const extractDest = path.join(os.tmpdir(), `whisper_ext_${Date.now()}`);
    fs.mkdirSync(extractDest, { recursive: true });

    await new Promise((res, rej) => {
      let cmd, args;
      if (isWin) {
        const psScript = `$src='${tmpZip.replace(/'/g,"''")}';$dst='${extractDest.replace(/'/g,"''")}';Expand-Archive -LiteralPath $src -DestinationPath $dst -Force;Write-Host 'DONE'`;
        cmd = 'powershell'; args = ['-NoProfile', '-NonInteractive', '-Command', psScript];
      } else {
        cmd = 'unzip'; args = ['-o', tmpZip, '-d', extractDest];
      }
      const proc = require('child_process').spawn(cmd, args, { stdio: 'pipe' });
      proc.on('exit', code => code === 0 ? res() : rej(new Error(`Extract failed: code ${code}`)));
      proc.on('error', rej);
    });

    // Copy all executables to whisper bin dir
    const walk = (dir) => {
      const results = [];
      for (const f of fs.readdirSync(dir)) {
        const full = path.join(dir, f);
        if (fs.statSync(full).isDirectory()) results.push(...walk(full));
        else results.push(full);
      }
      return results;
    };
    const files = walk(extractDest);
    for (const f of files) {
      const name = path.basename(f);
      if (/whisper[-_]?(server|main|cli)?(\.(exe))?$/i.test(name) || /\.(exe|dll|so|dylib)$/i.test(name)) {
        try { fs.copyFileSync(f, path.join(WHISPER_BIN_DIR_HOME, name)); } catch {}
      }
    }
    // Make binaries executable on Unix
    if (!isWin) {
      for (const f of fs.readdirSync(WHISPER_BIN_DIR_HOME)) {
        try { fs.chmodSync(path.join(WHISPER_BIN_DIR_HOME, f), 0o755); } catch {}
      }
    }
    try { fs.rmSync(tmpZip); fs.rmSync(extractDest, { recursive: true }); } catch {}

    // ── Step 4: download whisper model ──────────────────────
    if (!fs.existsSync(WHISPER_MODEL_DEST)) {
      bcast('whisper:download:progress', { stage: 'model', pct: 0 });
      bcast('status', { connected, model: currentModel, message: 'Downloading ggml-base.en model (148 MB)…' });
      fs.mkdirSync(path.dirname(WHISPER_MODEL_DEST), { recursive: true });
      await downloadFile(WHISPER_MODEL_URL, WHISPER_MODEL_DEST, (pct) => {
        const now = Date.now();
        if (now - lastBcast > 500) {
          lastBcast = now;
          bcast('whisper:download:progress', { stage: 'model', pct });
          bcast('status', { connected, model: currentModel, message: `Downloading Whisper model… ${pct}%` });
        }
      });
    }

    // ── Done ─────────────────────────────────────────────────
    prefs.whisperInstalled = true;
    savePrefs();
    bcast('whisper:download:done', { success: true });
    bcast('status', { connected, model: currentModel, message: '✓ Whisper installed — voice recognition ready' });
    return true;

  } catch (err) {
    console.error('[whisper-auto] Failed:', err.message);
    bcast('whisper:download:error', { error: err.message });
    bcast('status', { connected, model: currentModel, message: `Whisper download failed: ${err.message}` });
    return false;
  }
}

async function startLlamaServer(modelId) {
  // Don't restart if same model is already running
  if (llamaProc && !llamaProc.killed && llamaLoadedModel === modelId) {
    console.log(`[llama] Already running with ${modelId}`);
    return;
  }

  let modelPath = getModelPath(modelId);

  // ── Check model exists and is not corrupted (min expected sizes in bytes) ──
  if (!modelPath || !fs.existsSync(modelPath)) {
    bcast('status', { connected: false, model: modelId, message: `Model file not found for "${modelId}" — open model selector and click DOWNLOAD` });
    console.error(`[llama] Model not found: ${modelPath}`);
    return;
  }
  const fileSize  = fs.statSync(modelPath).size;
  const minSize   = MIN_MODEL_SIZES[modelId] || 500 * 1024 * 1024;
  if (fileSize < minSize) {
    const fileSizeGB = (fileSize / 1024 / 1024 / 1024).toFixed(2);
    console.error(`[llama] Model file too small (${fileSizeGB} GB) — corrupted or incomplete download. Deleting and re-downloading.`);
    try { fs.unlinkSync(modelPath); } catch {}
    bcast('status', { connected: false, model: modelId, message: `Model was corrupted (${fileSizeGB} GB). Re-downloading…` });
    // Auto re-download
    try {
      await downloadModel(modelId);
      modelPath = getModelPath(modelId);
    } catch (e) {
      bcast('status', { connected: false, model: modelId, message: `Re-download failed: ${e.message}` });
      return;
    }
  }

  // Kill existing server
  if (llamaProc && !llamaProc.killed) {
    llamaProc.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 800));
  }

  // Find binary — check known locations then PATH then auto-download
  let llamaBin = getLlamaBin();
  const binExists = fs.existsSync(llamaBin);
  const binOnPath = !binExists && await isBinOnPath(LLAMA_SERVER_BIN);

  if (!binExists && !binOnPath) {
    // Not found anywhere — auto-download
    const downloaded = await autoDownloadLlamaServer();
    if (!downloaded) return;
    llamaBin = downloaded;
  } else if (binOnPath) {
    llamaBin = LLAMA_SERVER_BIN; // use PATH version (winget install)
    console.log('[llama] Using llama-server from system PATH (winget install)');
  }

  // ── GPU offload decision ──────────────────────────────────────────
  // Primary source: prefs.gpu set during onboarding (nvidia/amd/intel/cpu)
  // Secondary: nvidia-smi probe for nvidia
  // Modern llama.cpp embeds CUDA/Vulkan — no separate DLL needed
  const configuredThreads = prefs.threads ? parseInt(prefs.threads) : null;
  const gpuType    = prefs.gpu || 'cpu'; // 'nvidia' | 'amd' | 'intel' | 'cpu'
  const gpuAvailNv = await detectGPU();  // nvidia-smi check

  // Use GPU if onboarding said so OR if nvidia-smi confirms it
  const useGPU     = (gpuType !== 'cpu') || gpuAvailNv;
  // 99 = offload ALL layers to GPU (llama.cpp ignores extra, uses max available)
  const nGpuLayers = useGPU ? 99 : 0;
  // Fewer CPU threads when GPU is doing the work
  const threadLimit = configuredThreads || (useGPU ? 4 : CPU_THREAD_DEFAULT);

  console.log(`[llama] GPU type=${gpuType} | nvidia-smi=${gpuAvailNv} | useGPU=${useGPU} | gpu_layers=${nGpuLayers} | threads=${threadLimit}`);
  console.log(`[llama] Model path: ${modelPath}`);
  console.log(`[llama] Binary:     ${llamaBin}`);

  const gpuLabel = { nvidia:'CUDA (RTX/GTX)', amd:'Vulkan (AMD)', intel:'Vulkan (Intel)', cpu:'CPU only' }[gpuType] || gpuType;
  bcast('status', { connected: false, model: modelId, message: `Loading model… GPU: ${gpuLabel} (${nGpuLayers} layers offloaded)` });

  // Smart ctx-size: use tuning prefs, else scale by RAM
  const ramGB = Math.round(require('os').totalmem() / (1024**3));
  const defaultCtx = ramGB >= 16 ? 8192 : ramGB >= 8 ? 4096 : 2048;
  const ctxSize = prefs.tuneCtx || defaultCtx;
  const batchSz = prefs.tuneBatch || 512;

  const args = [
    '--model',          modelPath,
    '--port',           String(LLAMA_SERVER_PORT),
    '--host',           '127.0.0.1',
    '--threads',        String(threadLimit),
    '--ctx-size',       String(ctxSize),
    '--batch-size',     String(batchSz),
    '--n-gpu-layers',   String(nGpuLayers),
  ];

  // Force GPU usage when available
  if (useGPU) {
    args.push('--main-gpu', '0');  // always use first GPU
  }

  // For Vulkan builds (AMD/Intel), add explicit backend flag (some builds need it)
  if (gpuType === 'amd' || gpuType === 'intel') {
    args.push('--gpu-layers', String(nGpuLayers));
  }

  console.log(`[llama] Args: ${args.join(' ')}`);

  const resolvedBinDir = getLlamaBinDir();
  // Build GPU-specific env vars
  const gpuEnv = {};
  if (gpuType === 'nvidia') {
    gpuEnv.CUDA_VISIBLE_DEVICES      = '0';
    gpuEnv.CUDA_DEVICE_ORDER         = 'PCI_BUS_ID';
    gpuEnv.GGML_CUDA_NO_PINNED       = '0';
  } else if (gpuType === 'amd' || gpuType === 'intel') {
    gpuEnv.GGML_VULKAN_DEVICE        = '0';
    gpuEnv.VK_ICD_FILENAMES          = process.env.VK_ICD_FILENAMES || '';
  }

  llamaProc = spawn(llamaBin, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: resolvedBinDir,
    env: {
      ...process.env,
      ...gpuEnv,
      PATH: `${resolvedBinDir}${path.delimiter}${LLAMA_BIN_DIR_HOME}${path.delimiter}${process.env.PATH}`,
    },
  });

  let lastStderr = '';
  llamaProc.stdout.on('data', d => {
    const s = d.toString().trim();
    if (s) console.log('[llama-out]', s);
  });
  llamaProc.stderr.on('data', d => {
    const s = d.toString().trim();
    if (s) { console.log('[llama-srv]', s); lastStderr = s.slice(-400); }
  });
  llamaProc.on('exit', (code, signal) => {
    console.log(`[llama] exit code=${code} signal=${signal} | last stderr: ${lastStderr.slice(0,200)}`);
    if (code !== 0 && code !== null) {
      const mp = getModelPath(modelId);
      const sz = mp && fs.existsSync(mp) ? fs.statSync(mp).size : 0;
      const minSz = (MIN_MODEL_SIZES[modelId] || 500 * 1024 * 1024);
      if (sz < minSz) {
        bcast('status', { connected, model: modelId,
          message: `Model file corrupt (${(sz/1e9).toFixed(1)}GB) — open Model Selector → DOWNLOAD` });
        try { fs.unlinkSync(mp); } catch {}
      } else {
        const reason = lastStderr ? lastStderr.replace(/\n/g,' ').slice(0,150) : `exit ${code}`;
        bcast('status', { connected, model: modelId,
          message: `llama-server crashed: ${reason}` });
      }
    }
    llamaProc = null; llamaLoadedModel = null;
  });
  llamaProc.on('error', err => {
    if (err.code === 'ENOENT') {
      bcast('status', { connected: false, model: modelId,
        message: `llama-server.exe not found — open Model Selector and click AUTO-DOWNLOAD` });
    } else {
      bcast('status', { connected: false, model: modelId, message: `Spawn error: ${err.message}` });
    }
  });

  llamaLoadedModel = null; // will be set once server responds healthy
  await waitForLlamaServer(modelId);
}

async function waitForLlamaServer(modelId, maxMs = 120000) {
  const t0 = Date.now();
  let dotCount = 0;
  while (Date.now() - t0 < maxMs) {
    if (llamaProc === null) {
      // Process died — lastStderr was already broadcast in the exit handler
      // Just stop waiting
      return;
    }
    try {
      const res = await fetch(`${LLAMA_SERVER_URL}/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        if (data.status === 'loading model') {
          // Still loading — keep waiting
        } else {
          llamaLoadedModel = modelId;
          const gpuLabel = prefs.gpu && prefs.gpu !== 'cpu'
            ? `GPU: ${prefs.gpu.toUpperCase()} · 99 layers`
            : 'CPU mode';
          bcast('status', { connected: true, model: llamaLoadedModel,
            message: `✓ Ready · ${gpuLabel}` });
          return;
        }
      }
    } catch {}
    dotCount++;
    if (dotCount % 4 === 0) {
      const secs = Math.round((Date.now() - t0) / 1000);
      bcast('status', { connected, model: modelId,
        message: `Loading model into memory… ${secs}s (first load takes 15-30s)` });
    }
    await new Promise(r => setTimeout(r, 500));
  }
  bcast('status', { connected, model: modelId,
    message: `llama-server load timed out after ${maxMs/1000}s — model may be too large for your RAM` });
}

async function detectGPU() {
  // If user told us their GPU type in onboarding, trust it
  if (prefs.gpu && prefs.gpu !== 'cpu') return true;
  // Otherwise try nvidia-smi as a live check
  return new Promise(r => exec('nvidia-smi', err => r(!err))).catch(() => false);
}

// Poll /health until server responds OK or timeout expires
async function waitForLlamaReady(maxMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const res = await fetch(`${LLAMA_SERVER_URL}/health`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        // status='ok' means loaded; 'loading model' means still loading; blank/200 = older build = ready
        if (data.status === 'ok' || data.status === 'no slot available' || !data.status) return true;
        if (data.status !== 'loading model') return true;
      }
    } catch {}
    await new Promise(r => setTimeout(r, 600));
  }
  return false;
}

// ═══════════════════════════════════════════════════════════
//  GGUF DOWNLOAD — native Node https (no curl/wget dependency)
// ═══════════════════════════════════════════════════════════
function downloadFile(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const doGet = (u) => {
      const mod = u.startsWith('https') ? https : http;
      mod.get(u, {
        headers: {
          'User-Agent': 'Jane-Visrodeck/1.8.0',
          'Accept':     'application/octet-stream, */*',
        }
      }, res => {
        // Follow redirects 
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          const loc = res.headers.location;
          if (!loc) return reject(new Error('Redirect with no Location header'));
          res.resume(); // discard response body
          return doGet(loc.startsWith('http') ? loc : new URL(loc, u).toString());
        }

        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${u}`));
        }

        const total = parseInt(res.headers['content-length'] || '0', 10);
        let downloaded = 0;

        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        const out = fs.createWriteStream(destPath);

        res.on('data', chunk => {
          downloaded += chunk.length;
          if (total > 0 && onProgress) {
            const pct = Math.round((downloaded / total) * 100);
            onProgress(pct, downloaded, total);
          }
        });

        res.pipe(out);
        out.on('finish', () => {
          out.close(closeErr => {
            if (closeErr) return reject(closeErr);
            const size = fs.existsSync(destPath) ? fs.statSync(destPath).size : 0;
            if (size < 1024 * 1024) {
              reject(new Error(`Downloaded file too small (${size} bytes) — download may have failed`));
            } else {
              resolve(destPath);
            }
          });
        });
        out.on('error', err => {
          try { fs.unlinkSync(destPath); } catch {}
          reject(err);
        });
        res.on('error', err => {
          try { fs.unlinkSync(destPath); } catch {}
          reject(err);
        });
      });
    };

    doGet(url);
  });
}

async function downloadModel(modelId) {
  const urls = GGUF_URLS[modelId];
  const dest = getModelPath(modelId);
  if (!urls || !dest) throw new Error(`Unknown model: ${modelId}`);

  // Clean up any partial file
  try { if (fs.existsSync(dest)) fs.unlinkSync(dest); } catch {}

  bcast('ollama:pull:progress', { model: modelId, status: 'Starting download…', pct: 0 });

  let lastError = null;
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    console.log(`[Download] Trying URL ${i + 1}/${urls.length}: ${url}`);
    bcast('ollama:pull:progress', { model: modelId, status: `Trying mirror ${i + 1}/${urls.length}…`, pct: 0 });

    try {
      let lastPct = -1;
      await downloadFile(url, dest, (pct, dl, total) => {
        if (pct !== lastPct) {
          lastPct = pct;
          const dlMB    = (dl / 1024 / 1024).toFixed(0);
          const totalMB = (total / 1024 / 1024).toFixed(0);
          bcast('ollama:pull:progress', {
            model: modelId,
            status: `Downloading ${dlMB}MB / ${totalMB}MB (${pct}%)`,
            pct,
          });
        }
      });
      // Success!
      bcast('ollama:pull:done', { model: modelId, success: true });
      return dest;
    } catch (err) {
      console.error(`[Download] Mirror ${i + 1} failed: ${err.message}`);
      lastError = err;
      try { if (fs.existsSync(dest)) fs.unlinkSync(dest); } catch {}
    }
  }

  // All mirrors failed
  throw new Error(`All download mirrors failed. Last error: ${lastError?.message}`);
}

// ── State ─────────────────────────────────────────────────────────────
let win = null, overlayWin = null, floatWin = null, glowWin = null;
let vre = null, agent = null, vreProc = null;
let connected = false, running = false, currentModel = MODEL_DEFAULT;
let floatEnabled = false;

function send(w, ch, d) { try { if (w && !w.isDestroyed()) w.webContents.send(ch, d); } catch {} }
function bcast(ch, d) {
  [win, overlayWin, floatWin, glowWin].forEach(w => send(w, ch, d));
}

// ── Glow overlay ──────────────────────────────────────────────────────
function createGlowOverlay() {
  if (glowWin && !glowWin.isDestroyed()) return;
  const { size } = screen.getPrimaryDisplay();
  glowWin = new BrowserWindow({
    width: size.width, height: size.height, x: 0, y: 0,
    frame: false, transparent: true, alwaysOnTop: true,
    skipTaskbar: true, focusable: false, resizable: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  glowWin.loadFile(path.join(__dirname, 'renderer', 'glow.html'));
  glowWin.setIgnoreMouseEvents(true);
  glowWin.setAlwaysOnTop(true, 'screen-saver', 3);
  glowWin.setVisibleOnAllWorkspaces(true);
  glowWin.on('closed', () => { glowWin = null; });
}

// ── VRE spawn ─────────────────────────────────────────────────────────
async function spawnVRE() {
  if (!fs.existsSync(VRE_ENTRY)) { console.error('[Jane] VRE not found:', VRE_ENTRY); return; }
  const lock = path.join(os.homedir(), '.visrodeck', 'vre.lock');
  try { if (fs.existsSync(lock)) fs.unlinkSync(lock); } catch {}

  // Root node_modules (contains ws, uuid needed by VRE)
  const rootNodeModules = path.join(RESOURCES, 'node_modules');

  // Check if root deps are installed — if not, install them
  if (!fs.existsSync(path.join(rootNodeModules, 'ws'))) {
    console.log('[Jane] Installing VRE dependencies (ws, uuid)...');
    await new Promise((res, rej) => {
      const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      spawn(npm, ['install', '--prefer-offline'], { cwd: RESOURCES, stdio: 'inherit' })
        .on('close', code => code === 0 ? res() : rej(new Error(`npm install failed: ${code}`)));
    }).catch(e => console.error('[Jane] VRE dep install failed:', e.message));
  }

  const gpuAvail    = (prefs.gpu && prefs.gpu !== 'cpu') || await detectGPU();
  const threadLimit = gpuAvail ? 4 : CPU_THREAD_DEFAULT;

  vreProc = spawn(process.execPath, [VRE_ENTRY], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE:   '1',
      // Set NODE_PATH so VRE can find ws/uuid from root node_modules
      NODE_PATH:               rootNodeModules,
      JANE_NUM_THREADS:        String(threadLimit),
      JANE_GPU_AVAILABLE:      gpuAvail ? '1' : '0',
      JANE_MODELS_DIR:         MODELS_DIR,
      JANE_MODEL_PATH:         getModelPath(currentModel) || '',
      JANE_MODEL_ID:           currentModel,
      JANE_LLAMA_SERVER_URL:   LLAMA_SERVER_URL,
      LLM_BACKEND:             'llama-server',
      LLM_SERVER_URL:          LLAMA_SERVER_URL,
    },
    cwd: RESOURCES,
  });
  vreProc.stdout.on('data', d => console.log('[VRE]', d.toString().trim()));
  vreProc.stderr.on('data', d => console.error('[VRE-ERR]', d.toString().trim()));
  vreProc.on('exit', (code) => { vreProc = null; console.log('[VRE] exit', code); });
}

function waitForVRE(ms = 20000) {
  const net  = require('net');
  const lock = path.join(os.homedir(), '.visrodeck', 'vre.lock');
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    function check() {
      if (Date.now() - t0 > ms) return reject(new Error('VRE timed out'));
      if (!fs.existsSync(lock)) return setTimeout(check, 300);
      let port; try { port = JSON.parse(fs.readFileSync(lock, 'utf8')).port; } catch {}
      if (!port) return setTimeout(check, 300);
      probe(port);
    }
    function probe(port) {
      if (Date.now() - t0 > ms) return reject(new Error('VRE port never opened'));
      const s = new net.Socket();
      s.setTimeout(500);
      s.once('connect', () => { s.destroy(); resolve(); });
      s.once('error',   () => { s.destroy(); setTimeout(() => probe(port), 250); });
      s.once('timeout', () => { s.destroy(); setTimeout(() => probe(port), 250); });
      s.connect(port, '127.0.0.1');
    }
    check();
  });
}

// ── Window factory ────────────────────────────────────────────────────
let onboardWin = null;

function createOnboardingWindow(mode = 'setup') {
  if (onboardWin && !onboardWin.isDestroyed()) { onboardWin.focus(); return; }
  onboardWin = new BrowserWindow({
    width: 560, height: 700, minWidth: 480, minHeight: 600,
    frame: false, backgroundColor: '#080808', show: false, resizable: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  const url = `file://${path.join(__dirname, 'renderer', 'onboarding.html')}?mode=${mode}`;
  onboardWin.loadURL(url);
  onboardWin.once('ready-to-show', () => onboardWin.show());
  onboardWin.on('closed', () => {
    onboardWin = null;
    // Only open main window if it wasn't already open (first-run path)
    if (mode === 'setup' && (!win || win.isDestroyed())) createWindow('index.html');
  });
}

function createWindow(page) {
  const isAct = page === 'activate.html';
  win = new BrowserWindow({
    width: isAct ? 540 : 1180, height: isAct ? 580 : 760,
    minWidth: isAct ? 540 : 900, minHeight: isAct ? 580 : 560,
    frame: false, backgroundColor: '#080808', show: false, resizable: !isAct,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  win.loadFile(path.join(__dirname, 'renderer', page));
  win.once('ready-to-show', () => { win.show(); if (!isAct) startEverything(); });
  if (!IS_PACKED && process.argv.includes('--dev')) win.webContents.openDevTools({ mode: 'detach' });
}

function createOverlay() {
  if (overlayWin && !overlayWin.isDestroyed()) { overlayWin.show(); overlayWin.focus(); return; }
  overlayWin = new BrowserWindow({
    width: 320, height: 460, frame: false, backgroundColor: '#080808',
    alwaysOnTop: true, skipTaskbar: true, resizable: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  overlayWin.loadFile(path.join(__dirname, 'renderer', 'overlay.html'));
  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  const { workAreaSize } = screen.getPrimaryDisplay();
  overlayWin.setPosition(workAreaSize.width - 340, workAreaSize.height - 480);
  overlayWin.once('ready-to-show', () => {
    overlayWin.show();
    send(overlayWin, 'status', { connected, model: currentModel, message: connected ? 'Ready' : 'Connecting…' });
  });
  overlayWin.on('closed', () => { overlayWin = null; });
}

function createFloat() {
  if (floatWin && !floatWin.isDestroyed()) { floatWin.show(); return; }
  const { workAreaSize } = screen.getPrimaryDisplay();
  const W = 360, H = 60; // collapsed height; JS expands via resize IPC
  floatWin = new BrowserWindow({
    width: W, height: H,
    x: Math.round(workAreaSize.width / 2 - W / 2),
    y: workAreaSize.height - H - 20,
    frame: false, transparent: true, backgroundColor: '#00000000',
    alwaysOnTop: true, skipTaskbar: true, resizable: false, movable: true, focusable: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  floatWin.loadFile(path.join(__dirname, 'renderer', 'float.html'));
  floatWin.setAlwaysOnTop(true, 'screen-saver', 2);
  floatWin.setVisibleOnAllWorkspaces(true);
  floatWin.once('ready-to-show', () => { floatWin.show(); send(floatWin, 'status', { connected, model: currentModel, message: connected ? 'Ready' : 'Connecting…' }); });
  floatWin.on('closed', () => { floatWin = null; });
}

function destroyFloat() {
  if (floatWin && !floatWin.isDestroyed()) floatWin.close();
  floatWin = null;
}

// ── Boot ──────────────────────────────────────────────────────────────
async function startEverything() {
  loadPrefs();
  bcast('status', { connected: false, model: currentModel, message: 'Starting Jane…' });

  // Move any GGUFs sitting in wrong directories → ~/.visrodeck/models/
  await migrateModels();

  // Start VRE first (tools work without LLM)
  await spawnVRE();
  try {
    await waitForVRE();
    await connectToVRE();
  } catch (err) {
    bcast('status', { connected: false, model: currentModel, message: `VRE failed: ${err.message}` });
    return;
  }

  // Find a model to use
  const installed = listInstalledModels();
  if (!isModelInstalled(currentModel) && installed.length > 0) {
    currentModel = installed[0];
  }

  // Start llama-server with default model (if installed)
  if (isModelInstalled(currentModel)) {
    bcast('status', { connected: true, model: currentModel, message: 'Loading AI model… (this may take 30s)' });
    await startLlamaServer(currentModel).catch(err => {
      console.error('[llama] Failed to start:', err.message);
      bcast('status', { connected: true, model: currentModel,
        message: `⚠ llama-server failed to start: ${err.message}` });
    });
  } else {
    bcast('status', {
      connected: true, needsInstall: true,
      model: currentModel,
      message: '⚠ No models found — open model selector (top bar) and click DOWNLOAD',
    });
  }
}

async function connectToVRE() {
  bcast('status', { connected: false, model: currentModel, message: 'Connecting to VRE…' });
  vre = new VREClient();
  try {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    manifest.workspace = WORKSPACE;
    await vre.connect();
    await vre.register(manifest);
  } catch (err) {
    bcast('status', { connected: false, model: currentModel, message: `VRE connect failed — retrying… (${err.message})` });
    setTimeout(connectToVRE, 4000);
    return;
  }
  connected = true;
  agent = new JaneAgent(vre, currentModel, buildPersonalization());
  fs.mkdirSync(WORKSPACE, { recursive: true });
  // Show connecting status — llama-server startup will update once it's actually ready
  bcast('status', { connected: true, model: currentModel, message: 'VRE ready · loading AI model…' });
  vre.on('approval_request', p => bcast('approval', p));
  vre.on('disconnected', () => {
    connected = false;
    bcast('status', { connected: false, model: currentModel, message: 'VRE disconnected — reconnecting…' });
    setTimeout(connectToVRE, 3000);
  });
}

// ── Screen capture ────────────────────────────────────────────────────
// screen:capture_vision is registered below with the other IPC handlers

// ═══════════════════════════════════════════════════════════
//  IPC HANDLERS
// ═══════════════════════════════════════════════════════════

// ── Model download (native Node https, no curl) ───────────────────────
ipcMain.handle('ollama:pull', async (_, modelId) => {
  if (!SUPPORTED_MODELS.includes(modelId)) {
    bcast('ollama:pull:done', { model: modelId, success: false, error: 'Unknown model' });
    return false;
  }
  try {
    await downloadModel(modelId);
    if (!llamaProc || llamaProc.killed) {
      await startLlamaServer(modelId).catch(() => {});
    }
    return true;
  } catch (e) {
    console.error('[Download]', e.message);
    bcast('ollama:pull:done', { model: modelId, success: false, error: e.message });
    return false;
  }
});

// ── Model list & set ──────────────────────────────────────────────────
// ── Model list — includes custom GGUFs from models dir ───────────────
ipcMain.handle('model:list', async () => {
  const installed = listInstalledModels();
  // Also scan for any custom .gguf files not in SUPPORTED_MODELS
  const customModels = [];
  try {
    fs.mkdirSync(MODELS_DIR, { recursive: true });
    const files = fs.readdirSync(MODELS_DIR).filter(f => f.endsWith('.gguf'));
    for (const f of files) {
      const knownFile = Object.values(GGUF_FILES).find(v => v === f);
      if (!knownFile) {
        // Custom model — use filename without .gguf as ID
        const customId = 'custom:' + f.replace(/\.gguf$/i, '');
        customModels.push({ id: customId, file: f, custom: true });
      }
    }
  } catch {}
  return { models: installed.length ? installed : [], custom: customModels };
});

// ── Open models folder in Explorer/Finder ────────────────────────────
ipcMain.handle('model:open_folder', async () => {
  const { shell } = require('electron');
  fs.mkdirSync(MODELS_DIR, { recursive: true });
  await shell.openPath(MODELS_DIR);
  return { path: MODELS_DIR };
});

// ── Trigger llama-server auto-download ───────────────────────────────
ipcMain.handle('llama:download', async () => {
  const bin = await autoDownloadLlamaServer();
  return { success: !!bin, path: bin };
});



ipcMain.on('model:set', async (_, model) => {
  currentModel = model;
  bcast('status', { connected, model, message: `Loading ${model}…` });
  // Restart llama-server with new model
  await startLlamaServer(model).catch(err => {
    bcast('status', { connected, model, message: `Failed to load ${model}: ${err.message}` });
  });
  if (vre && connected) agent = new JaneAgent(vre, model, buildPersonalization());
  bcast('status', { connected, model, message: `Model ready: ${model}` });
});

// ── Whisper.cpp voice transcription ──────────────────────────────────
ipcMain.handle('voice:whisper_transcribe', async (_, audioPath) => {
  const whisperBin   = findWhisperBin();
  const whisperModel = findWhisperModel();

  if (!whisperBin) {
    return { method: 'sapi', note: 'whisper.cpp not found — place in dependencies/whisper.cpp/' };
  }
  if (!whisperModel) {
    return { method: 'sapi', note: 'Whisper model not found — place ggml-base.en.bin in assets/models/' };
  }

  return new Promise((resolve) => {
    const whisperDir = path.dirname(whisperBin);
    const args = ['-m', whisperModel, '-f', audioPath, '--output-txt', '--no-timestamps', '-l', 'en'];
    const proc = spawn(whisperBin, args, {
      cwd: whisperDir,
      env: { ...process.env, PATH: `${whisperDir}${path.delimiter}${process.env.PATH}` },
    });
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => stdout += d.toString());
    proc.stderr.on('data', d => stderr += d.toString());
    proc.on('exit', (code) => {
      if (code !== 0) { resolve({ method: 'whisper', error: `exit ${code}` }); return; }
      const transcript = stdout.split('\n')
        .filter(l => l.trim() && !l.startsWith('[') && !l.includes('-->'))
        .join(' ').trim();
      resolve({ method: 'whisper', transcript });
    });
    proc.on('error', err => resolve({ method: 'sapi', error: err.message }));
  });
});

ipcMain.on('onboard:open', () => createOnboardingWindow('setup'));
ipcMain.on('onboard:open-settings', () => createOnboardingWindow('settings'));

// ── Island / FLOAT ────────────────────────────────────────────────────
ipcMain.on('island:toggle', (_, e) => { floatEnabled = e; e ? createFloat() : destroyFloat(); });
ipcMain.on('island:wakeword', () => { if (!overlayWin || overlayWin.isDestroyed()) createOverlay(); send(overlayWin, 'island:activated', {}); });
ipcMain.on('island:send', async (_, text) => {
  if (!text?.trim() || !connected || running) return;
  running = true;
  try {
    await agent.run(text.trim(), {
      onStatus: msg => bcast('status', { connected, model: currentModel, message: msg }),
      onEvent: evt => {
        bcast('agent:event', evt);
        if (evt.type === 'tool_call') { if (!glowWin || glowWin.isDestroyed()) createGlowOverlay(); setTimeout(() => send(glowWin, 'glow:start', {}), 200); }
        if (['tool_result','response','error'].includes(evt.type)) send(glowWin, 'glow:stop', {});
      },
    });
  } catch (err) { bcast('agent:event', { type: 'error', message: err.message }); }
  finally { running = false; bcast('status', { connected, model: currentModel, message: 'Ready' }); bcast('agent:done', {}); send(glowWin, 'glow:stop', {}); }
});
ipcMain.on('island:resize', (_, { w, h }) => {
  if (!floatWin || floatWin.isDestroyed()) return;
  const { workAreaSize } = screen.getPrimaryDisplay();
  floatWin.setSize(Math.round(w), Math.round(h));
  floatWin.setPosition(
    Math.round(workAreaSize.width / 2 - w / 2),
    workAreaSize.height - Math.round(h) - 20
  );
});

// ── Activation ────────────────────────────────────────────────────────
ipcMain.handle('activation:check', () => activation.checkLicense());
ipcMain.handle('activation:activate', async (_, key) => {
  const r = activation.activate(key);
  if (r.success) { const old = win; createWindow('index.html'); setTimeout(() => old.close(), 400); }
  return r;
});
ipcMain.handle('activation:info', () => ({ ...activation.checkLicense(), hostname: os.hostname(), platform: process.platform }));

// ── Chat ──────────────────────────────────────────────────────────────
ipcMain.on('chat:send', async (_, { text, model }) => {
  if (!connected || running || !text?.trim()) return;

  const hasImage   = text.includes('[IMAGE_ATTACHED]');
  const LLAVA_MODEL = 'llava:1.5';
  const prevModel  = currentModel;

  // Auto-switch to LLaVA for vision
  if (hasImage && currentModel !== LLAVA_MODEL) {
    // Check LLaVA GGUF exists before trying to switch
    const llavaPath = getModelPath(LLAVA_MODEL);
    if (!llavaPath || !fs.existsSync(llavaPath)) {
      bcast('agent:event', { type: 'error', message: `LLaVA model not downloaded. Open the Model Selector and download "LLaVA 1.5" first (~4 GB). Until then, image analysis is unavailable.` });
      bcast('agent:done', {});
      // Still send the text part without the image
      const textOnly = text.replace(/\[IMAGE_ATTACHED\][\s\S]*?\[\/IMAGE_ATTACHED\]\n?/g, '').trim();
      if (textOnly && vre) {
        running = true;
        try {
          await agent.run(textOnly, {
            onStatus: msg => bcast('status', { connected, model: currentModel, message: msg }),
            onEvent:  evt => { if (evt.type === 'chunk') { bcast('chat:chunk', { text: evt.text }); return; } bcast('agent:event', evt); },
          });
        } catch(err) { bcast('agent:event', { type: 'error', message: err.message }); }
        finally { running = false; bcast('status', { connected, model: currentModel, message: 'Ready' }); bcast('agent:done', {}); }
      }
      return;
    }

    currentModel = LLAVA_MODEL;
    bcast('status', { connected, model: LLAVA_MODEL, message: 'Loading LLaVA for vision…' });
    try {
      await startLlamaServer(LLAVA_MODEL);
      // Wait up to 15s for server to be ready
      const ready = await waitForLlamaReady(15000);
      if (!ready) throw new Error('LLaVA server did not become ready in time');
    } catch (err) {
      bcast('agent:event', { type: 'error', message: `LLaVA load failed: ${err.message}` });
      bcast('agent:done', {});
      currentModel = prevModel;
      await startLlamaServer(prevModel).catch(() => {});
      return;
    }
    if (vre) agent = new JaneAgent(vre, LLAVA_MODEL, buildPersonalization());
    bcast('model:auto_switched', { from: prevModel, to: LLAVA_MODEL, reason: 'Image attached' });
  } else if (!hasImage && model && model !== currentModel) {
    currentModel = model;
    await startLlamaServer(model).catch(() => {});
    if (vre) agent = new JaneAgent(vre, currentModel, buildPersonalization());
  }

  running = true;
  try {
    await agent.run(text.trim(), {
      onStatus: msg => bcast('status', { connected, model: currentModel, message: msg }),
      onEvent: evt => {
        // Stream chunks as separate broadcast for real-time rendering
        if (evt.type === 'chunk') {
          bcast('chat:chunk', { text: evt.text });
          return; // don't also send as agent:event
        }
        bcast('agent:event', evt);
        if (evt.type === 'model_switched') bcast('model:auto_switched', { from: evt.from, to: evt.to, reason: evt.reason });
        if (evt.type === 'tool_call') { if (!glowWin || glowWin.isDestroyed()) createGlowOverlay(); setTimeout(() => send(glowWin, 'glow:start', {}), 200); }
        if (['tool_result','response','error'].includes(evt.type)) send(glowWin, 'glow:stop', {});
      },
    });
  } catch (err) { bcast('agent:event', { type: 'error', message: err.message }); }
  finally {
    running = false;
    // Switch back to previous model after vision
    if (hasImage && prevModel !== LLAVA_MODEL && prevModel) {
      currentModel = prevModel;
      bcast('status', { connected, model: currentModel, message: `Switching back to ${prevModel}…` });
      startLlamaServer(prevModel).then(() => {
        if (vre) agent = new JaneAgent(vre, currentModel, buildPersonalization());
        bcast('status', { connected, model: currentModel, message: 'Ready' });
      }).catch(() => bcast('status', { connected, model: currentModel, message: 'Ready' }));
    } else {
      bcast('status', { connected, model: currentModel, message: 'Ready' });
    }
    bcast('agent:done', {});
    send(glowWin, 'glow:stop', {});
  }
});
ipcMain.on('chat:reset', () => { if (agent) agent.reset(); });

// ── Cloud API calls (OpenAI / Gemini) ────────────────────────────────
ipcMain.handle('cloud:api_call', async (_, { provider, key, model, messages }) => {
  const https = require('https');

  if (provider === 'openai') {
    const selectedModel = model || 'gpt-4o-mini';
    const body = JSON.stringify({ model: selectedModel, messages, max_tokens: 1500, stream: false });
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.openai.com', path: '/v1/chat/completions', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}`, 'Content-Length': Buffer.byteLength(body) }
      }, r => {
        let d = '';
        r.on('data', c => d += c);
        r.on('end', () => {
          try {
            const j = JSON.parse(d);
            if (j.error) return resolve({ error: j.error.message });
            resolve({ content: j.choices?.[0]?.message?.content || '', model: selectedModel });
          } catch(e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.write(body); req.end();
    });
  }

  if (provider === 'gemini') {
    const selectedModel = model || 'gemini-1.5-flash';
    const body = JSON.stringify({
      contents: messages
        .filter(m => m.role !== 'system')
        .map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
      systemInstruction: messages.find(m => m.role === 'system')
        ? { parts: [{ text: messages.find(m => m.role === 'system').content }] }
        : undefined,
      generationConfig: { maxOutputTokens: 1500 }
    });
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'generativelanguage.googleapis.com',
        path: `/v1beta/models/${selectedModel}:generateContent?key=${key}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      }, r => {
        let d = '';
        r.on('data', c => d += c);
        r.on('end', () => {
          try {
            const j = JSON.parse(d);
            if (j.error) return resolve({ error: j.error.message || j.error.status });
            resolve({ content: j.candidates?.[0]?.content?.parts?.[0]?.text || '', model: selectedModel });
          } catch(e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.write(body); req.end();
    });
  }

  return { error: `Unknown provider: ${provider}` };
});

// ── Device control (HTTP relay) ───────────────────────────────────────
ipcMain.handle('device:send_command', async (_, { host, cmd }) => {
  const http  = require('http');
  const https = require('https');
  const isHttps = host.startsWith('https://');
  const url = host.startsWith('http') ? `${host}${cmd}` : `http://${host}${cmd}`;
  return new Promise((resolve) => {
    const lib = isHttps ? https : http;
    lib.get(url, { timeout: 5000 }, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => resolve({ ok: true, status: r.statusCode, body: d.slice(0, 200) }));
    }).on('error', e => resolve({ ok: false, error: e.message }));
  });
});

// ── Screen capture fix — ensure LLAMA_SERVER_URL is in env ───────────
// (already set in startVRE, this is a safety reassign)
ipcMain.handle('screen:capture_vision', async () => {
  try {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1280, height: 720 } });
    if (!sources.length) return { success: false, error: 'No screen sources found' };
    const best = sources[0];
    const resized = best.thumbnail.resize({ width: 960, height: 540, quality: 'better' });
    return { success: true, image: resized.toJPEG(75).toString('base64'), format: 'jpeg' };
  } catch (e) { return { success: false, error: e.message }; }
});

// ── AI title generation ───────────────────────────────────────────────
ipcMain.handle('chat:title', async (_, messages) => {
  if (!agent || !connected) { const f = messages?.find(m => m.role === 'user'); return String(f?.text || f?.content || 'Conversation').slice(0, 46); }
  return await agent.generateTitle(messages).catch(() => 'Conversation');
});

// ── Approval ──────────────────────────────────────────────────────────
ipcMain.on('approval:respond', async (_, { approvalId, approved }) => { if (vre) await vre.respondApproval(approvalId, approved).catch(() => {}); });

// ── Voice ─────────────────────────────────────────────────────────────
ipcMain.on('voice:set', async (_, cfg) => { if (vre && connected) await vre.toolCall('voice.configure', cfg).catch(() => {}); });
ipcMain.on('voice:listen', async () => {
  if (!vre || !connected) return;
  const r = await vre.toolCall('voice.listen', { timeout_seconds: 8 }).catch(e => ({ error: e.message }));
  bcast('voice:transcript', r.transcript ? { transcript: r.transcript } : { error: r.error || 'No speech' });
});
ipcMain.handle('voice:list_voices', async () => vre && connected ? vre.toolCall('voice.list_voices', {}).catch(() => ({ voices: [] })) : { voices: [] });

// ── Screen ────────────────────────────────────────────────────────────
ipcMain.on('screen:consent', async (_, enabled) => { if (vre && connected) await vre.toolCall('screen.set_consent', { consent: enabled }).catch(() => {}); });

// ── Overlay ───────────────────────────────────────────────────────────
ipcMain.on('overlay:toggle', (_, show) => { if (show) createOverlay(); else if (overlayWin && !overlayWin.isDestroyed()) overlayWin.hide(); });

// ── Window controls ───────────────────────────────────────────────────
ipcMain.on('win:minimize', ev => BrowserWindow.fromWebContents(ev.sender)?.minimize());
ipcMain.on('win:maximize', ev => { const w = BrowserWindow.fromWebContents(ev.sender); w?.isMaximized() ? w.unmaximize() : w?.maximize(); });
ipcMain.on('win:close', ev => BrowserWindow.fromWebContents(ev.sender)?.close());

// ── App lifecycle ─────────────────────────────────────────────────────
let splashWin = null;

function createSplashWindow(cb) {
  splashWin = new BrowserWindow({
    width: 420, height: 320, frame: false, transparent: false,
    backgroundColor: '#070709', show: false, resizable: false, center: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  splashWin.loadFile(path.join(__dirname, 'renderer', 'splash.html'));
  splashWin.once('ready-to-show', () => {
    splashWin.show();
    // Show splash for 2.4 seconds then open main window
    setTimeout(() => {
      splashWin?.webContents?.send('splash:done');
      setTimeout(() => {
        if (splashWin && !splashWin.isDestroyed()) splashWin.close();
        splashWin = null;
        cb();
      }, 600);
    }, 2400);
  });
}

app.whenReady().then(() => {
  nativeTheme.themeSource = 'dark';
  loadPrefs();
  const lic = activation.checkLicense();
  if (!lic.activated) {
    createWindow('activate.html');
  } else if (!prefs.onboardDone) {
    createOnboardingWindow();
  } else {
    // Show splash then main window
    createSplashWindow(() => createWindow('index.html'));
  }
  globalShortcut.register(prefs.hotkeys?.main || 'Alt+Space', () => {
    if (!overlayWin || overlayWin.isDestroyed()) createOverlay();
    else overlayWin.isVisible() ? overlayWin.hide() : (overlayWin.show(), overlayWin.focus());
  });
  globalShortcut.register(prefs.hotkeys?.float || 'Alt+J', () => {
    floatEnabled = !floatEnabled; floatEnabled ? createFloat() : destroyFloat();
  });
  // Screen capture shortcut
  const screenHk = prefs.hotkeys?.screen || 'Alt+S';
  globalShortcut.register(screenHk, async () => {
    if (!win || win.isDestroyed()) return;
    const result = await ipcMain.emit('screen:capture_vision'); // triggers the handler
    bcast('hotkey:screen_capture', {});
  });
});

app.on('before-quit', () => {
  globalShortcut.unregisterAll();
  if (llamaProc) { try { llamaProc.kill('SIGTERM'); } catch {} }
  if (vreProc)   { try { vreProc.kill('SIGTERM'); } catch {} }
  if (vre) vre.disconnect();
});

app.on('window-all-closed', () => app.quit());
