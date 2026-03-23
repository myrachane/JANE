'use strict';
const path = require('path');
const fs   = require('fs');
const os   = require('os');

// ── Paths ────────────────────────────────────────────────────────────
const VRE_HOME  = process.env.VRE_HOME || path.join(os.homedir(), '.visrodeck');
process.env.VRE_DATA = path.join(VRE_HOME, 'data');
fs.mkdirSync(process.env.VRE_DATA, { recursive: true });

// ── Config ───────────────────────────────────────────────────────────
const cfgPath = path.join(__dirname, '../../config/vre.config.json');
const config  = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));

// ── Kernel services ──────────────────────────────────────────────────
const eventBus = require('./kernel/event_bus');
const svcReg   = require('./kernel/service_registry');
const llmOrch  = require('./services/llm_orchestrator');
const wsServer = require('./api/ws_server');
const audit    = require('./audit/logger');

// Register internal services
svcReg.register('event_bus',        eventBus);
svcReg.register('llm_orchestrator', llmOrch);
svcReg.register('audit_logger',     audit);

async function bootstrap() {
  const DIVIDER = '═'.repeat(50);
  console.log(DIVIDER);
  console.log('  Visrodeck Runtime Environment  v2.1.0');
  console.log('  llama-server backend — no Ollama');
  console.log(DIVIDER);

  // ── LLM: llama-server (llama.cpp) ───────────────────────────────
  // llama-server is started by jane-ui/main.js BEFORE VRE boots.
  // We just configure the URL and check it's reachable.
  const llamaCfg = {
    llama_server_url: process.env.LLM_SERVER_URL || config.llm?.llama_server_url || 'http://127.0.0.1:8080',
    default_model:    process.env.JANE_MODEL_ID  || config.llm?.default_model    || 'llama3.2:3b',
  };
  llmOrch.configure(llamaCfg);

  const serverReady = await llmOrch.checkAvailable();
  if (serverReady) {
    const models = await llmOrch.listModels();
    const names  = models.map(m => m.name).join(', ') || 'model loaded';
    console.log(`[✓] llama-server ready at ${llamaCfg.llama_server_url}`);
    console.log(`[✓] Models available : ${names}`);
  } else {
    console.log(`[!] llama-server not reachable at ${llamaCfg.llama_server_url}`);
    console.log(`    → LLM will retry on first request. Check that llama-server is running.`);
  }

  // ── WebSocket ────────────────────────────────────────────────────
  const port = config.api?.ws_port || 7700;
  await wsServer.start(port);
  console.log(`[✓] API gateway listening on ws://127.0.0.1:${port}`);

  // ── Lock file ────────────────────────────────────────────────────
  const lockFile = path.join(VRE_HOME, 'vre.lock');
  fs.writeFileSync(lockFile, JSON.stringify({ port, pid: process.pid, started: Date.now() }));
  console.log(`[✓] Lock file: ${lockFile}`);

  audit.log('kernel', 'vre.started', null, 'OK', { port, pid: process.pid, version: '2.1.0' });

  console.log(DIVIDER);
  console.log('  VRE is ready. Waiting for module connections.');
  console.log('  Press Ctrl+C to stop.');
  console.log(DIVIDER);

  // ── Graceful shutdown ────────────────────────────────────────────
  const shutdown = (signal) => {
    console.log(`\n[VRE] ${signal} received — shutting down...`);
    wsServer.stop();
    try { fs.unlinkSync(lockFile); } catch {}
    audit.log('kernel', 'vre.stopped', null, 'OK', { signal });
    process.exit(0);
  };
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // ── Event logging ────────────────────────────────────────────────
  eventBus.subscribe('module.registered',  ({ data }) =>
    console.log(`[Event] Module registered: ${data.name} (${data.id})`));
  eventBus.subscribe('module.disconnected', ({ data }) =>
    console.log(`[Event] Module disconnected: ${data.id}`));
  eventBus.subscribe('resource.warning',   ({ data }) =>
    console.warn(`[Warn]  Resource warning: ${data.moduleId} ${data.type} at ${data.usage}%`));
}

bootstrap().catch(err => {
  console.error('[VRE] Fatal bootstrap error:', err);
  process.exit(1);
});
