'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const emptyState = () => ({ version: 2, resetGeneration: 0, deviceId: null, session: null, retiredSessions: [], seq: 0, packetHash: null,
  hash: null, receivedAt: null, snapshot: null, requestsSeen: [], installations: [], inbox: [], commands: [], devices: [], liveTargets: [], alerts: { waiting: [], low: [] }, outbox: [] });
class Store {
  constructor(file) {
    this.file = file;
    if (!file) { this.data = emptyState(); return; }
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) throw new Error('invalid-state');
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data.version !== 2 || !Array.isArray(data.installations) || !Array.isArray(data.requestsSeen) || !Array.isArray(data.commands) || !Array.isArray(data.devices) || !Array.isArray(data.outbox) || !data.alerts) throw new Error('invalid-state');
      if (data.inbox === undefined) data.inbox = [];
      if (!Array.isArray(data.inbox)) throw new Error('invalid-state');
      if (data.liveTargets === undefined) data.liveTargets = [];
      if (!Array.isArray(data.liveTargets) || data.liveTargets.length > 64) throw new Error('invalid-state');
      this.data = data;
    } catch (e) { if (e.code !== 'ENOENT') throw new Error('state-unreadable'); this.data = emptyState(); }
  }
  save() {
    if (!this.file) return;
    const tmp = `${this.file}.${randomUUID()}.tmp`;
    try {
      const fd = fs.openSync(tmp, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(this.data)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, this.file);
    } finally { try { fs.unlinkSync(tmp); } catch {} }
    const directory = fs.openSync(path.dirname(this.file), 'r');
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  }
}
module.exports = { Store, emptyState };
