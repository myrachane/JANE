'use strict';
const { spawn }  = require('child_process');
const EventEmitter = require('events');

class ProcessManager extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(200);
    this.processes = new Map();
    this._seq = 1;
  }

  spawn(command, args = [], options = {}) {
    const id  = `proc_${this._seq++}`;
    const proc = spawn(command, args, {
      cwd:   options.cwd || process.cwd(),
      env:   { ...process.env, ...(options.env || {}) },
      shell: options.shell !== undefined ? options.shell : (process.platform === 'win32'),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const entry = {
      id, command, args,
      process: proc,
      started: Date.now(),
      status:  'running',
      stdoutBuf: [],
      stderrBuf: [],
    };

    proc.stdout.on('data', d => {
      const text = d.toString();
      entry.stdoutBuf.push(text);
      this.emit('stdout', { id, text });
    });
    proc.stderr.on('data', d => {
      const text = d.toString();
      entry.stderrBuf.push(text);
      this.emit('stderr', { id, text });
    });
    proc.on('exit', (code, signal) => {
      entry.status   = 'exited';
      entry.exitCode = code;
      this.emit('exit', { id, code, signal });
    });
    proc.on('error', err => {
      entry.status = 'error';
      entry.error  = err.message;
      this.emit('proc_error', { id, error: err.message });
    });

    this.processes.set(id, entry);
    return { id, process: proc };
  }

  kill(id) {
    const e = this.processes.get(id);
    if (!e || e.status !== 'running') return false;
    e.process.kill();
    e.status = 'killed';
    return true;
  }

  list() {
    return Array.from(this.processes.values()).map(e => ({
      id: e.id, command: e.command, status: e.status,
      started: e.started, exitCode: e.exitCode
    }));
  }
}

module.exports = new ProcessManager();
