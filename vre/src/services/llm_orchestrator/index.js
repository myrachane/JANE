'use strict';
/**
 * VRE LLM Orchestrator v3 — Visrodeck Technology
 *
 * Backend: llama.cpp `llama-server` (OpenAI-compatible /v1/chat/completions)
 * No Ollama. No cloud. 100% local GGUF inference.
 *
 * llama-server is started by main.js with the selected GGUF model path.
 * This orchestrator communicates with it via HTTP on 127.0.0.1:8080
 *
 * Supports Auto model routing:
 *   - Vision / screen tasks   → llava:1.5
 *   - General tasks           → llama3.2:3b  (DEFAULT)
 *   - Explicit uncensored     → dolphin-mistral:7b
 *   - Refusal detected        → auto-switch to dolphin-mistral:7b
 */

const os = require('os');

let LLAMA_SERVER_URL = 'http://127.0.0.1:8080';
let DEFAULT_MODEL    = 'llama3.2:3b';
let AUTO_MODEL       = true;
let CURRENT_MODEL_ID = 'llama3.2:3b'; // track what's loaded in llama-server

const VISION_KEYWORDS = [
  'screen', 'screenshot', 'image', 'photo', 'picture', 'see', 'look at',
  'what is on', "what's on", 'describe', 'ocr', 'camera', 'visual',
  'what do you see', 'analyze image', 'read image',
];

// Refusal patterns — when detected, auto-switch to uncensored model
const REFUSAL_PATTERNS = [
  /i('m| am) (not able|unable) to (help|assist|provide)/i,
  /i can'?t (help|assist|provide|do that)/i,
  /i('m| am) sorry,? (but )?i (can'?t|cannot|won'?t)/i,
  /this (is|falls) (outside|beyond) (my|what i can)/i,
  /i (am not|won't) (going to|able to) (provide|generate|assist)/i,
  /not (appropriate|suitable) for me to/i,
  /against my (guidelines|programming|values)/i,
  /as an ai (assistant|language model|model),? i (cannot|can'?t|won'?t)/i,
];

const UNCENSORED_MODEL = 'dolphin-mistral:7b';
const VISION_MODEL     = 'llava:1.5';

function configure(cfg) {
  if (cfg.llama_server_url) LLAMA_SERVER_URL = cfg.llama_server_url;
  if (cfg.default_model)    DEFAULT_MODEL    = cfg.default_model;
  if (cfg.auto_model !== undefined) AUTO_MODEL = cfg.auto_model;
}

function setCurrentModel(modelId) {
  CURRENT_MODEL_ID = modelId;
}

function pickModel(requestedModel, messages = []) {
  if (!requestedModel || requestedModel === 'auto') {
    const lastUser = [...messages].reverse().find(m => m.role === 'user');
    const text = (lastUser?.content || '').toLowerCase();
    if (VISION_KEYWORDS.some(kw => text.includes(kw))) return VISION_MODEL;
    return DEFAULT_MODEL;
  }
  return requestedModel;
}

function isRefusal(text) {
  return REFUSAL_PATTERNS.some(p => p.test(text));
}

function getResourceOptions() {
  const totalCPU  = os.cpus().length;
  const loadAvg   = os.loadavg()[0];
  const loadRatio = loadAvg / totalCPU;
  const threadFraction = loadRatio < 0.4 ? 0.6 : 0.3;
  return {
    num_thread: Math.max(2, Math.floor(totalCPU * threadFraction)),
    num_gpu:    -1,
    num_ctx:    4096,
  };
}

async function callChatCompletions(messages, options = {}) {
  const resourceOpts = getResourceOptions();
  const body = {
    messages,
    stream:      false,
    temperature: options.temperature ?? 0.7,
    max_tokens:  options.max_tokens  ?? 2048,
    n_threads:   options.num_thread  ?? resourceOpts.num_thread,
  };

  const res = await fetch(`${LLAMA_SERVER_URL}/v1/chat/completions`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
    signal:  AbortSignal.timeout(180_000),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`llama-server HTTP ${res.status}: ${txt.slice(0, 200)}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

// Streaming variant — calls onChunk(text) for each token, returns full text
async function callChatCompletionsStream(messages, options = {}, onChunk = () => {}) {
  const resourceOpts = getResourceOptions();
  const body = {
    messages,
    stream:      true,
    temperature: options.temperature ?? 0.7,
    max_tokens:  options.max_tokens  ?? 2048,
    n_threads:   options.num_thread  ?? resourceOpts.num_thread,
  };

  const res = await fetch(`${LLAMA_SERVER_URL}/v1/chat/completions`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
    signal:  AbortSignal.timeout(180_000),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`llama-server HTTP ${res.status}: ${txt.slice(0, 200)}`);
  }

  // Parse SSE stream
  let full = '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop(); // keep incomplete line
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === 'data: [DONE]') continue;
      if (!trimmed.startsWith('data: ')) continue;
      try {
        const json = JSON.parse(trimmed.slice(6));
        const delta = json.choices?.[0]?.delta?.content || '';
        if (delta) { full += delta; onChunk(delta); }
      } catch {}
    }
  }
  return full;
}

async function infer(messages, model, options = {}) {
  const selectedModel = pickModel(model, messages);
  const onChunk = options.onChunk || null;

  let content;
  try {
    if (onChunk) {
      content = await callChatCompletionsStream(messages, options, onChunk);
    } else {
      content = await callChatCompletions(messages, options);
    }
  } catch (err) {
    throw new Error(`LLM inference failed: ${err.message}. Is llama-server running?`);
  }

  const detected_refusal = AUTO_MODEL && isRefusal(content);

  return {
    content,
    model:         CURRENT_MODEL_ID,
    selectedModel,
    done:          true,
    auto_selected: !model || model === 'auto',
    refusal_detected: detected_refusal,
    switch_to:     detected_refusal ? UNCENSORED_MODEL : null,
  };
}

async function inferWithImage(prompt, imageBase64, options = {}) {
  // Normalize: strip data URI prefix if present, detect mime type
  let rawB64  = imageBase64 || '';
  let mimeType = 'image/jpeg';
  if (rawB64.startsWith('data:')) {
    const m = rawB64.match(/^data:(image\/[^;]+);base64,(.+)$/s);
    if (m) { mimeType = m[1]; rawB64 = m[2].trim(); }
    else   { rawB64 = rawB64.replace(/^data:[^,]+,/, '').trim(); }
  }
  if (!rawB64) throw new Error('Empty image data');
  const dataUri = `data:${mimeType};base64,${rawB64}`;

  // Try OpenAI-style multimodal format first (llama.cpp >= b3000)
  const messages = [
    {
      role: 'user',
      content: [
        { type: 'text',      text: prompt },
        { type: 'image_url', image_url: { url: dataUri } }
      ]
    }
  ];

  let content;
  try {
    const res = await fetch(`${LLAMA_SERVER_URL}/v1/chat/completions`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        messages,
        stream:      false,
        temperature: options.temperature ?? 0.2,
        max_tokens:  options.max_tokens  ?? 800,
      }),
      signal: AbortSignal.timeout(120_000),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`Vision HTTP ${res.status}: ${errBody.slice(0, 200)}`);
    }

    const data = await res.json();
    content = data.choices?.[0]?.message?.content || '';
  } catch (err) {
    // Fallback: try older /completion endpoint (llama.cpp LLaVA legacy)
    try {
      const res2 = await fetch(`${LLAMA_SERVER_URL}/completion`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          prompt,
          image_data: [{ data: rawB64, id: 10 }],
          stream:     false,
          temperature: options.temperature ?? 0.2,
          n_predict:  options.max_tokens ?? 800,
        }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!res2.ok) throw new Error(`Vision legacy HTTP ${res2.status}`);
      const d2 = await res2.json();
      content = d2.content || '';
    } catch (err2) {
      throw new Error(`Vision inference failed: ${err.message} / ${err2.message}`);
    }
  }

  return { content, model: VISION_MODEL };
}

async function listModels() {
  // No Ollama — return the models we know about from GGUF files
  // main.js passes this via env var
  const modelsDir = process.env.JANE_MODELS_DIR || '';
  const fs = require('fs');
  const path = require('path');
  const GGUF_FILES = {
    'llama3.2:3b':        'Llama-3.2-3B-Instruct-Q4_K_M.gguf',
    'llava:1.5':          'llava-v1.5-7b-Q4_K_M.gguf',
    'dolphin-mistral:7b': 'dolphin-2.9.4-mistral-7b-v0.3-Q4_K_M.gguf',
  };
  const installed = [];
  for (const [id, fname] of Object.entries(GGUF_FILES)) {
    if (fs.existsSync(path.join(modelsDir, fname))) {
      installed.push({ name: id, size: 0 });
    }
  }
  return installed;
}

async function checkAvailable() {
  try {
    const res = await fetch(`${LLAMA_SERVER_URL}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch { return false; }
}

function getConfig() {
  return {
    backend:       'llama-server',
    server_url:    LLAMA_SERVER_URL,
    default_model: DEFAULT_MODEL,
    auto_model:    AUTO_MODEL,
    vision_model:  VISION_MODEL,
    uncensored_model: UNCENSORED_MODEL,
    resource_opts: getResourceOptions(),
    supported_models: [
      { id: 'auto',                label: 'Auto',              desc: 'Jane picks best model' },
      { id: 'llava:1.5',          label: 'LLaVA 1.5',         desc: 'Vision + Language'    },
      { id: 'llama3.2:3b',        label: 'Llama 3.2 3B',      desc: 'Default general'      },
      { id: 'dolphin-mistral:7b', label: 'Dolphin Mistral 7B',desc: 'Uncensored 7B'        },
    ],
  };
}

module.exports = { configure, infer, inferWithImage, listModels, checkAvailable, getConfig, pickModel, setCurrentModel, isRefusal };
