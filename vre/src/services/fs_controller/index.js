'use strict';
const fs   = require('fs');
const path = require('path');

async function read(filePath) {
  return fs.promises.readFile(filePath, 'utf8');
}

async function write(filePath, content) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  return fs.promises.writeFile(filePath, content, 'utf8');
}

async function list(dirPath) {
  const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
  return entries.map(e => ({
    name: e.name,
    type: e.isDirectory() ? 'dir' : 'file',
    path: path.join(dirPath, e.name)
  }));
}

async function remove(filePath) {
  return fs.promises.unlink(filePath);
}

async function stat(filePath) {
  const s = await fs.promises.stat(filePath);
  return { size: s.size, mtime: s.mtime.toISOString(), isDir: s.isDirectory() };
}

async function exists(filePath) {
  try { await fs.promises.access(filePath); return true; }
  catch { return false; }
}

module.exports = { read, write, list, remove, stat, exists };
