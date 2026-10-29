const { validateRyuoBrightness } = require('./screen-stream-policy.cjs');

// One app-owned worker keeps HomeUI's five-second HID timeout from expiring.
// This process owns brightness only, independently of the video encoder.
class RyuoBrightness {
  constructor({ command, spawnProcess, preview = false, onChange = () => {} }) {
    Object.assign(this, { command, spawnProcess, preview, onChange });
    this.session = null; this.stopping = null; this.status = 'inactive'; this.error = null; this.value = null;
  }
  state() { return { ryuoBrightnessStatus: this.status, ryuoBrightnessError: this.error }; }
  changed(status, error = null) { this.status = status; this.error = error; this.onChange(); }
  watch(session) {
    clearTimeout(session.watchdog);
    session.watchdog = setTimeout(() => this.fail(session, '龙王 IV 亮度保活已中断，请检查 USB 连接后重新应用亮度'), 7000);
  }
  fail(session, message) {
    if (session !== this.session) return;
    this.session = null;
    clearTimeout(session.watchdog);
    clearTimeout(session.pending?.timer);
    session.pending?.reject(new Error(message)); session.pending = null;
    if (!session.closed) session.child.kill();
    this.changed('error', String(message).slice(0, 500));
  }
  apply(value) {
    const brightness = validateRyuoBrightness(value);
    if (this.stopping) return this.stopping.then(() => this.apply(brightness));
    if (this.preview) { this.value = brightness; this.changed('holding'); return Promise.resolve(brightness); }
    if (this.status === 'holding' && this.value === brightness && this.session) return Promise.resolve(brightness);
    if (this.session?.pending) return Promise.reject(new Error('亮度正在应用，请稍后重试'));
    let session = this.session;
    this.changed('starting');
    try {
      if (!session) {
        const command = this.command();
        const child = this.spawnProcess(command.executable,
          [...command.args, '--device', 'ryuo4', '--brightness', String(brightness), '--hold'],
          { cwd: command.cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        session = { child, output: '', pending: null, closed: false };
        this.session = session;
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', chunk => this.output(session, chunk));
        child.stderr.on('data', () => {}); // Drain, without exposing native device paths.
        child.on('error', () => this.fail(session, '无法启动龙王 IV 亮度保活组件'));
        child.stdin.on('error', () => this.fail(session, '龙王 IV 亮度保活管道已断开，请重新应用亮度'));
        child.on('close', () => {
          session.closed = true;
          this.fail(session, '龙王 IV 亮度保活已退出，请检查 USB 连接后重新应用亮度');
        });
      }
    } catch (error) { this.changed('error', error.message); return Promise.reject(error); }
    return new Promise((resolve, reject) => {
      session.pending = { brightness, resolve, reject,
        timer: setTimeout(() => this.fail(session, '龙王 IV 亮度调节超时，请检查 USB 连接及 HID 是否被占用'), 30000) };
      // The initial value is passed in argv. Updates use the same worker so an
      // old heartbeat cannot race with a replacement process's new value.
      if (session.started) {
        session.child.stdin.write(JSON.stringify({ brightness }) + '\n', error => {
          if (error) this.fail(session, '龙王 IV 亮度保活管道已断开，请重新应用亮度');
        });
      }
      session.started = true;
    });
  }
  output(session, chunk) {
    if (session !== this.session) return;
    session.output += chunk;
    if (session.output.length > 8192) { this.fail(session, '亮度保活组件返回异常数据'); return; }
    let newline;
    while ((newline = session.output.indexOf('\n')) >= 0 && session === this.session) {
      const line = session.output.slice(0, newline); session.output = session.output.slice(newline + 1);
      let message; try { message = JSON.parse(line); } catch { continue; }
      if (message.type === 'error') { this.fail(session, String(message.data || '亮度保活失败').slice(0, 500)); return; }
      const pending = session.pending;
      if (message.type === 'brightness' && pending && message.data?.brightness === pending.brightness
          && message.data?.applied === true && message.data?.holding === true) {
        clearTimeout(pending.timer); session.pending = null;
        this.value = pending.brightness; this.watch(session); this.changed('holding'); pending.resolve(this.value);
      } else if (message.type === 'brightness-heartbeat' && message.data?.brightness === this.value) this.watch(session);
    }
  }
  stop() {
    if (!this.session && this.stopping) return this.stopping;
    const session = this.session; this.session = null;
    this.value = null; this.changed('inactive');
    if (!session) return Promise.resolve();
    clearTimeout(session.watchdog); clearTimeout(session.pending?.timer);
    session.pending?.reject(new Error('亮度保活已停止')); session.pending = null;
    if (session.closed) return Promise.resolve();
    const waiting = new Promise(resolve => {
      const timer = setTimeout(() => { session.child.kill(); resolve(); }, 2500);
      session.child.once('close', () => { clearTimeout(timer); resolve(); });
      if (!session.child.stdin.destroyed && !session.child.stdin.writableEnded) session.child.stdin.end();
    });
    const stopping = waiting.finally(() => { if (this.stopping === stopping) this.stopping = null; });
    this.stopping = stopping;
    return stopping;
  }
}

module.exports = { RyuoBrightness };
