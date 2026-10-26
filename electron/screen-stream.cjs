const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { DEVICES, validateStreamConfig } = require('./screen-stream-policy.cjs');

function isFile(file) {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

// Optional bridge resources are absent from ordinary CI packages. Report this before
// changing the desktop mode or touching USB; the rest of AI Watch remains available.
function streamAvailability({ packaged = false, resourcesPath = process.resourcesPath, root = path.resolve(__dirname, '..'),
  env = process.env, platform = process.platform, preview = false, fileExists = isFile } = {}) {
  if (preview) return { available: true, unavailableReason: null };
  if (platform !== 'win32') return { available: false, unavailableReason: '当前展域串流组件仅支持 Windows' };
  const bundle = packaged ? path.join(resourcesPath || '', 'screen-bridge')
    : path.join(root, '.local', 'screen-bridge', 'XANALI-Panel-Bridge');
  const hasBridge = fileExists(path.join(bundle, 'XANALI-Panel-Bridge.exe'));
  if (packaged || (!env.XANALI_PYTHON && hasBridge)) {
    if (!hasBridge) return { available: false, unavailableReason: '此安装包未包含串流组件，请使用包含串流组件的 AI Watch 安装包' };
    const resources = path.join(bundle, '_internal', 'resources');
    if (!fileExists(path.join(resources, 'ffmpeg', 'ffmpeg.exe')) || !fileExists(path.join(resources, 'streamd-arm64'))) {
      return { available: false, unavailableReason: '串流组件不完整：缺少编码器或设备端服务，请重新构建完整应用' };
    }
  } else {
    const source = path.join(root, 'screen-bridge');
    if (!fileExists(path.join(source, 'app', 'panel_stream_bridge.py')) || !fileExists(path.join(source, 'resources', 'ffmpeg', 'ffmpeg.exe'))
      || !fileExists(path.join(source, 'resources', 'streamd-arm64'))) {
      return { available: false, unavailableReason: '开发串流资源未准备完成，请先构建串流组件或准备 Python 桥、编码器和设备端服务' };
    }
  }
  return { available: true, unavailableReason: null };
}

function bridgeCommand({ packaged = false, resourcesPath = process.resourcesPath, root = path.resolve(__dirname, '..'), env = process.env } = {}) {
  if (packaged) {
    const executable = path.join(resourcesPath, 'screen-bridge', 'XANALI-Panel-Bridge.exe');
    if (!isFile(executable)) throw new Error('串流组件缺失，请重新构建完整应用');
    return { executable, args: [], cwd: path.dirname(executable) };
  }
  const builtBridge = path.join(root, '.local', 'screen-bridge', 'XANALI-Panel-Bridge', 'XANALI-Panel-Bridge.exe');
  if (!env.XANALI_PYTHON && isFile(builtBridge)) return { executable: builtBridge, args: [], cwd: path.dirname(builtBridge) };
  const bridgeRoot = path.join(root, 'screen-bridge');
  return { executable: env.XANALI_PYTHON || 'python', args: ['-u', path.join(bridgeRoot, 'app', 'panel_stream_bridge.py')], cwd: bridgeRoot };
}

// A single queued write and one latest bitmap bound memory when USB is slower than paint.
class FramePump {
  constructor({ write, onError = () => {} }) { this.write = write; this.onError = onError; this.frames = 0; this.droppedFrames = 0; this.pending = false; this.latest = null; this.closed = false; }
  update(frame) { if (!this.closed) this.latest = frame; }
  tick() {
    if (this.closed || !this.latest) return;
    if (this.pending) { this.droppedFrames++; return; }
    this.pending = true;
    try {
      this.write(this.latest, error => {
        this.pending = false;
        if (error) { if (!this.closed) this.onError(error); }
        else this.frames++;
      });
    } catch (error) { this.pending = false; if (!this.closed) this.onError(error); }
  }
  close() { this.closed = true; this.latest = null; }
}

class ScreenStream {
  constructor({ app, BrowserWindow, getConfig, getState, getStatus, onChange = () => {}, devUrl,
    preview = false, spawnProcess = spawn }) {
    Object.assign(this, { app, BrowserWindow, getConfig, getState, getStatus, onChange, devUrl, preview, spawnProcess });
    this.status = 'stopped'; this.error = null; this.window = null; this.child = null;
    this.operation = Promise.resolve(); this.generation = 0; this.pump = null;
  }
  availability() { return streamAvailability({ packaged: this.app.isPackaged, preview: this.preview }); }
  assertAvailable() { const state = this.availability(); if (!state.available) throw new Error(state.unavailableReason); }
  state() { return { ...this.getConfig(), ...this.availability(), status: this.status, error: this.error,
    frames: this.preview ? this.pump?.frames || 0 : this.bridgeStats?.frames || 0,
    droppedFrames: (this.pump?.droppedFrames || 0) + (this.bridgeStats?.skipped || 0), preview: this.preview }; }
  serialize(callback) { const result = this.operation.then(callback); this.operation = result.catch(() => {}); return result; }
  accepts(event) { return this.window && !this.window.isDestroyed() && event.sender === this.window.webContents && event.senderFrame === this.window.webContents.mainFrame; }
  broadcast(channel, value) { if (this.window && !this.window.isDestroyed()) this.window.webContents.send(channel, value); }
  screenState() { return { ...this.getState(), surface: 'screen', collapsed: false, stored: false, layout: 'fullscreen' }; }
  start() { return this.serialize(() => this.startInternal()); }
  stop() { this.cancelStart?.(); return this.serialize(() => this.stopInternal()); }
  async startInternal() {
    await this.stopInternal();
    const { enabled: _enabled, ...parameters } = this.getConfig();
    const config = validateStreamConfig(parameters);
    if (!DEVICES[config.device]) throw new Error('Unsupported screen device');
    const generation = ++this.generation;
    this.bridgeStats = null;
    this.status = 'starting'; this.error = null; this.onChange();
    try {
      this.assertAvailable();
      this.window = new this.BrowserWindow({ width: config.width, height: config.height, useContentSize: true,
        show: false, frame: false, resizable: true, skipTaskbar: true, title: 'AI Watch · 小屏幕输出',
        backgroundColor: '#111519', webPreferences: {
          preload: path.join(__dirname, 'screen-preload.cjs'), contextIsolation: true, nodeIntegration: false,
          sandbox: true, offscreen: true, backgroundThrottling: false, zoomFactor: 1,
        } });
      const contents = this.window.webContents;
      // Windows clamps initial native-window dimensions to the monitor work area.
      // Resize after creation and pin Chromium's viewport/DPR independently of that
      // monitor. This hidden output window is never shown or resized by the user.
      this.window.setContentSize(config.width, config.height);
      contents.setWindowOpenHandler(() => ({ action: 'deny' }));
      contents.on('will-navigate', event => event.preventDefault());
      contents.on('render-process-gone', () => this.fail('小屏幕渲染进程已退出', generation));
      contents.setFrameRate(config.fps);
      this.pump = new FramePump({
        write: (frame, done) => this.preview ? done() : this.child?.stdin?.write(frame, done),
        onError: () => this.fail('串流管道已断开，请检查屏幕连接后重试', generation),
      });
      let firstFrame;
      contents.on('paint', (_event, _dirty, image) => {
        if (generation !== this.generation || image.isEmpty()) return;
        const size = image.getSize();
        // Never stretch a monitor-clamped or transitional frame into the device's
        // aspect ratio. Only the configured viewport is eligible for transmission.
        if (size.width !== config.width || size.height !== config.height) return;
        const bitmap = image.toBitmap();
        if (bitmap.length === config.width * config.height * 4) { this.pump?.update(bitmap); firstFrame?.(); }
      });
      if (this.devUrl) await this.window.loadURL(`${this.devUrl.replace(/\/$/, '')}/?surface=screen`);
      else await this.window.loadFile(path.join(__dirname, '../dist/index.html'), { query: { surface: 'screen' } });
      // Emulation requires an initialized render view (after load), otherwise
      // Chromium can terminate the offscreen renderer on Windows.
      contents.enableDeviceEmulation({ screenPosition: 'desktop', screenSize: { width: config.width, height: config.height },
        viewPosition: { x: 0, y: 0 }, deviceScaleFactor: 1, viewSize: { width: config.width, height: config.height }, scale: 1 });
      // Verify an exact-size frame before taking over the USB display. Transient
      // old-size paint events during the native resize are deliberately ignored.
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { firstFrame = null; reject(new Error('小屏幕画面尺寸初始化失败，请重试')); }, 10000);
        firstFrame = () => { clearTimeout(timer); firstFrame = null; resolve(); };
        contents.startPainting(); contents.invalidate();
      });
      if (!this.preview) await this.startBridge(config, generation);
      if (generation !== this.generation) return;
      contents.startPainting(); contents.invalidate();
      this.frameTimer = setInterval(() => this.pump?.tick(), Math.max(1, Math.round(1000 / config.fps)));
      this.statsTimer = setInterval(() => this.onChange(), 1000);
      this.status = 'running'; this.onChange();
    } catch (error) {
      try { await this.stopInternal(); } catch (cleanupError) { error = new Error(`${error.message}；${cleanupError.message}`); }
      this.status = 'error'; this.error = String(error.message || error).slice(0, 500); this.onChange();
      throw error;
    }
  }
  startBridge(config, generation) {
    const command = bridgeCommand({ packaged: this.app.isPackaged });
    const args = [...command.args, '--device', config.device, '--width', String(config.width), '--height', String(config.height),
      '--fps', String(config.fps), '--bitrate-mbps', String(config.bitrateMbps)];
    return new Promise((resolve, reject) => {
      let ready = false, output = '', diagnostics = '';
      const child = this.spawnProcess(command.executable, args, { cwd: command.cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      this.child = child;
      child.streamResult = { ready: false, stopped: null, error: null };
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      const timer = setTimeout(() => reject(new Error('屏幕连接超时，请确认设备已连接并退出 KANALI')), 90000);
      this.cancelStart = () => { clearTimeout(timer); reject(new Error('串流启动已取消')); };
      const fail = message => { clearTimeout(timer); if (!ready) reject(new Error(message)); else this.fail(message, generation); };
      child.stdin.on('error', () => fail('串流管道已断开'));
      child.on('error', error => { child.streamExited = true; fail(`无法启动串流组件：${error.code || error.message}`); });
      child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-4096); });
      child.stdout.on('data', chunk => {
        output += chunk.toString();
        if (output.length > 65536) { fail('串流组件返回异常数据'); return; }
        let newline;
        while ((newline = output.indexOf('\n')) >= 0) {
          const line = output.slice(0, newline); output = output.slice(newline + 1);
          let message; try { message = JSON.parse(line); } catch { continue; }
          const event = message.event || message.type;
          if (event === 'ready') { ready = true; child.streamResult.ready = true; clearTimeout(timer); this.cancelStart = null; resolve(); }
          else if (event === 'stats' && Number.isSafeInteger(message.data?.frames) && message.data.frames >= 0) {
            this.bridgeStats = { frames: message.data.frames, skipped: Number.isSafeInteger(message.data.skipped) && message.data.skipped >= 0 ? message.data.skipped : 0 };
          }
          else if (event === 'stopped') child.streamResult.stopped = message.data;
          else if (event === 'error') {
            child.streamResult.error = String(message.data || message.message || message.error || '设备串流失败').slice(0, 500);
            fail(child.streamResult.error);
          }
        }
      });
      child.on('exit', code => {
        child.streamExited = true;
        clearTimeout(timer);
      });
      child.on('close', code => {
        child.streamClosed = true;
        clearTimeout(timer);
        if (generation !== this.generation) return;
        fail(`串流组件已退出 (${code ?? 'signal'})${diagnostics.trim() ? '：' + diagnostics.trim().slice(-300) : ''}`);
      });
    });
  }
  fail(message, generation) {
    if (generation !== this.generation || this.status === 'stopping' || this.status === 'stopped') return;
    void this.serialize(async () => {
      if (generation !== this.generation) return;
      try { await this.stopInternal(); } catch (error) { message += '；' + error.message; }
      this.status = 'error'; this.error = message; this.onChange();
    });
  }
  async stopInternal() {
    ++this.generation;
    this.cancelStart = null;
    clearInterval(this.frameTimer); clearInterval(this.statsTimer);
    this.pump?.close();
    if (this.status !== 'stopped') { this.status = 'stopping'; this.onChange(); }
    const output = this.window; this.window = null;
    if (output && !output.isDestroyed()) output.destroy();
    const child = this.child; this.child = null;
    let forced = false;
    if (child && !child.streamClosed) {
      await new Promise(resolve => {
        let finished = false;
        const done = () => { if (finished) return; finished = true; clearTimeout(timer); resolve(); };
        // EOF lets the bridge finish H.264, send MediaPushEnd and restore the original UI.
        const timer = setTimeout(() => { forced = true; child.kill(); done(); }, 75000);
        // Node's exit event precedes the final stdout drain; only close proves
        // that the bridge's restoration report has been fully consumed.
        child.once('close', done);
        if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end();
      });
    }
    const result = child?.streamResult;
    if (forced || result?.stopped?.failed || result?.error || child && child.exitCode !== 0 || result?.ready && result?.stopped?.restored !== true) {
      this.status = 'error';
      this.error = forced ? '串流组件停止超时，尚未确认原厂界面恢复' : result?.error || '串流已停止，但尚未确认原厂界面恢复，请检查屏幕连接';
      this.onChange(); throw new Error(this.error);
    }
    this.status = 'stopped'; this.error = null; this.onChange();
  }
}
module.exports = { ScreenStream, FramePump, bridgeCommand, streamAvailability };
