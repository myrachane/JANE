'use strict';
const EventEmitter = require('events');

class VREEventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(500);
    this._log = [];
  }

  publish(topic, data) {
    const entry = { topic, data, ts: Date.now() };
    this._log.push(entry);
    if (this._log.length > 5000) this._log.shift();
    this.emit(topic, entry);
    this.emit('*', entry);
    return entry;
  }

  subscribe(topic, fn) {
    this.on(topic, fn);
    return () => this.off(topic, fn);
  }

  recent(n = 50) {
    return this._log.slice(-n);
  }
}

module.exports = new VREEventBus();
