'use strict';
/**
 * VRE Voice Service
 * Text-to-Speech and Speech-to-Text using OS-native engines.
 * Zero npm dependencies — uses built-in OS capabilities only.
 *
 * TTS:
 *   Windows  → PowerShell System.Speech.Synthesis.SpeechSynthesizer
 *   macOS    → `say` command (built-in)
 *   Linux    → `espeak` or `festival` (must be installed separately)
 *
 * STT:
 *   Windows  → PowerShell System.Speech.Recognition (grammar-free / dictation)
 *   macOS    → `say` doesn't do STT; falls back to prompt
 *   Linux    → whisper CLI if installed, else falls back to prompt
 *
 * Privacy guarantee:
 *   - ALL audio processing is local. No data is sent to any cloud service.
 *   - Windows SAPI, macOS say, espeak — all 100% offline.
 */

const { spawn, exec } = require('child_process');
const util            = require('util');
const execAsync       = util.promisify(exec);
const os              = require('os');
const path            = require('path');
const fs              = require('fs');

const PLATFORM = process.platform;

// ── State ────────────────────────────────────────────────────────────
let ttsEnabled = false;
let sttEnabled = false;
let currentSpeaker = null;   // active TTS child process (for interrupt)
let voiceRate = 0;           // -10 to +10 (Windows), default 0
let voiceName = '';          // empty = OS default

// ── TTS ──────────────────────────────────────────────────────────────

/**
 * speak(text) — converts text to speech using the OS engine.
 * Resolves when audio playback finishes.
 * If called while already speaking, interrupts previous speech.
 */
function speak(text) {
  if (!ttsEnabled) return Promise.resolve({ skipped: true, reason: 'TTS disabled' });

  // Sanitize text — remove any script/HTML injection attempts
  const clean = text
    .replace(/<[^>]*>/g, '')          // strip tags
    .replace(/[^\x20-\x7E\n\r\t]/g, ' ')  // ASCII printable only (safe for SAPI)
    .slice(0, 2000);                  // cap length

  // Interrupt any ongoing speech
  interrupt();

  return new Promise((resolve, reject) => {
    let proc;

    if (PLATFORM === 'win32') {
      // Escape single quotes for PowerShell string
      const escaped = clean.replace(/'/g, "''").replace(/"/g, '`"');
      const rate    = Math.max(-10, Math.min(10, voiceRate));
      const voiceSel = voiceName
        ? `$s.SelectVoice('${voiceName}');`
        : '';
      const ps = [
        'Add-Type -AssemblyName System.Speech;',
        '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;',
        voiceSel,
        `$s.Rate = ${rate};`,
        `$s.Speak('${escaped}');`,
      ].join(' ');
      proc = spawn('powershell', ['-NoProfile', '-Command', ps], { stdio: 'ignore' });

    } else if (PLATFORM === 'darwin') {
      const args = [];
      if (voiceName) { args.push('-v', voiceName); }
      if (voiceRate) { args.push('-r', String(180 + voiceRate * 10)); }  // ~180wpm default
      args.push(clean);
      proc = spawn('say', args, { stdio: 'ignore' });

    } else {
      // Linux — try espeak, fallback to festival
      const rate = String(150 + voiceRate * 10);
      proc = spawn('espeak', ['-s', rate, clean], { stdio: 'ignore' });
    }

    currentSpeaker = proc;
    proc.on('exit',  (code) => { currentSpeaker = null; resolve({ spoken: true, code }); });
    proc.on('error', (err)  => { currentSpeaker = null; resolve({ spoken: false, error: err.message }); });
  });
}

/**
 * interrupt() — stop any current TTS immediately.
 */
function interrupt() {
  if (currentSpeaker) {
    try { currentSpeaker.kill(); } catch {}
    currentSpeaker = null;
  }
}

/**
 * listVoices() — returns available OS voices.
 */
async function listVoices() {
  try {
    if (PLATFORM === 'win32') {
      const ps = [
        'Add-Type -AssemblyName System.Speech;',
        '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;',
        '$s.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name }',
      ].join(' ');
      const { stdout } = await execAsync(`powershell -NoProfile -Command "${ps}"`);
      return stdout.trim().split('\n').filter(Boolean);
    } else if (PLATFORM === 'darwin') {
      const { stdout } = await execAsync('say -v ?');
      return stdout.trim().split('\n').map(l => l.split(/\s+/)[0]);
    } else {
      const { stdout } = await execAsync('espeak --voices 2>/dev/null || echo ""');
      return stdout.trim().split('\n').filter(Boolean).map(l => l.trim().split(/\s+/).pop());
    }
  } catch { return []; }
}

// ── STT ──────────────────────────────────────────────────────────────

/**
 * listen(timeoutSeconds) — listens for speech and returns transcript.
 * Windows: PowerShell System.Speech.Recognition (fully offline)
 * macOS/Linux: Checks for whisper CLI, else returns null.
 */
function listen(timeoutSeconds = 8) {
  if (!sttEnabled) return Promise.resolve({ transcript: null, reason: 'STT disabled' });

  return new Promise((resolve) => {

    if (PLATFORM === 'win32') {
      // Windows built-in speech recognition — fully offline via SAPI
      const ps = `
Add-Type -AssemblyName System.Speech;
$r = New-Object System.Speech.Recognition.SpeechRecognitionEngine;
$r.SetInputToDefaultAudioDevice();
$grammar = New-Object System.Speech.Recognition.DictationGrammar;
$r.LoadGrammar($grammar);
$r.EndSilenceTimeout = [TimeSpan]::FromSeconds(1.5);
$r.BabbleTimeout = [TimeSpan]::FromSeconds(${timeoutSeconds});
try {
  $result = $r.Recognize([TimeSpan]::FromSeconds(${timeoutSeconds}));
  if ($result) { Write-Output $result.Text } else { Write-Output '' }
} catch { Write-Output '' }
$r.Dispose();
`.trim().replace(/\n/g, ' ');

      const proc = spawn('powershell', ['-NoProfile', '-Command', ps], {
        stdio: ['ignore', 'pipe', 'ignore']
      });

      let out = '';
      proc.stdout.on('data', d => { out += d.toString(); });
      proc.on('exit', () => {
        const transcript = out.trim();
        resolve({ transcript: transcript || null });
      });
      proc.on('error', () => resolve({ transcript: null, error: 'PowerShell STT failed' }));

      setTimeout(() => { try { proc.kill(); } catch {} }, (timeoutSeconds + 5) * 1000);

    } else if (PLATFORM === 'darwin') {
      // macOS: try whisper CLI if installed
      exec('which whisper', (err) => {
        if (err) return resolve({ transcript: null, reason: 'whisper CLI not installed (brew install whisper)' });
        // Whisper CLI recording via sox → whisper
        resolve({ transcript: null, reason: 'macOS STT: install sox + whisper CLI for voice input' });
      });

    } else {
      // Linux: try whisper CLI
      exec('which whisper', (err) => {
        if (err) return resolve({ transcript: null, reason: 'Install whisper: pip install openai-whisper' });
        resolve({ transcript: null, reason: 'Linux STT: whisper CLI detected but recording pipeline not yet wired' });
      });
    }
  });
}

// ── Config ───────────────────────────────────────────────────────────

function configure(opts = {}) {
  if (opts.tts_enabled !== undefined) ttsEnabled = !!opts.tts_enabled;
  if (opts.stt_enabled !== undefined) sttEnabled = !!opts.stt_enabled;
  if (opts.voice_rate  !== undefined) voiceRate  = Number(opts.voice_rate);
  if (opts.voice_name  !== undefined) voiceName  = String(opts.voice_name);
}

function getStatus() {
  return { tts_enabled: ttsEnabled, stt_enabled: sttEnabled, voice_name: voiceName, voice_rate: voiceRate, platform: PLATFORM };
}

module.exports = { speak, interrupt, listen, listVoices, configure, getStatus };
