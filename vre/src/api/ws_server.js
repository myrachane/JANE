'use strict';
const WebSocket = require('ws');
const { handleMessage, handleDisconnect } = require('./gateway');
const eventBus = require('../kernel/event_bus');

let wss;

function start(port = 7700) {
  wss = new WebSocket.Server({ host: '127.0.0.1', port });

  wss.on('connection', (ws, req) => {
    const addr = req.socket.remoteAddress;
    console.log(`[WS] Client connected: ${addr}`);
    eventBus.publish('ws.connected', { addr });

    ws.on('message', data => handleMessage(ws, data));

    ws.on('close', () => {
      handleDisconnect(ws);
      eventBus.publish('ws.disconnected', { addr });
    });

    ws.on('error', err => {
      console.error(`[WS] Client error: ${err.message}`);
    });
  });

  return new Promise((resolve, reject) => {
    wss.once('listening', () => {
      console.log(`[VRE] WebSocket server → ws://127.0.0.1:${port}`);
      resolve(wss);
    });
    wss.once('error', reject);
  });
}

function stop() {
  if (wss) { wss.close(); wss = null; }
}

module.exports = { start, stop };
