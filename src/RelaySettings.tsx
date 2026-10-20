import { useEffect, useRef, useState } from 'react';
import { useI18n } from './i18n';
import type { RelayAgentId, RelayState, RelayTask } from './types';
import './relay.css';

const empty: RelayState = { enabled: false, running: false, endpoint: null, agentCount: 0, queuedTasks: 0, lastEventAt: null,
  agents: [{ id: 'claude', available: false, enabled: false, busy: false }, { id: 'codex', available: false, enabled: false, busy: false }] };
const names = { claude: 'Claude', codex: 'Codex' };
const statusKeys = { queued: '任务排队中', running: '任务执行中', completed: '任务已完成', failed: '任务失败', cancelled: '任务已取消', expired: '任务已过期' };
const workerErrorKeys: Record<string, string> = {
  'auth-required': 'CLI 未登录，请在对应 CLI 完成登录。',
  'unsupported-cli': 'CLI 版本或配置不兼容，请更新 CLI 并检查配置。',
  'config-invalid': 'CLI 版本或配置不兼容，请更新 CLI 并检查配置。',
  'cli-unavailable': '未找到可用 CLI，请先安装并登录。',
};

export function RelaySettings({ active, onNotice }: { active: boolean; onNotice: (text: string) => void }) {
  const { t, date, number } = useI18n();
  const translator = useRef(t); translator.current = t;
  const [state, setState] = useState<RelayState>(empty);
  const [tasks, setTasks] = useState<RelayTask[]>([]);
  const [selected, setSelected] = useState('');
  const [transcript, setTranscript] = useState('');
  const [loadingTranscript, setLoadingTranscript] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const selectedUpdatedAt = tasks.find(task => task.id === selected)?.updatedAt;
  useEffect(() => {
    if (!active || !window.panel) return;
    let disposed = false, fetching = false;
    const loadTasks = async () => {
      if (fetching) return;
      fetching = true;
      try { const value = await window.panel!.getRelayTasks(); if (!disposed) { setTasks(value); setFailed(false); } }
      catch { if (!disposed) setFailed(true); }
      finally { fetching = false; }
    };
    void window.panel.getRelayState().then(value => { if (!disposed) setState(value); }).catch(() => { if (!disposed) setFailed(true); });
    void loadTasks();
    const unsubscribe = window.panel.onRelayState(value => { if (!disposed) { setState(value); void loadTasks(); } });
    return () => { disposed = true; unsubscribe(); };
  }, [active]);
  useEffect(() => {
    if (!active || !selected || !window.panel) { setTranscript(''); return; }
    let disposed = false; setLoadingTranscript(true); setTranscript('');
    void window.panel.readRelayTranscript(selected).then(value => { if (!disposed) setTranscript(value); })
      .catch(() => { if (!disposed) onNotice(translator.current('任务留档读取失败')); })
      .finally(() => { if (!disposed) setLoadingTranscript(false); });
    return () => { disposed = true; };
  }, [active, selected, selectedUpdatedAt, onNotice]);
  async function action(operation: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    try { await operation(); setFailed(false); }
    catch { setFailed(true); onNotice(t('MCP 操作失败，请重试')); }
    finally { setBusy(false); }
  }
  async function toggleAgent(id: RelayAgentId, enabled: boolean) {
    const ids = state.agents.filter(agent => agent.enabled && agent.id !== id).map(agent => agent.id);
    if (enabled) ids.push(id);
    setState(await window.panel!.setRelayAutoAgents(ids));
  }
  return <fieldset className="appearance-settings relay-settings" data-testid="relay-settings"><legend>{t('MCP 任务交流')}</legend>
    <p className="relay-boundary">{t('MCP 交换任务与结果；自动执行使用专用 CLI 托管会话，不能接管现有 App 对话。GUI 只能定位或预填。')}</p>
    <label className="switch-row"><span>{t('开启本机 MCP 服务器')}<small>{t('仅本机连接，默认关闭')}</small></span>
      <input type="checkbox" aria-label={t('开启本机 MCP 服务器')} checked={state.enabled} disabled={!window.panel || busy}
        onChange={event => { const enabled = event.target.checked; void action(async () => setState(await window.panel!.setRelayEnabled(enabled))); }} /></label>
    <div className="relay-service" role="status"><span className={`tiny-dot ${state.running ? 'active' : ''}`} />
      <span>{t(state.running ? 'MCP 服务运行中' : 'MCP 服务已停止')}</span>
      {state.endpoint && <code dir="ltr">{state.endpoint}</code>}
      <span>{t('排队任务：{p0}', { p0: state.queuedTasks })}</span>
    </div>
    {(failed || state.error) && <p className="relay-error" role="alert">{t('MCP 服务或留档暂不可用，请检查设置后重试。')}</p>}
    <p className="appearance-hint">{t('仅在明确启用后执行收到的任务，使用本设备已有 CLI 登录和权限。关闭托管开关会停止当前托管工作。')}</p>
    <div className="relay-agent-list">{state.agents.map(agent => <div className="relay-agent" key={agent.id}>
      <label className="switch-row"><span>{t('托管 {p0} 会话', { p0: agent.id === 'claude' ? 'Claude Code' : names[agent.id] })}<small>{t(!agent.available ? 'CLI 暂不可用' : agent.busy ? '托管会话忙碌' : '托管会话空闲')}</small></span>
        <input type="checkbox" aria-label={t('托管 {p0} 会话', { p0: agent.id === 'claude' ? 'Claude Code' : names[agent.id] })} checked={agent.enabled} disabled={!window.panel || busy || (!agent.enabled && (!state.running || !agent.available))}
          onChange={event => { const enabled = event.target.checked; void action(() => toggleAgent(agent.id, enabled)); }} /></label>
      {agent.lastError && <p className="relay-error">{t(Object.hasOwn(workerErrorKeys, agent.lastError) ? workerErrorKeys[agent.lastError] : '托管会话暂不可用')}</p>}
      <button className="dock-button" disabled={!state.running || busy} onClick={() => void action(async () => {
        await window.panel!.exportRelayConfig(agent.id); onNotice(t('连接配置已导出；请在对应客户端中添加。'));
      })}>{t('导出 {p0} 连接配置', { p0: names[agent.id] })}</button>
    </div>)}</div>
    <p className="appearance-hint">{t('连接配置仅保存在本机，不会自动改写客户端配置。不要分享其中的本机访问凭据。')}</p>
    <div className="relay-task-heading"><h3>{t('任务留档')}</h3><span>{number(tasks.length)} / {number(50)}</span></div>
    <p className="appearance-hint">{t('每次交流必须说明必要目的；任务、问答和结果均保存为人类可读文本。')}</p>
    {!tasks.length ? <p className="relay-empty">{t('暂无任务记录')}</p> : <ol className="relay-task-list">{tasks.map(task => <li key={task.id}>
      <button type="button" className="relay-task" aria-pressed={selected === task.id} onClick={() => setSelected(task.id)}>
        <strong dir="auto">{task.subject}</strong><span><bdi>{names[task.from]}</bdi><span aria-label={t('转发至')}> → </span><bdi>{names[task.to]}</bdi></span>
        <span>{t(statusKeys[task.status])}</span><time dateTime={task.updatedAt || undefined}>{task.updatedAt ? date(task.updatedAt) : t('未知')}</time>
      </button>
    </li>)}</ol>}
    {selected && <div className="relay-transcript"><label htmlFor="relay-transcript">{t('可读会话记录')}</label>
      <pre id="relay-transcript" dir="auto" tabIndex={0}>{loadingTranscript ? t('正在读取留档') : transcript}</pre>
    </div>}
    <button className="dock-button" disabled={!window.panel || busy} onClick={() => void action(async () => { await window.panel!.openRelayArchive(); })}>{t('打开留档文件夹')}</button>
  </fieldset>;
}
