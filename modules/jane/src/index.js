'use strict';
const readline = require('readline');
const path     = require('path');
const fs       = require('fs');
const os       = require('os');
const VREClient = require('./vre_client');
const { JaneAgent, WORKSPACE } = require('./agent_loop');

const MANIFEST = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../manifest.json'), 'utf8')
);

// Allow overriding model via env var
MANIFEST.workspace = WORKSPACE;  // ensure workspace is set

const MODEL = process.env.JANE_MODEL || 'llama3.2:3b';

// ── ANSI helpers ────────────────────────────────────────────────────
const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  cyan:   '\x1b[36m',
  yellow: '\x1b[33m',
  green:  '\x1b[32m',
  red:    '\x1b[31m',
  magenta:'\x1b[35m',
};
const c = (color, text) => `${C[color]}${text}${C.reset}`;

function printBanner() {
  const W = 52;
  const line = '═'.repeat(W);
  console.log(c('cyan', `╔${line}╗`));
  console.log(c('cyan', `║`) + c('bold', '      Jane — Visrodeck AI System Operator     ') + c('cyan', '║'));
  console.log(c('cyan', `╚${line}╝`));
  console.log(`  Model    : ${c('yellow', MODEL)}`);
  console.log(`  Workspace: ${c('dim', WORKSPACE)}`);
  console.log(`  Commands : ${c('dim', '/reset  /history  /help  /exit')}`);
  console.log('');
}

async function main() {
  fs.mkdirSync(WORKSPACE, { recursive: true });
  printBanner();

  process.stdout.write('Connecting to VRE... ');
  const vre = new VREClient();

  try {
    await vre.connect();
  } catch (err) {
    console.log(c('red', '✗'));
    console.error(`\n${c('red', 'Error')}: ${err.message}`);
    console.error('Start VRE first:  start-vre.bat  or  ./start-vre.sh\n');
    process.exit(1);
  }

  try {
    const reg = await vre.register(MANIFEST);
    console.log(c('green', '✓') + `  (session: ${reg.token.slice(0, 8)}...)\n`);
  } catch (err) {
    console.log(c('red', '✗'));
    console.error(`Registration failed: ${err.message}\n`);
    process.exit(1);
  }

  const agent = new JaneAgent(vre, MODEL);

  // Shared readline instance
  const rl = readline.createInterface({
    input:  process.stdin,
    output: process.stdout,
    prompt: c('cyan', '\nYou > '),
  });

  // ── Approval handler uses the shared rl ──────────────────────────
  vre.on('approval_request', (payload) => {
    // Pause rl, show approval dialog, resume
    rl.pause();
    console.log('\n' + c('yellow', '┌─ ⚠  APPROVAL REQUIRED ─────────────────────────────────'));
    console.log(c('yellow', '│') + ` Module : ${payload.moduleId}`);
    console.log(c('yellow', '│') + ` Tool   : ${c('bold', payload.tool)}`);
    console.log(c('yellow', '│') + ` Params : ${JSON.stringify(payload.params)}`);
    console.log(c('yellow', '│') + ` Reason : ${payload.rationale}`);
    console.log(c('yellow', '└────────────────────────────────────────────────────────'));

    rl.resume();
    rl.question(c('yellow', 'Approve? [y/N]: '), async (answer) => {
      const approved = /^y(es)?$/i.test(answer.trim());
      try {
        await vre.respondApproval(payload.approvalId, approved);
        console.log(approved ? c('green', '✓ Approved') : c('red', '✗ Denied'));
      } catch (err) {
        console.error('Approval response error:', err.message);
      }
      console.log('');
      rl.prompt();
    });
  });

  vre.on('disconnected', () => {
    console.log(`\n${c('red', 'VRE disconnected')}. Exiting.\n`);
    process.exit(1);
  });

  console.log(`${c('dim', 'Jane is ready. Type your message and press Enter.')}`);
  console.log(`${c('dim', '─'.repeat(52))}`);
  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    // ── Built-in commands ──────────────────────────────────────────
    if (input === '/exit' || input === '/quit') {
      console.log('\nGoodbye!\n');
      vre.disconnect();
      rl.close();
      process.exit(0);
    }
    if (input === '/reset') {
      agent.reset();
      console.log(c('dim', '[Context cleared]\n'));
      rl.prompt();
      return;
    }
    if (input === '/history') {
      console.log(c('dim', `[Context contains ${agent.historySize()} message(s)]\n`));
      rl.prompt();
      return;
    }
    if (input === '/help') {
      console.log(`
${c('bold', 'Jane commands:')}
  /reset    — Clear conversation context
  /history  — Show context message count
  /exit     — Quit Jane
  /help     — Show this help

${c('bold', 'What Jane can do:')}
  - Read files anywhere on your system
  - List directories
  - Write files to her workspace (${WORKSPACE})
  - Run safe shell commands (ls, cat, grep, git status, etc.)
  - Reason with a local LLM via Ollama
  - Dangerous commands require your approval
`);
      rl.prompt();
      return;
    }

    // ── Agent loop ─────────────────────────────────────────────────
    rl.pause();

    let lastStatus = '';
    const statusLine = (msg) => {
      process.stdout.write(`\r${c('dim', msg.padEnd(60))}`);
      lastStatus = msg;
    };

    try {
      const response = await agent.run(input, { onStatus: statusLine });
      // Clear status line
      process.stdout.write('\r' + ' '.repeat(60) + '\r');
      console.log(`\n${c('bold', 'Jane')} > ${response}\n`);
    } catch (err) {
      process.stdout.write('\r' + ' '.repeat(60) + '\r');
      console.log(`\n${c('red', 'Jane')} > Error: ${err.message}\n`);
    }

    rl.resume();
    rl.prompt();
  });

  rl.on('close', () => {
    vre.disconnect();
    process.exit(0);
  });
}

main().catch(err => {
  console.error('Jane fatal error:', err);
  process.exit(1);
});
