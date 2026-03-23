'use strict';
/**
 * VRE App Launcher
 * Opens applications, browsers, and performs web searches on the user's desktop.
 * Uses OS-native mechanisms — no extra dependencies.
 */
const { exec, spawn } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);
const os = require('os');

const PLATFORM = process.platform;

// ── URL-safe search ───────────────────────────────────────────────────
function buildSearchUrl(query, engine = 'google') {
  const encodedQ = encodeURIComponent(query);
  const engines = {
    google:  `https://www.google.com/search?q=${encodedQ}`,
    bing:    `https://www.bing.com/search?q=${encodedQ}`,
    ddg:     `https://duckduckgo.com/?q=${encodedQ}`,
    youtube: `https://www.youtube.com/results?search_query=${encodedQ}`,
    github:  `https://github.com/search?q=${encodedQ}`,
  };
  return engines[engine] || engines.google;
}

// ── Open URL in default browser ───────────────────────────────────────
async function openUrl(url) {
  // Must be https or http only
  try { const u = new URL(url); if (!['https:', 'http:'].includes(u.protocol)) throw new Error(); }
  catch { return { error: `Invalid or unsafe URL: ${url}` }; }

  try {
    if (PLATFORM === 'win32') {
      await execAsync(`start "" "${url.replace(/"/g, '')}"`);
    } else if (PLATFORM === 'darwin') {
      await execAsync(`open "${url.replace(/"/g, '')}"`);
    } else {
      await execAsync(`xdg-open "${url.replace(/"/g, '')}"`);
    }
    return { success: true, url };
  } catch (e) { return { error: e.message }; }
}

// ── Open web search ───────────────────────────────────────────────────
async function searchWeb(query, engine = 'google') {
  const url = buildSearchUrl(query, engine);
  const result = await openUrl(url);
  return { ...result, query, engine, url };
}

// ── Open application by name ──────────────────────────────────────────
// Known app name → executable map for Windows
const WIN_APPS = {
  'notepad':       'notepad.exe',
  'calculator':    'calc.exe',
  'paint':         'mspaint.exe',
  'explorer':      'explorer.exe',
  'task manager':  'taskmgr.exe',
  'cmd':           'cmd.exe',
  'powershell':    'powershell.exe',
  'word':          'winword.exe',
  'excel':         'excel.exe',
  'powerpoint':    'powerpnt.exe',
  'chrome':        'chrome.exe',
  'firefox':       'firefox.exe',
  'edge':          'msedge.exe',
  'vscode':        'code.exe',
  'vs code':       'code.exe',
  'spotify':       'spotify.exe',
  'discord':       'discord.exe',
  'steam':         'steam.exe',
  'obs':           'obs64.exe',
  'vlc':           'vlc.exe',
};

const MAC_APPS = {
  'safari':       'Safari',
  'chrome':       'Google Chrome',
  'firefox':      'Firefox',
  'finder':       'Finder',
  'terminal':     'Terminal',
  'vscode':       'Visual Studio Code',
  'vs code':      'Visual Studio Code',
  'spotify':      'Spotify',
  'discord':      'Discord',
  'notes':        'Notes',
  'calendar':     'Calendar',
  'calculator':   'Calculator',
};

async function openApp(appName) {
  const name = appName?.toLowerCase()?.trim();
  if (!name) return { error: 'App name is required' };

  try {
    if (PLATFORM === 'win32') {
      // Try known map first, then try directly
      const exe = WIN_APPS[name] || name;
      await execAsync(`start "" "${exe}"`, { timeout: 5000 });
      return { success: true, opened: appName };
    } else if (PLATFORM === 'darwin') {
      const app = MAC_APPS[name] || appName;
      await execAsync(`open -a "${app.replace(/"/g, '')}"`, { timeout: 5000 });
      return { success: true, opened: appName };
    } else {
      // Linux — try the name directly
      spawn(name, [], { detached: true, stdio: 'ignore' }).unref();
      return { success: true, opened: appName };
    }
  } catch (e) {
    return { error: `Could not open '${appName}': ${e.message}` };
  }
}

// ── Open a file with its default app ─────────────────────────────────
async function openFile(filePath) {
  try {
    if (PLATFORM === 'win32') {
      await execAsync(`start "" "${filePath.replace(/"/g, '')}"`);
    } else if (PLATFORM === 'darwin') {
      await execAsync(`open "${filePath.replace(/"/g, '')}"`);
    } else {
      await execAsync(`xdg-open "${filePath.replace(/"/g, '')}"`);
    }
    return { success: true, path: filePath };
  } catch (e) { return { error: e.message }; }
}

// ── Type text (simulated keystrokes — Windows PowerShell) ─────────────
async function typeText(text) {
  if (PLATFORM !== 'win32') {
    return { error: 'type_text is currently supported on Windows only' };
  }
  // Use PowerShell SendKeys (simulates keyboard input to focused window)
  const escaped = text.replace(/'/g, "''").replace(/[{}()\[\]+^%~]/g, '{$&}');
  const ps = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${escaped}')`;
  try {
    await execAsync(`powershell -NoProfile -Command "${ps}"`);
    return { success: true, typed: text.slice(0, 50) + (text.length > 50 ? '…' : '') };
  } catch (e) { return { error: e.message }; }
}

module.exports = { openUrl, searchWeb, openApp, openFile, typeText };
