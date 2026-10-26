// Owns the current LAN sync role for the main process: starts the host server
// or the client stream, keeps pairing state, and reports a renderer-safe summary.
const os = require('node:os');
const path = require('node:path');
const { SyncStore, LanHost, LanClient, pairWithHost, discoverHosts, parseAddress, localAddresses, newCode } = require('./lan-sync.cjs');

const deviceName = () => os.hostname().replace(/\.local$/i, '') || 'AI Watch';

class LanSyncController {
  constructor({ userData, onRemote = () => {}, onChange = () => {}, name = deviceName(), createHost, createClient, pair = pairWithHost, discover = discoverHosts }) {
    this.store = new SyncStore(path.join(userData, 'lan-sync.json'));
    Object.assign(this, { onRemote, onChange, name, pair, discover });
    this.createHost = createHost || (options => new LanHost(options));
    this.createClient = createClient || (options => new LanClient(options));
    this.role = 'off'; this.port = null; this.host = null; this.client = null;
    this.state = 'off'; this.error = null; this.remoteHost = null; this.lastStatus = null; this.lastJournal = null;
  }
  summary() {
    const client = this.store.data.client;
    return { role: this.role, state: this.state, error: this.error,
      ...(this.role === 'host' ? { code: this.store.data.host.code, port: this.host?.port ?? this.port, addresses: localAddresses(),
        paired: this.store.data.host.tokens.length, connected: this.host?.connected ?? 0, name: this.name } : {}),
      ...(this.role === 'client' ? { paired: Boolean(client), hostName: this.remoteHost || client?.hostName || null,
        address: client ? `${client.address}:${client.port}` : null } : {}) };
  }
  async apply(role, port) {
    if (role === this.role && port === this.port && (role !== 'host' || this.host)) return this.summary();
    await this.stop();
    this.role = role; this.port = port; this.error = null;
    if (role === 'host') {
      const host = this.createHost({ store: this.store, port, name: this.name });
      try { await host.start(); this.host = host; this.state = 'listening'; }
      catch (error) { this.state = 'error'; this.error = error.code === 'EADDRINUSE' ? 'port-in-use' : 'start-failed'; await host.close().catch(() => {}); }
      // Hosts publish whatever they hold; give a new server the latest data at once.
      if (this.host && (this.lastStatus || this.lastJournal)) this.host.publish({ status: this.lastStatus ?? undefined, journal: this.lastJournal ?? undefined });
    } else if (role === 'client') this.connect();
    else this.state = 'off';
    this.onChange();
    return this.summary();
  }
  async stop() {
    this.client?.close(); this.client = null;
    if (this.host) await this.host.close().catch(() => {});
    this.host = null; this.remoteHost = null;
  }
  connect() {
    const saved = this.store.data.client;
    if (!saved) { this.state = 'unpaired'; return; }
    this.client = this.createClient({ ...saved,
      onSnapshot: snapshot => { this.remoteHost = snapshot.host || saved.hostName; this.onRemote(snapshot); },
      onState: state => { this.state = state; this.onChange(); } });
    this.state = 'connecting';
    this.client.connect();
  }
  publish(update) {
    if (update.status !== undefined) this.lastStatus = update.status;
    if (update.journal !== undefined) this.lastJournal = update.journal;
    if (this.role === 'host' && this.host) this.host.publish(update);
  }
  async pairWith(text, code) {
    if (this.role !== 'client') throw new Error('not-client');
    const target = parseAddress(text);
    if (!target) throw new Error('bad-address');
    const paired = await this.pair({ ...target, code, client: this.name });
    this.client?.close(); this.client = null;
    this.store.data.client = paired; this.store.save();
    this.error = null; this.connect(); this.onChange();
    return this.summary();
  }
  forget() {
    this.client?.close(); this.client = null; this.remoteHost = null;
    this.store.data.client = null; this.store.save();
    this.state = this.role === 'client' ? 'unpaired' : this.state;
    this.onChange();
    return this.summary();
  }
  regenerate() {
    if (this.host) this.host.regenerate();
    else { this.store.data.host = { code: newCode(), tokens: [] }; this.store.save(); }
    this.onChange();
    return this.summary();
  }
  async discoverHosts() { return this.discover(); }
  close() { return this.stop(); }
}

module.exports = { LanSyncController, deviceName };
