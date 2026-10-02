import { useEffect, useMemo, useRef, useState, type CSSProperties, type HTMLAttributes } from 'react';
import { Activity, ArrowLeftToLine, ArrowRightToLine, Check, ChevronLeft, ChevronRight, GripVertical, LockKeyhole, MapPin, RefreshCw, Settings2, UnlockKeyhole, X } from 'lucide-react';
import { providers } from './data';
import { TestControls } from './TestControls';
import { useCardSort } from './useCardSort';
import { applyTestPreset, defaultTestConfig, makeTestStatus, type TestSelection } from './test-mode';
import Big from 'big.js';
import type { LocalStatus, LocalProviderStatus, PanelState, Preferences, Provider, ProviderId, Quota } from './types';

const previewState: PanelState = {
  side: 'right', locked: false, animate: true, collapsed: false,
  desktop: false, platform: 'browser', scaleFactor: window.devicePixelRatio,
  providerOrder: readOrder(),
};
function readOrder(): ProviderId[] {
  const fallback = providers.map(provider => provider.id);
  try {
    const value = JSON.parse(localStorage.getItem('ai-watch:provider-order') || 'null');
    return Array.isArray(value) && value.length === 4 && new Set(value).size === 4 && value.every(id => fallback.includes(id)) ? value : fallback;
  } catch { return fallback; }
}
function readImages(): Partial<Record<ProviderId, string>> {
  try { return JSON.parse(localStorage.getItem('ai-watch:images') ?? '{}'); }
  catch { return {}; }
}
function Avatar({ provider, image, monitor = false }: { provider: Provider; image?: string; monitor?: boolean }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [image]);
  const attention = provider.id === 'codex' && (provider.local?.activity === 'waiting' || (provider.local?.waitingTasks || 0) > 0);
  const glow = monitor ? attention ? 'attention' : provider.running ? 'running' : 'off' : 'off';
  return <div className="avatar" data-provider={provider.id} data-glow={glow}>
    <div className="avatar-face">
    {failed ? <span>{provider.name.slice(0, 1)}</span> : <img src={image || `./${provider.image}`} alt={`${provider.name} 助手图片`} onError={() => setFailed(true)} />}
    </div>
  </div>;
}
function money(value: string) {
  const number = new Big(value);
  if (number.gt(0) && number.lt('0.01')) return '<0.01';
  if (number.lt(0) && number.gt('-0.01')) return '−<0.01';
  return number.toFixed(2);
}
function BalanceCard({ local }: { local: LocalProviderStatus }) {
  const wallets = local.balance?.wallets || [];
  const [page, setPage] = useState(0);
  const current = Math.min(page, Math.max(0, wallets.length - 1));
  const wallet = wallets[current];
  const stale = local.balance?.stale;
  return <div className="balance-content" aria-label="DeepSeek 账户余额">
    {wallet ? <>
      <div className="balance-caption"><span>{stale ? '历史余额 · 待更新' : '账户可用余额'}</span>
        {wallets.length > 1 && <button className="currency-switch" onClick={() => setPage((current + 1) % wallets.length)} aria-label="切换余额币种">{wallet.currency} ↔</button>}
      </div>
      <div className={`balance-total ${stale ? 'is-stale' : ''}`} title={`${wallet.currency} ${wallet.total}`}><small>{wallet.currency === 'CNY' ? '¥' : '$'}</small><strong>{money(wallet.total)}</strong><span>{wallet.currency}</span></div>
      <div className="balance-parts"><span>现金 <b title={wallet.paid}>{money(wallet.paid)}</b></span><span>赠送 <b title={wallet.bonus}>{money(wallet.bonus)}</b></span></div>
    </> : <div className="balance-empty"><strong>{local.connection === 'auth-required' ? '等待 Harness 登录' : local.connection === 'ready' ? '暂无钱包记录' : '余额暂不可用'}</strong><p>{local.detail}</p></div>}
  </div>;
}
function ProviderCard({ provider, index, image, testing = false, sortProps, dragging = false }: {
  provider: Provider; index: number; image?: string; testing?: boolean; sortProps?: HTMLAttributes<HTMLElement>; dragging?: boolean;
}) {
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(provider.quotas.length / 3));
  const currentPage = Math.min(page, pages - 1);
  useEffect(() => setPage((old) => Math.min(old, pages - 1)), [pages]);
  const quotas = provider.quotas.length ? provider.quotas.slice(currentPage * 3, currentPage * 3 + 3)
    : [{ model: '模型额度', period: '尚未读取', remaining: null, reset: '' }];
  const local = provider.local;
  const isBalance = local?.id === 'deepseek';
  const source = testing ? '测试数据' : !local ? '演示' : local.connection === 'offline' ? '未运行'
    : local.connection === 'auth-required' ? '待登录' : local.source === 'account' ? '账号余额'
    : local.source === 'local-api' ? '本地服务' : local.source === 'cache' ? isBalance ? '历史记录' : '本地记录' : '未连接';
  const phase = !local ? provider.running ? '演示运行' : '演示待机'
    : { running: '运行中', idle: '待机', waiting: local.id === 'codex' ? local.waitingReason === 'input' ? '待回答' : local.waitingReason === 'approval' ? '待授权' : '待处理' : '待确认', unknown: '未知', offline: '离线' }[local.activity];
  const time = local?.observedAt ? new Date(local.observedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '';
  function quotaTitle(quota: Quota) {
    const reset = quota.reset && local ? `重置时间 ${new Date(quota.reset).toLocaleString('zh-CN')}` : quota.reset;
    return `${quota.model} · ${quota.period}${reset ? ` · ${reset}` : ''}${quota.stale ? ` · 已过时，历史剩余 ${quota.remaining ?? '未知'}%` : ''}`;
  }
  return <section {...sortProps} className={`provider-card ${provider.running ? 'is-running' : ''} ${dragging ? 'is-dragging' : ''}`} style={{ '--accent': provider.color, ...sortProps?.style } as CSSProperties}
    aria-label={`${provider.name} 面板`} data-provider={provider.id} data-attention={local?.id === 'codex' && local.activity === 'waiting'} tabIndex={0} aria-describedby="card-sort-help" onDragStart={event => event.preventDefault()}>
    <div className="card-heading">
      <Avatar provider={provider} image={image} monitor />
      <div className="identity"><span className="eyebrow">{local?.id === 'claude' ? '桌面版 · 终端版' : provider.subtitle}</span><h2>{provider.name}</h2></div>
      <span className="card-index" title="长按卡片拖动排序"><GripVertical size={10} aria-hidden="true" /><span>0{index + 1}</span></span>
    </div>
    <div className="quota-area">
      <div className="quota-tools">
        <span className={`source-tag ${local ? 'local' : ''}`} title={local ? `${local.detail}${local.observedAt ? ` 额度记录于 ${new Date(local.observedAt).toLocaleString('zh-CN')}` : ''}` : '仅用于布局的演示数据'}>{source}</span>
        {!isBalance && pages > 1 ? <div className="quota-pagination" aria-label={`${provider.name} 额度分页`}>
          <button aria-label={`${provider.name} 上一页额度`} disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}><ChevronLeft size={11} /></button>
          <span title={`共 ${provider.quotas.length} 个模型额度`}>{currentPage + 1}/{pages}</span>
          <button aria-label={`${provider.name} 下一页额度`} disabled={currentPage === pages - 1} onClick={() => setPage(currentPage + 1)}><ChevronRight size={11} /></button>
        </div> : <span className="quota-time" title={local?.observedAt ? `记录于 ${new Date(local.observedAt).toLocaleString('zh-CN')}` : ''}>{local ? local.id === 'claude' && !local.quotas.length ? '未提供 Code 额度' : time ? `记录 ${time}` : isBalance ? '自动识别登录态' : '额度未知' : '示例额度'}</span>}
      </div>
      {isBalance ? <BalanceCard local={local} /> : local?.id === 'claude' && !local.quotas.length ? <div className="claude-empty"><strong>Code 额度暂不可用</strong><p>Free 账号不包含 Code 权限</p><small>{local.surfaces?.desktop}<br />{local.surfaces?.terminal}</small></div> : <div className="quota-list" aria-label={`${testing ? '测试' : local ? '本地' : '演示'}剩余额度`}>
        {quotas.map((quota, row) => {
          const known = quota.remaining !== null && !quota.stale;
          return <div className={`quota ${known ? '' : 'quota-unknown'}`} key={`${quota.model}:${quota.period}:${row}`} title={quotaTitle(quota)}>
            <div className="quota-label"><span><span className="model-name">{local?.id === 'antigravity' ? quota.model.replace(/^Claude /, '').replace(/\(High\)/gi, '· 高').replace(/\(Medium\)/gi, '· 中').replace(/\(Low\)/gi, '· 低').replace(/\(Thinking\)/gi, '· 思考') : quota.model}</span>{local?.id !== 'antigravity' && <small>{quota.period}</small>}</span><strong><span className="remaining-label">{quota.stale ? '过时' : known ? '剩余' : '未知'}</span>{known ? quota.remaining : '—'}{known && <em>%</em>}</strong></div>
            <div className="quota-track" role="progressbar" aria-label={`${quota.model} ${quota.period} 剩余额度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={known ? quota.remaining! : undefined} aria-valuetext={known ? `${quota.remaining}%` : quota.stale ? '记录已过时' : '未知'}>
              {known && <div className={`quota-fill ${quota.remaining! < 30 ? 'is-low' : ''}`} style={{ width: `${quota.remaining}%` }} />}
            </div>
          </div>;
        })}
      </div>}
    </div>
    <div className="task-line" title={local?.activityDetail || local?.detail}><span className={`status-dot ${provider.running ? 'active' : ''} ${local?.activity === 'unknown' ? 'unknown' : local?.activity === 'waiting' ? 'waiting' : ''}`} /><span>{provider.task}</span><span className="task-status">{phase}</span></div>
  </section>;
}

export default function App() {
  const [state, setState] = useState(previewState);
  const [localStatus, setLocalStatus] = useState<LocalStatus | null>(null);
  const [testMode, setTestMode] = useState(false);
  const [testConfig, setTestConfig] = useState(defaultTestConfig);
  const [testSampledAt, setTestSampledAt] = useState(() => new Date().toISOString());
  const testStatus = useMemo(() => makeTestStatus(testConfig, testSampledAt), [testConfig, testSampledAt]);
  const displayStatus = testMode ? testStatus : localStatus;
  const [images, setImages] = useState(readImages);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState('');
  const [orderSaving, setOrderSaving] = useState(false);
  const [draft, setDraft] = useState<Preferences>(previewState);
  const modal = useRef<HTMLDialogElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const targetImage = useRef<ProviderId>('claude');
  const visibleProviders = state.providerOrder.map(id => providers.find(provider => provider.id === id)!).map((provider) => {
    if (!state.desktop && !testMode) return provider;
    const local = displayStatus?.[provider.id];
    return { ...provider, running: local?.activity === 'running', task: local?.task || '正在读取本地状态',
      quotas: local?.quotas || [], local: local || { id: provider.id, source: 'unavailable' as const,
        connection: 'unavailable' as const, activity: 'unknown' as const, activeTasks: 0,
        task: '正在读取本地状态', quotas: [], observedAt: null, sampledAt: null, detail: '等待首次读取' } };
  });
  const activeTasks = providers.reduce((total, provider) => total + (displayStatus?.[provider.id].activeTasks || 0), 0);
  const refreshTime = displayStatus?.sampledAt ? new Date(displayStatus.sampledAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '读取中';
  const sorting = useCardSort(state.providerOrder, order => { void saveOrder(order); }, settingsOpen || state.collapsed || orderSaving);

  async function saveOrder(order: ProviderId[]) {
    if (orderSaving) return;
    const previous = state.providerOrder;
    setOrderSaving(true); setState(current => ({ ...current, providerOrder: order }));
    try {
      if (window.panel) setState(await window.panel.setOrder(order));
      else localStorage.setItem('ai-watch:provider-order', JSON.stringify(order));
      setNotice('模块顺序已保存');
    } catch { setState(current => ({ ...current, providerOrder: previous })); setNotice('顺序保存失败，已恢复原顺序'); }
    finally { setOrderSaving(false); }
  }

  function openSettings() { setDraft({ side: state.side, locked: state.locked, animate: state.animate }); setSettingsOpen(true); }
  function toggleTestMode(enabled: boolean) {
    setTestMode(enabled); setTestSampledAt(new Date().toISOString());
    setNotice(enabled ? '测试模式已开启' : state.desktop ? '已恢复本地监看' : '已恢复浏览器预览');
  }
  function changeTestSelection(id: ProviderId, patch: Partial<TestSelection>) {
    setTestConfig(current => ({ ...current, [id]: { ...current[id], ...patch } }));
    setTestSampledAt(new Date().toISOString());
  }

  useEffect(() => {
    const bridge = window.panel;
    if (!bridge) return;
    const acceptStatus = (next: LocalStatus) => setLocalStatus((current) =>
      current?.sampledAt && (!next.sampledAt || Date.parse(next.sampledAt) < Date.parse(current.sampledAt)) ? current : next);
    bridge.getState().then(setState).catch(() => setNotice('无法读取窗口状态'));
    bridge.getStatus().then(acceptStatus).catch(() => setNotice('无法读取本地工具状态'));
    const stateListener = bridge.onState(setState);
    const statusListener = bridge.onStatus(acceptStatus);
    return () => { stateListener(); statusListener(); };
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timeout = setTimeout(() => setNotice(''), 3500);
    return () => clearTimeout(timeout);
  }, [notice]);
  useEffect(() => {
    if (settingsOpen) modal.current?.showModal();
    else modal.current?.close();
  }, [settingsOpen]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'b' && !state.desktop) {
        event.preventDefault(); setState((old) => ({ ...old, collapsed: !old.collapsed }));
      }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [state.desktop]);

  async function toggleLock() {
    try {
      if (window.panel) setState(await window.panel.setLocked(!state.locked));
      else { setState({ ...state, locked: !state.locked }); setNotice('浏览器预览：锁定效果请在桌面版查看'); }
    } catch { setNotice('窗口锁定失败，请重试'); }
  }
  async function collapse(value: boolean) {
    try {
      if (window.panel) setState(await window.panel.setCollapsed(value));
      else setState({ ...state, collapsed: value });
    } catch { setNotice('窗口收起失败，请重试'); }
  }
  async function refresh() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      if (testMode) {
        await new Promise(resolve => setTimeout(resolve, 450));
        setTestSampledAt(new Date().toISOString()); setNotice('测试画面已刷新');
      } else if (window.panel) {
        setLocalStatus(await window.panel.refreshStatus());
        setNotice('本地状态已重新读取');
      } else setNotice('浏览器预览使用演示数据；本地接入请打开桌面版');
    } catch { setNotice('本地状态读取失败，稍后自动重试'); }
    finally {
      setRefreshing(false);
    }
  }
  async function saveSettings() {
    try {
      if (window.panel) setState(await window.panel.configure(draft));
      else setState({ ...state, ...draft });
      setSettingsOpen(false); setNotice('配置已保存');
    } catch { setNotice('保存失败，请重试'); }
  }
  function storeImage(provider: ProviderId, value: string) {
    const next = { ...images, [provider]: value };
    try { localStorage.setItem('ai-watch:images', JSON.stringify(next)); setImages(next); }
    catch { setNotice('图片存储空间不足，请使用更小的图片'); }
  }
  async function chooseImage(provider: ProviderId) {
    try {
      if (window.panel) {
        const value = await window.panel.chooseImage(provider);
        if (value) storeImage(provider, value);
      } else { targetImage.current = provider; fileInput.current?.click(); }
    } catch { setNotice('无法读取图片，请选择 8 MB 以内的 PNG、JPG 或 WebP'); }
  }
  async function readFile(file?: File) {
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 8 * 1024 * 1024) {
      setNotice('请选择 8 MB 以内的 PNG、JPG 或 WebP'); return;
    }
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(file);
    });
    const image = new Image(); image.src = dataUrl;
    try {
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = 256; canvas.height = Math.round(256 * image.height / image.width);
      canvas.getContext('2d')!.drawImage(image, 0, 0, canvas.width, canvas.height);
      storeImage(targetImage.current, canvas.toDataURL('image/png'));
    } catch { setNotice('无法读取这张图片'); }
  }

  return <main data-sampled-at={displayStatus?.sampledAt || ''} data-test-mode={testMode} className={`panel ${state.collapsed ? 'collapsed' : ''} ${settingsOpen ? 'settings-open' : ''} ${!state.animate ? 'no-animation' : ''}`}>
    {state.collapsed ? <aside className="collapsed-rail" aria-label="收起的监看面板">
      <div className="rail-grip"><GripVertical size={15} /></div>
      <button className="rail-expand" title="展开面板" aria-label="展开面板" onClick={() => collapse(false)}>{state.side === 'right' ? <ChevronLeft size={20} /> : <ChevronRight size={20} />}</button>
      <span className="rail-brand">AI</span>
      <div className="rail-providers">{visibleProviders.map((provider) => <div key={provider.id} title={`${provider.name} · ${provider.local?.task || (provider.running ? '演示运行中' : '演示待机')}`} style={{ '--accent': provider.color } as CSSProperties}>
        <Avatar provider={provider} image={images[provider.id]} monitor /><span className={`status-dot ${provider.running ? 'active' : provider.local?.activity === 'waiting' ? 'waiting' : provider.local?.activity === 'unknown' ? 'unknown' : ''}`} />
      </div>)}</div>
      <button className={`rail-lock ${state.locked ? 'selected' : ''}`} title="锁定窗口" aria-label="锁定窗口" aria-pressed={state.locked} onClick={toggleLock}>{state.locked ? <LockKeyhole size={15} /> : <UnlockKeyhole size={15} />}</button>
      {testMode ? <button className="rail-demo test-badge" aria-label="测试模式设置" onClick={async () => { await collapse(false); openSettings(); }}>测试</button> : <span className="rail-demo">{state.desktop ? '本地' : '演示'}</span>}
    </aside> : <div className={`panel-regions ${sorting.sorting ? 'is-sorting' : ''}`}>
      <header className="control-region">
        <div className="brand-line"><div className="brand"><Activity size={15} strokeWidth={1.7} /><h1>AI WATCH</h1></div><GripVertical size={13} className="drag-hint" /></div>
        <div className="overview" title={testMode ? '当前运行数、任务、额度与余额均为手动选择的测试数据。' : '运行数只统计本地接入且有运行证据的任务；未知状态和演示卡片不计入。'}><span><span className={`tiny-dot ${activeTasks ? 'active' : ''}`} />{state.desktop || testMode ? `${activeTasks} 项运行` : '界面预览'} {testMode ? <button className="demo-tag test-badge" aria-label="测试模式设置" onClick={openSettings}>测试模式</button> : <span className="demo-tag">{localStatus?.isTestData ? '测试' : state.desktop ? '本地' : '演示'}</span>}</span><time>{state.desktop || testMode ? refreshTime : '演示数据'}</time></div>
        <nav className="toolbar" aria-label="面板控制">
          <button className={state.locked ? 'selected' : ''} aria-label="锁定窗口" aria-pressed={state.locked} title={state.locked ? '解除跨桌面锁定' : '锁定：置顶并显示在所有桌面'} onClick={toggleLock}>{state.locked ? <LockKeyhole /> : <UnlockKeyhole />}</button>
          <button aria-label="收起面板" title="收起为状态窄条" onClick={() => collapse(true)}>{state.side === 'right' ? <ArrowRightToLine /> : <ArrowLeftToLine />}</button>
          <button aria-label="刷新面板" title={testMode ? '刷新测试画面' : '重新读取本地额度与任务状态'} disabled={refreshing} onClick={refresh}><RefreshCw className={refreshing ? 'spinning' : ''} /></button>
          <button aria-label="打开配置" title="配置面板" onClick={openSettings}><Settings2 /></button>
        </nav>
      </header>
      {visibleProviders.map((provider, index) => <ProviderCard key={`${testMode ? 'test' : 'live'}:${provider.id}`} provider={provider} index={index} image={images[provider.id]} testing={Boolean(displayStatus?.isTestData)} dragging={sorting.activeId === provider.id}
        sortProps={{ style: sorting.style(provider.id), onPointerDown: event => sorting.start(event, provider.id), onKeyDown: event => {
          if (event.target !== event.currentTarget || !event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key) || sorting.sorting) return;
          event.preventDefault();
          const next = [...state.providerOrder], target = Math.max(0, Math.min(3, index + (event.key === 'ArrowUp' ? -1 : 1)));
          if (target !== index) { next.splice(index, 1); next.splice(target, 0, provider.id); void saveOrder(next); }
        } }} />)}
    </div>}
    <span id="card-sort-help" className="sr-only">长按卡片约半秒后上下拖动，松开保存顺序；Escape 取消。键盘聚焦卡片后可按 Alt 加上下方向键排序。</span>
    {sorting.sorting && <div className="sort-hint" role="status">拖动排序 · 第 {(sorting.target ?? 0) + 1} 位 · 松开保存</div>}
    <dialog ref={modal} className="settings-dialog" aria-labelledby="settings-title" onCancel={() => setSettingsOpen(false)}>
      <div className="settings-heading"><div><span className="eyebrow">PREFERENCES</span><h2 id="settings-title">面板配置</h2></div><button className="icon-button" aria-label="关闭配置" onClick={() => setSettingsOpen(false)}><X size={18} /></button></div>
      <div className="settings-content">
        <TestControls enabled={testMode} config={testConfig} onToggle={toggleTestMode} onChange={changeTestSelection}
          onPreset={preset => { setTestConfig(current => applyTestPreset(current, preset)); setTestSampledAt(new Date().toISOString()); }}
          onView={() => setSettingsOpen(false)} />
        <fieldset><legend>默认停靠位置</legend><div className="segmented"><button className={draft.side === 'left' ? 'selected' : ''} onClick={() => setDraft({ ...draft, side: 'left' })}>左侧</button><button className={draft.side === 'right' ? 'selected' : ''} onClick={() => setDraft({ ...draft, side: 'right' })}>右侧</button></div></fieldset>
        <label className="switch-row"><span>跨桌面锁定<small>置顶并跟随桌面切换</small></span><input type="checkbox" checked={draft.locked} onChange={(event) => setDraft({ ...draft, locked: event.target.checked })} /></label>
        <label className="switch-row"><span>状态灯动画<small>LOGO 外沿每 5 秒呼吸一次</small></span><input type="checkbox" checked={draft.animate} onChange={(event) => setDraft({ ...draft, animate: event.target.checked })} /></label>
        <button className="dock-button" onClick={async () => {
          try { if (window.panel) setState(await window.panel.dock()); setNotice('已重新贴边'); }
          catch { setNotice('重新贴边失败'); }
        }}><MapPin size={14} />重新贴到屏幕边缘</button>
        <div className="settings-section"><h3>助手图片</h3><p>透明图片效果更好</p>{providers.map((provider) => <div className="image-option" key={provider.id} style={{ '--accent': provider.color } as CSSProperties}>
          <Avatar provider={provider} image={images[provider.id]} /><span>{provider.name}</span><button onClick={() => chooseImage(provider.id)} aria-label={`替换 ${provider.name} 图片`}>替换</button>
        </div>)}</div>
        <div className="settings-note"><span className="note-title">本地状态 · v0.7</span><p>Codex 读取本地额度与任务记录；Antigravity 优先读取本地服务，每 5 秒检查任务，每 30 秒读取额度。刷新按钮会重新读取。运行时 LOGO 显示对应颜色的光晕，Codex 待回答或待授权时优先显示红色。</p><p>DeepSeek 使用本设备 Harness 已有登录态查询余额，每分钟更新。换设备后先在 Harness 登录，面板自动识别，无需复制 Key。账号切换或退出后会清除旧余额。</p><p>Claude 自动发现桌面与终端会话，读取桌面用量历史；Free 账号不包含 Code 权限，缺少额度时明确显示不可用。DeepSeek 结合会话记录与进程识别任务活动，黄色表示等待确认。浏览器预览全部使用示例。</p>
          {displayStatus && <>{(['claude', 'codex', 'antigravity', 'deepseek'] as const).map((id) => <p key={id}><b>{id === 'claude' ? 'Claude Code' : id === 'codex' ? 'Codex' : id === 'deepseek' ? 'DeepSeek Harness' : 'Antigravity'}</b><br />{displayStatus[id].detail}<br />{displayStatus[id].activityDetail && <>{displayStatus[id].activityDetail}<br /></>}{displayStatus[id].observedAt ? `记录时间：${new Date(displayStatus[id].observedAt!).toLocaleString('zh-CN')}` : '尚无可用记录'}</p>)}</>}
          <p>{state.desktop ? `桌面版 · 显示缩放 ${state.scaleFactor}×` : '浏览器预览 · 窗口操作请使用桌面版'}</p></div>
      </div>
      <div className="settings-footer"><button className="save-button" onClick={saveSettings}><Check size={15} />保存配置</button>{state.desktop && <button className="quit-button" onClick={() => window.panel?.quit()}>退出面板</button>}</div>
      {notice && settingsOpen && <div className="toast" role="status">{notice}</div>}
    </dialog>
    <input ref={fileInput} className="hidden-input" type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => { void readFile(event.target.files?.[0]); event.target.value = ''; }} />
    {notice && !settingsOpen && <div className="toast" role="status">{notice}</div>}
  </main>;
}
