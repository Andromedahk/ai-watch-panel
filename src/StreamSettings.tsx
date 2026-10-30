import { useEffect, useState } from 'react';
import type { PanelState, ScreenStreamConfig, ScreenStreamState } from './types';
import { useScreenText } from './screen-i18n';

export const defaultScreenStream: ScreenStreamState = {
  enabled: false, device: 'zhanyu', width: 2240, height: 1080, fps: 30, bitrateMbps: 8,
  pageSeconds: 12, showMascot: true, agentsPerPage: 4, oledGuard: false, status: 'stopped', error: null,
  frames: 0, droppedFrames: 0, preview: false,
};

export function StreamSettings({ state, onState }: { state: PanelState; onState: (state: PanelState) => void }) {
  const s = useScreenText();
  const stream = state.stream || defaultScreenStream;
  const [draft, setDraft] = useState<ScreenStreamConfig>(stream);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [brightness, setBrightness] = useState(state.ryuoBrightness ?? 85);
  const [brightnessBusy, setBrightnessBusy] = useState(false);
  const [brightnessError, setBrightnessError] = useState('');
  const [brightnessApplied, setBrightnessApplied] = useState<number | null>(null);
  // Frame counters refresh every second; only a changed saved value can replace
  // an in-progress slider edit.
  useEffect(() => setBrightness(state.ryuoBrightness ?? 85), [state.ryuoBrightness]);
  const configKey = [stream.device, stream.width, stream.height, stream.fps, stream.bitrateMbps, stream.pageSeconds, stream.showMascot, stream.agentsPerPage, stream.oledGuard].join(':');
  useEffect(() => setDraft({ device: stream.device, width: stream.width, height: stream.height,
    fps: stream.fps, bitrateMbps: stream.bitrateMbps, pageSeconds: stream.pageSeconds, showMascot: stream.showMascot, agentsPerPage: stream.agentsPerPage || 4, oledGuard: Boolean(stream.oledGuard) }), [configKey]);
  const transitioning = busy || brightnessBusy || stream.status === 'starting' || stream.status === 'stopping';
  const ryuo = draft.device === 'ryuo4';
  const capability = stream.deviceAvailability?.[draft.device]
    || (draft.device === stream.device ? stream : undefined);
  // Preview is granted only by the main process' isolated test fixture; it never opens USB.
  const available = Boolean(window.panel?.startStream) && (['win32', 'darwin'].includes(state.platform) || stream.preview) && capability?.available !== false;
  const status = { stopped: s('未串流', 'Stopped'), starting: s('正在连接小屏幕', 'Connecting display'), running: s('正在串流', 'Streaming'), stopping: s('正在恢复屏幕', 'Restoring display'), error: s('串流未连接', 'Disconnected') }[stream.status];
  async function apply(start: boolean) {
    const panel = window.panel;
    if (!panel || transitioning) return;
    setBusy(true); setError('');
    try {
      onState(await panel.setStreamConfig(draft));
      if (start) onState(await panel.startStream());
    } catch (err) { setError(err instanceof Error ? err.message : s('串流设置未保存，请重试', 'Settings were not saved. Please retry.')); }
    finally { setBusy(false); }
  }
  async function stop() {
    if (!window.panel || stream.status === 'stopping') return;
    setBusy(true); setError('');
    try { onState(await window.panel.stopStream()); }
    catch (err) { setError(err instanceof Error ? err.message : s('停止串流失败，请重试', 'Could not stop streaming. Please retry.')); }
    finally { setBusy(false); }
  }
  async function applyBrightness() {
    if (!window.panel?.setRyuoBrightness || transitioning || !ryuo) return;
    setBrightnessBusy(true); setBrightnessError(''); setBrightnessApplied(null);
    try {
      onState(await window.panel.setRyuoBrightness(brightness));
      setBrightnessApplied(brightness);
    } catch (err) { setBrightnessError(err instanceof Error ? err.message : s('亮度设置失败，请重试', 'Could not set brightness. Please retry.')); }
    finally { setBrightnessBusy(false); }
  }
  return <fieldset className="stream-settings" data-stream-status={stream.status}>
    <legend>{s('水冷小屏幕串流', 'Liquid cooling display streaming')}</legend>
    <div className="stream-status"><span className={`tiny-dot ${stream.status === 'running' ? 'active' : ''}`} />
      <strong>{status}</strong>{stream.preview && <b className="stream-test-tag">{s('测试预览 · 未连接设备', 'Test preview · no device connected')}</b>}
    </div>
    <label className="stream-field"><span>{s('屏幕类型', 'Display type')}</span><select aria-label={s('屏幕类型', 'Display type')} value={draft.device} disabled={transitioning} onChange={e => {
      const device = e.target.value as ScreenStreamConfig['device'];
      setError(''); setBrightnessError(''); setBrightnessApplied(null);
      setDraft({ ...draft, device, width: 2240, height: 1080, fps: 30, bitrateMbps: device === 'ryuo4' ? 6 : 8,
        agentsPerPage: device === 'ryuo4' ? 4 : draft.agentsPerPage });
    }}>
      <option value="zhanyu">{s('展域', 'Zhanyu')} / TRYX PANORAMA SE · PASE_1021</option>
      <option value="ryuo4">{s('ROG 龙王 IV', 'ROG RYUO IV')} · cm16</option>
    </select></label>
    {ryuo && <p className="appearance-hint">{s('需要已刷入定制固件；屏幕提示 USB 调试授权时请允许。', 'Requires the custom firmware. Allow USB debugging if the display asks.')}</p>}
    {ryuo && <div className="stream-brightness">
      <label className="stream-field"><span className="stream-brightness-label">{s('屏幕亮度', 'Display brightness')}<output>{brightness}%</output></span>
        <input aria-label={s('龙王屏幕亮度', 'RYUO display brightness')} type="range" min={1} max={100} step={1} value={brightness} disabled={transitioning} onChange={e => {
          setBrightness(Number(e.target.value)); setBrightnessError(''); setBrightnessApplied(null);
        }} />
      </label>
      {state.ryuoBrightness != null && <p className="appearance-hint stream-brightness-saved">{s(`上次设置：${state.ryuoBrightness}%`, `Last setting: ${state.ryuoBrightness}%`)}</p>}
      <button className="dock-button" disabled={!available || !window.panel?.setRyuoBrightness || transitioning} onClick={() => void applyBrightness()}>{brightnessBusy ? s('正在应用亮度…', 'Applying brightness…') : s('应用亮度', 'Apply brightness')}</button>
      {stream.ryuoBrightnessStatus === 'holding' && !stream.preview && <p className="stream-brightness-result" role="status">{s('亮度保持中 · 每 2 秒续期', 'Maintaining brightness · every 2 seconds')}</p>}
      {(brightnessError || stream.ryuoBrightnessError) && <p className="stream-error" role="alert">{brightnessError || stream.ryuoBrightnessError}</p>}
      {brightnessApplied != null && stream.ryuoBrightnessStatus === 'holding' && <p className="stream-brightness-result" role="status">{stream.preview
        ? s(`测试预览：亮度 ${brightnessApplied}%，未连接设备。`, `Test preview: brightness ${brightnessApplied}%; no device connected.`)
        : s(`已应用亮度 ${brightnessApplied}%。`, `Applied brightness ${brightnessApplied}%.`)}</p>}
    </div>}
    <div className="stream-field-grid">
      <label className="stream-field"><span>{s('画面宽度', 'Frame width')}</span><input aria-label={s('串流画面宽度', 'Stream frame width')} type="number" min={64} max={ryuo ? 2240 : 4096} step={2} value={draft.width} disabled={transitioning} onChange={e => setDraft({ ...draft, width: Number(e.target.value) })} /></label>
      <label className="stream-field"><span>{s('画面高度', 'Frame height')}</span><input aria-label={s('串流画面高度', 'Stream frame height')} type="number" min={64} max={ryuo ? 1080 : 4096} step={2} value={draft.height} disabled={transitioning} onChange={e => setDraft({ ...draft, height: Number(e.target.value) })} /></label>
      <label className="stream-field"><span>{s('目标帧率 · fps', 'Target frame rate · fps')}</span><input aria-label={s('串流目标帧率', 'Stream frame rate')} type="number" min={1} max={60} step={1} value={draft.fps} disabled={transitioning} onChange={e => setDraft({ ...draft, fps: Number(e.target.value) })} /></label>
      <label className="stream-field"><span>{ryuo ? s('HEVC 码率 · Mbps', 'HEVC bitrate · Mbps') : s('H.264 码率 · Mbps', 'H.264 bitrate · Mbps')}</span><input aria-label={s('串流码率', 'Stream bitrate')} type="number" min={1} max={50} step={1} value={draft.bitrateMbps} disabled={transitioning} onChange={e => setDraft({ ...draft, bitrateMbps: Number(e.target.value) })} /></label>
      <label className="stream-field"><span>{s('模块自动翻页 · 秒', 'Module page interval · seconds')}</span><input aria-label={s('串流自动翻页秒数', 'Stream page interval')} type="number" min={4} max={120} step={1} value={draft.pageSeconds} disabled={transitioning} onChange={e => setDraft({ ...draft, pageSeconds: Number(e.target.value) })} /></label>
      {ryuo && <label className="stream-field"><span>{s('每页 Agent 数量', 'Agents per page')}</span><select aria-label={s('每页 Agent 数量', 'Agents per page')} value={draft.agentsPerPage || 4} disabled={transitioning} onChange={e => setDraft({ ...draft, agentsPerPage: Number(e.target.value) as 2 | 4 | 6 })}><option value={2}>{s('2 个 · 2 × 1', '2 · 2 × 1')}</option><option value={4}>{s('4 个 · 2 × 2', '4 · 2 × 2')}</option><option value={6}>{s('6 个 · 3 × 2', '6 · 3 × 2')}</option></select></label>}
    </div>
    <label className="switch-row"><span>{s('二次元看板娘模块', 'Anime companion module')}</span><input aria-label={s('二次元看板娘模块', 'Anime companion module')} type="checkbox" checked={draft.showMascot} disabled={transitioning} onChange={e => setDraft({ ...draft, showMascot: e.target.checked })} /></label>
    <label className="switch-row"><span>{s('OLED 防烧屏', 'OLED burn-in guard')}</span><input aria-label={s('OLED 防烧屏', 'OLED burn-in guard')} type="checkbox" checked={draft.oledGuard} disabled={transitioning} onChange={e => setDraft({ ...draft, oledGuard: e.target.checked })} /></label>
    <p className="appearance-hint">{ryuo
      ? s('连接前请关闭其他 RYUO 串流软件。', 'Close other RYUO streaming software before connecting.')
      : s('首次连接请先退出 KANALI（含 Screen.exe / UDB.exe）。', 'Exit KANALI (including Screen.exe / UDB.exe) before connecting.')}</p>
    {state.platform === 'darwin' && <p className="appearance-hint">{s('macOS 询问是否允许 USB 配件时请选择允许。', 'Allow the USB accessory if macOS asks.')}</p>}
    {!available && <p className="stream-error">{capability?.unavailableReason || (['win32', 'darwin'].includes(state.platform)
      ? s('此安装包未包含完整串流组件，请使用包含串流桥的 AI Watch 构建。', 'This installation does not include the display streaming components. Use an AI Watch build with the display bridge.')
      : s('USB 串流需要 Windows 或 macOS 15 及以上的 AI Watch；浏览器仅预览界面。', 'USB streaming requires AI Watch for Windows or macOS 15 or later; the browser only previews the UI.'))}</p>}
    {(error || stream.error) && <p className="stream-error" role="alert">{error || stream.error}</p>}
    <div className="stream-actions">
      <button className="save-button" disabled={!available || transitioning} onClick={() => void apply(!stream.enabled)}>{stream.enabled && stream.status !== 'error' ? s('应用串流参数', 'Apply stream parameters') : s('开启小屏幕串流', 'Start display streaming')}</button>
      {stream.enabled && <button className="dock-button" disabled={stream.status === 'stopping' || (busy && stream.status !== 'starting')} onClick={() => void stop()}>{stream.status === 'starting' ? s('取消连接并恢复桌面面板', 'Cancel connection and restore desktop panel') : s('关闭串流并恢复桌面面板', 'Stop streaming and restore desktop panel')}</button>}
    </div>
    {stream.enabled && <p className="appearance-hint stream-stats">{stream.device === 'ryuo4' ? s('已提交编码', 'Submitted to encoder') : s('已发送', 'Sent')} {stream.frames.toLocaleString()} {s('帧 · 丢弃', 'frames · dropped')} {stream.droppedFrames.toLocaleString()} {s('帧', 'frames')}</p>}
  </fieldset>;
}
