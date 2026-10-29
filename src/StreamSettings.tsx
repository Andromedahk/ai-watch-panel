import { useEffect, useState } from 'react';
import type { PanelState, ScreenStreamConfig, ScreenStreamState } from './types';
import { useScreenText } from './screen-i18n';

export const defaultScreenStream: ScreenStreamState = {
  enabled: false, device: 'zhanyu', width: 2240, height: 1080, fps: 30, bitrateMbps: 8,
  pageSeconds: 12, showMascot: true, agentsPerPage: 4, status: 'stopped', error: null,
  frames: 0, droppedFrames: 0, preview: false,
};

export function StreamSettings({ state, onState }: { state: PanelState; onState: (state: PanelState) => void }) {
  const s = useScreenText();
  const stream = state.stream || defaultScreenStream;
  const [draft, setDraft] = useState<ScreenStreamConfig>(stream);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const configKey = [stream.device, stream.width, stream.height, stream.fps, stream.bitrateMbps, stream.pageSeconds, stream.showMascot, stream.agentsPerPage].join(':');
  useEffect(() => setDraft({ device: stream.device, width: stream.width, height: stream.height,
    fps: stream.fps, bitrateMbps: stream.bitrateMbps, pageSeconds: stream.pageSeconds, showMascot: stream.showMascot, agentsPerPage: stream.agentsPerPage || 4 }), [configKey]);
  const transitioning = busy || stream.status === 'starting' || stream.status === 'stopping';
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
  return <fieldset className="stream-settings" data-stream-status={stream.status}>
    <legend>{s('水冷小屏幕串流', 'Liquid cooling display streaming')}</legend>
    <div className="stream-status"><span className={`tiny-dot ${stream.status === 'running' ? 'active' : ''}`} />
      <strong>{status}</strong>{stream.preview && <b className="stream-test-tag">{s('测试预览 · 未连接设备', 'Test preview · no device connected')}</b>}
    </div>
    <p className="appearance-hint">{ryuo
      ? s('龙王 IV 按左 10、右 4 分区：左侧默认每页四个 Agent，右侧只显示看板娘和台词。提问或授权时文字在左侧区域居中，右侧显示圆形角色头像。', 'RYUO IV uses a 10:4 split: four Agents per page by default on the left, with only the companion and dialogue on the right. Questions and approvals center the request within the left area and show a circular character portrait on the right.')
      : s('按曲面屏左右 1:1 分区：左侧四个 Agent，右上看板娘、右下额度历史。桌面只保留本配置页，收纳后继续串流。', 'Equal left and right areas for the curved display: four Agents on the left, companion at top right and quota history below. The desktop keeps this settings page; streaming continues while minimized or stored.')}</p>
    <label className="stream-field"><span>{s('屏幕类型', 'Display type')}</span><select aria-label={s('屏幕类型', 'Display type')} value={draft.device} disabled={transitioning} onChange={e => {
      const device = e.target.value as ScreenStreamConfig['device'];
      setError('');
      setDraft({ ...draft, device, width: 2240, height: 1080, fps: 30, bitrateMbps: device === 'ryuo4' ? 6 : 8,
        agentsPerPage: device === 'ryuo4' ? 4 : draft.agentsPerPage });
    }}>
      <option value="zhanyu">{s('展域', 'Zhanyu')} / TRYX PANORAMA SE · PASE_1021</option>
      <option value="ryuo4">{s('ROG 龙王 IV', 'ROG RYUO IV')} · cm16</option>
    </select></label>
    {ryuo && <p className="appearance-hint">{s('使用已刷入的定制固件与内置 RYUO 播放器，通过 USB ADB 连接；若屏幕提示调试授权，请允许。原生 2240 × 1080，默认 30 FPS、6 Mbps，使用 HEVC 编码。', 'Uses the installed custom firmware and RYUO player over USB ADB. Allow USB debugging if the display asks. Native 2240 × 1080 output defaults to 30 FPS and 6 Mbps using HEVC encoding.')}</p>}
    <div className="stream-field-grid">
      <label className="stream-field"><span>{s('画面宽度', 'Frame width')}</span><input aria-label={s('串流画面宽度', 'Stream frame width')} type="number" min={64} max={ryuo ? 2240 : 4096} step={2} value={draft.width} disabled={transitioning} onChange={e => setDraft({ ...draft, width: Number(e.target.value) })} /></label>
      <label className="stream-field"><span>{s('画面高度', 'Frame height')}</span><input aria-label={s('串流画面高度', 'Stream frame height')} type="number" min={64} max={ryuo ? 1080 : 4096} step={2} value={draft.height} disabled={transitioning} onChange={e => setDraft({ ...draft, height: Number(e.target.value) })} /></label>
      <label className="stream-field"><span>{s('目标帧率 · fps', 'Target frame rate · fps')}</span><input aria-label={s('串流目标帧率', 'Stream frame rate')} type="number" min={1} max={60} step={1} value={draft.fps} disabled={transitioning} onChange={e => setDraft({ ...draft, fps: Number(e.target.value) })} /></label>
      <label className="stream-field"><span>{ryuo ? s('HEVC 码率 · Mbps', 'HEVC bitrate · Mbps') : s('H.264 码率 · Mbps', 'H.264 bitrate · Mbps')}</span><input aria-label={s('串流码率', 'Stream bitrate')} type="number" min={1} max={50} step={1} value={draft.bitrateMbps} disabled={transitioning} onChange={e => setDraft({ ...draft, bitrateMbps: Number(e.target.value) })} /></label>
      <label className="stream-field"><span>{s('模块自动翻页 · 秒', 'Module page interval · seconds')}</span><input aria-label={s('串流自动翻页秒数', 'Stream page interval')} type="number" min={4} max={120} step={1} value={draft.pageSeconds} disabled={transitioning} onChange={e => setDraft({ ...draft, pageSeconds: Number(e.target.value) })} /></label>
      {ryuo && <label className="stream-field"><span>{s('每页 Agent 数量', 'Agents per page')}</span><select aria-label={s('每页 Agent 数量', 'Agents per page')} value={draft.agentsPerPage || 4} disabled={transitioning} onChange={e => setDraft({ ...draft, agentsPerPage: Number(e.target.value) as 4 | 6 })}><option value={4}>{s('4 个 · 2 × 2', '4 · 2 × 2')}</option><option value={6}>{s('6 个 · 3 × 2', '6 · 3 × 2')}</option></select></label>}
    </div>
    <label className="switch-row"><span>{s('二次元看板娘模块', 'Anime companion module')}<small>{s('保留台词、表情和呼吸动效；刷新间隔沿用外观设置', 'Keep dialogue, expressions and breathing animations; use the appearance refresh interval')}</small></span><input aria-label={s('二次元看板娘模块', 'Anime companion module')} type="checkbox" checked={draft.showMascot} disabled={transitioning} onChange={e => setDraft({ ...draft, showMascot: e.target.checked })} /></label>
    <p className="appearance-hint">{s('小屏幕自动轮播模块、额度和币种。打开程序、拖动排序、刷新和翻页按钮均关闭；提问或授权请求会全屏提醒，请回到对应 Agent 处理。', 'Modules, quotas and currencies rotate automatically. Launch, reorder, refresh and paging controls are disabled. Input or approval requests take over the display; respond in the relevant Agent.')}</p>
    <p className="appearance-hint">{ryuo
      ? s('连接前请关闭其他 RYUO 串流软件。关闭串流后会结束播放器并返回屏幕主界面。默认保留动效；更改参数会重启当前串流。', 'Close other RYUO streaming software before connecting. Stopping ends playback and returns to the display home screen. Animations are preserved; applying parameters restarts the current stream.')
      : s('首次连接请先退出 KANALI（含 Screen.exe / UDB.exe）。默认保留动效；实际帧率取决于编码与 USB 传输。更改参数会重启当前串流。', 'Exit KANALI (including Screen.exe / UDB.exe) before connecting. Animations are preserved. Actual frame rate depends on encoding and USB transfer. Applying parameters restarts the current stream.')}</p>
    {state.platform === 'darwin' && <p className="appearance-hint">{s('支持 macOS 15 及以上的 Apple Silicon 和 Intel Mac。连接后若系统询问是否允许 USB 配件，请选择允许；请先关闭其他占用屏幕的软件。', 'Supports Apple Silicon and Intel Macs on macOS 15 or later. Allow the USB accessory if macOS asks, and close other software using the display.')}</p>}
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
