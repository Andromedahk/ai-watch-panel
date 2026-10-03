import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type HTMLAttributes } from 'react';
import { Activity, ArrowLeftToLine, ArrowRightToLine, Check, ChevronLeft, ChevronRight, GripVertical, LockKeyhole, MapPin, RefreshCw, Settings2, UnlockKeyhole, X } from 'lucide-react';
import { providers, providerIds, animeImages as defaultAnimeImages } from './data';
import { useVisibleCards } from './useVisibleCards';
import { TestControls } from './TestControls';
import { useCardSort } from './useCardSort';
import { applyTestPreset, defaultTestConfig, makeTestStatus, type TestSelection } from './test-mode';
import Big from 'big.js';
import type { LocalStatus, LocalProviderStatus, PanelState, Preferences, Provider, ProviderId, Quota, Theme } from './types';

const previewState: PanelState = {
  side: 'right', locked: false, animate: true, collapsed: false,
  desktop: false, platform: 'browser', scaleFactor: window.devicePixelRatio,
  providerOrder: readOrder(), enabledProviders: readEnabled(),
  qwenKeychainAllowed: false,
  animeMode: readAnimeMode(),
  theme: window.panel ? 'system' : readTheme(),
  resolvedTheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
};
function readAnimeMode() {
  try { return localStorage.getItem('ai-watch:anime-mode') === 'true'; } catch { return false; }
}
function readTheme(): Theme {
  try { const theme = localStorage.getItem('ai-watch:theme'); return theme === 'dark' || theme === 'light' ? theme : 'system'; }
  catch { return 'system'; }
}
function readOrder(): ProviderId[] {
  const fallback = providers.map(provider => provider.id);
  try {
    const value = JSON.parse(localStorage.getItem('ai-watch:provider-order') || 'null');
    return Array.isArray(value) && new Set(value).size === value.length && value.every(id => fallback.includes(id))
      ? [...value, ...fallback.filter(id => !value.includes(id))] : fallback;
  } catch { return fallback; }
}
function readEnabled(): ProviderId[] {
  try {
    const value = JSON.parse(localStorage.getItem('ai-watch:enabled-providers') || 'null');
    if (!Array.isArray(value) || new Set(value).size !== value.length || !value.every(id => providerIds.includes(id))) return [...providerIds];
    const previousOrder = JSON.parse(localStorage.getItem('ai-watch:provider-order') || 'null');
    const legacy = Array.isArray(previousOrder) && [4, 6].includes(previousOrder.length)
      && new Set(previousOrder).size === previousOrder.length && previousOrder.every(id => providerIds.slice(0, previousOrder.length).includes(id));
    const enabled = value.length && legacy ? [...value, ...providerIds.filter(id => !previousOrder.includes(id) && !value.includes(id))] : value;
    if (legacy) {
      localStorage.setItem('ai-watch:provider-order', JSON.stringify(readOrder()));
      localStorage.setItem('ai-watch:enabled-providers', JSON.stringify(enabled));
    }
    return enabled;
  } catch { return [...providerIds]; }
}
function readImages(anime = false): Partial<Record<ProviderId, string>> {
  try { return JSON.parse(localStorage.getItem(anime ? 'ai-watch:anime-images' : 'ai-watch:images') ?? '{}'); }
  catch { return {}; }
}
function Avatar({ provider, image, monitor = false, anime = false }: { provider: Provider; image?: string; monitor?: boolean; anime?: boolean }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [image, anime]);
  const attention = provider.id === 'codex' && (provider.local?.activity === 'waiting' || (provider.local?.waitingTasks || 0) > 0);
  const glow = monitor ? attention ? 'attention' : provider.running ? 'running' : 'off' : 'off';
  return <div className="avatar" data-provider={provider.id} data-glow={glow} data-default-image={!image && !anime} data-anime={anime}>
    <div className="avatar-face">
    {failed ? <span>{provider.name.slice(0, 1)}</span> : <img src={image || (anime ? `./anime/${defaultAnimeImages[provider.id]}` : `./${provider.image}`)} alt={`${provider.name} 助手图片`} onError={() => setFailed(true)} />}
    </div>
  </div>;
}
function LaunchAvatar({ provider, image, anime, onOpen, busy = false }: {
  provider: Provider; image?: string; anime: boolean; onOpen: () => void; busy?: boolean;
}) {
  return <button type="button" className="avatar-launch" aria-label={`打开 ${provider.name}`} title={`打开 ${provider.name}`} disabled={busy} onClick={onOpen}>
    <Avatar provider={provider} image={image} anime={anime} monitor />
  </button>;
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
function creditNumber(value: string) {
  try {
    const number = new Big(value);
    if (number.gt(0) && number.lt('0.01')) return '<0.01';
    return number.toFixed(2).replace(/\.?0+$/, '').replace(/^$/, '0');
  } catch { return '—'; }
}
function PlanBadge({ provider, compact = false }: { provider: Provider; compact?: boolean }) {
  const local = provider.local;
  const plan = local?.plan;
  const expired = Boolean(plan?.expiresAt && Date.parse(plan.expiresAt) <= Date.now());
  const label = plan?.name || (local ? '套餐未知' : '示例套餐');
  const displayLabel = compact && !plan?.name ? local ? '未知' : '示例' : label;
  const state = plan?.name ? plan.stale ? '历史' : expired ? '已到期' : '' : '';
  return <div className={`plan-summary ${plan?.stale ? 'is-stale' : ''}`} aria-label={`${provider.name} 套餐档位`}
    title={[`套餐：${label}`, plan?.status, state, plan?.expiresAt ? `有效期至 ${new Date(plan.expiresAt).toLocaleString('zh-CN')}` : ''].filter(Boolean).join(' · ')}>
    <span className="plan-name">{displayLabel}</span>{state && <span className="plan-status">{state}</span>}
  </div>;
}
function EntitlementCard({ provider, page }: { provider: Provider; page: number }) {
  const local = provider.local;
  const credits = local?.credits;
  const items = local ? credits?.items || [] : [{ label: '示例积分', remaining: '1234.5', unit: '积分', total: '2000' }];
  return <div className="entitlement-content">
    <div className="credits-list" aria-label={`${provider.name} 剩余积分`}>
      {items.length ? items.slice(page * 2, page * 2 + 2).map((item, index) => <div className={`credit-item ${credits?.stale ? 'is-stale' : ''}`} key={`${item.label}:${index}`}
        title={[item.label, item.remaining === null ? '剩余未知' : `剩余 ${item.remaining} ${item.unit}`, item.total != null ? `总量 ${item.total} ${item.unit}` : '', item.reset ? `重置 / 到期时间 ${new Date(item.reset).toLocaleString('zh-CN')}` : '', credits?.stale ? '历史快照，当前值待更新' : ''].filter(Boolean).join(' · ')}>
        <div className="credit-label">{item.label}</div>
        <div className="credit-amount"><span>{credits?.stale ? '历史' : item.remaining === null ? '未知' : '剩余'}</span><strong className="credit-value">{item.remaining === null ? '—' : creditNumber(item.remaining)}</strong><small>{item.unit}</small></div>
      </div>) : <div className="credits-empty"><strong>{local?.accessRequired ? '等待登录读取授权' : local?.connection === 'auth-required' ? '等待客户端登录' : local?.connection === 'error' ? '积分读取失败' : '积分 / 额度未知'}</strong><span>—</span><p title={local?.detail}>{local?.detail || '等待首次读取'}</p></div>}
    </div>
  </div>;
}
function ProviderCard({ provider, index, image, anime = false, onOpen, launchBusy, testing = false, sortProps, dragging = false }: {
  provider: Provider; index: number; image?: string; anime?: boolean; onOpen: () => void; launchBusy?: boolean; testing?: boolean; sortProps?: HTMLAttributes<HTMLElement>; dragging?: boolean;
}) {
  const [page, setPage] = useState(0);
  const local = provider.local;
  const isEntitlement = provider.id === 'qwen' || provider.id === 'workbuddy';
  const itemCount = isEntitlement ? local?.credits?.items.length || 0 : provider.quotas.length;
  const pageSize = isEntitlement || anime ? 2 : 3;
  const pages = Math.max(1, Math.ceil(itemCount / pageSize));
  const currentPage = Math.min(page, pages - 1);
  useEffect(() => setPage((old) => Math.min(old, pages - 1)), [pages]);
  const quotas = provider.quotas.length ? provider.quotas.slice(currentPage * pageSize, currentPage * pageSize + pageSize)
    : [{ model: '模型额度', period: '尚未读取', remaining: null, reset: '' }];
  const isBalance = local?.id === 'deepseek';
  const source = testing ? '测试数据' : !local ? '演示' : local.connection === 'offline' ? '未运行'
    : local.accessRequired ? '待授权' : local.connection === 'auth-required' ? '待登录' : local.source === 'account' ? isBalance ? '账号余额' : '账号额度'
    : local.source === 'local-api' ? '本地服务' : local.source === 'cache' ? isBalance ? '历史记录' : local.id === 'codex' && local.plan?.status === '官方查询缓存' ? '查询缓存' : '本地记录' : '未连接';
  const phase = !local ? provider.running ? '演示运行' : '演示待机'
    : { running: '运行中', idle: '待机', waiting: local.id === 'codex' ? local.waitingReason === 'input' ? '待回答' : local.waitingReason === 'approval' ? '待授权' : '待处理' : '待确认', unknown: '未知', offline: '离线' }[local.activity];
  const time = local?.observedAt ? new Date(local.observedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '';
  function quotaTitle(quota: Quota) {
    const reset = quota.reset && local ? `重置时间 ${new Date(quota.reset).toLocaleString('zh-CN')}` : quota.reset;
    return `${quota.model} · ${quota.period}${reset ? ` · ${reset}` : ''}${quota.variants?.length ? ` · 合并：${quota.variants.join('、')}；剩余额度取较低值` : ''}${quota.stale ? ` · 已过时，历史剩余 ${quota.remaining ?? '未知'}%` : ''}`;
  }
  return <section {...sortProps} className={`provider-card ${provider.running ? 'is-running' : ''} ${dragging ? 'is-dragging' : ''}`} style={{ '--accent': provider.color, ...sortProps?.style } as CSSProperties}
    aria-label={`${provider.name} 面板`} data-provider={provider.id} data-attention={local?.id === 'codex' && local.activity === 'waiting'} tabIndex={0} aria-describedby="card-sort-help" onDragStart={event => event.preventDefault()}>
    <div className="card-heading">
      <LaunchAvatar provider={provider} image={image} anime={anime} onOpen={onOpen} busy={launchBusy} />
      <div className="identity"><span className="eyebrow">{local?.id === 'claude' ? '桌面版 · 终端版' : provider.subtitle}</span><h2>{provider.name}</h2>{provider.id !== 'deepseek' && <PlanBadge provider={provider} compact={anime} />}</div>
      <span className="card-index" title="长按卡片拖动排序"><GripVertical size={10} aria-hidden="true" /><span>0{index + 1}</span></span>
    </div>
    <div className="quota-area">
      <div className="quota-tools">
        <span className={`source-tag ${local ? 'local' : ''}`} title={local ? `${local.detail}${local.observedAt ? ` 额度记录于 ${new Date(local.observedAt).toLocaleString('zh-CN')}` : ''}` : '仅用于布局的演示数据'}>{source}</span>
        {!isBalance && pages > 1 ? <div className="quota-pagination" aria-label={`${provider.name} 额度分页`}>
          <button aria-label={`${provider.name} 上一页额度`} disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}><ChevronLeft size={11} /></button>
          <span title={`共 ${itemCount} 项${isEntitlement ? '积分 / 次数' : '模型额度'}`}>{currentPage + 1}/{pages}</span>
          <button aria-label={`${provider.name} 下一页额度`} disabled={currentPage === pages - 1} onClick={() => setPage(currentPage + 1)}><ChevronRight size={11} /></button>
        </div> : <span className="quota-time" title={local?.observedAt ? `记录于 ${new Date(local.observedAt).toLocaleString('zh-CN')}` : ''}>{local ? local.id === 'claude' && !local.quotas.length ? '未提供 Code 额度' : time ? `记录 ${time}` : isBalance ? '自动识别登录态' : '额度未知' : '示例额度'}</span>}
      </div>
      {isEntitlement ? <EntitlementCard provider={provider} page={currentPage} /> : isBalance ? <BalanceCard local={local} /> : local?.id === 'claude' && !local.quotas.length ? <div className="claude-empty"><strong>Code 额度暂不可用</strong><p>{local.plan?.name === 'Free' ? 'Free 账号不包含 Code 权限' : '当前本地记录未提供额度窗口'}</p><small>{local.surfaces?.desktop}<br />{local.surfaces?.terminal}</small></div> : <div className="quota-list" aria-label={`${testing ? '测试' : local ? '本地' : '演示'}剩余额度`}>
        {quotas.map((quota, row) => {
          const known = quota.remaining !== null && !quota.stale;
          const historical = provider.id === 'codex' && quota.stale && quota.remaining !== null;
          const visible = known || historical;
          return <div className={`quota ${known ? '' : 'quota-unknown'} ${historical ? 'quota-historical' : ''}`} key={`${quota.model}:${quota.period}:${row}`} title={quotaTitle(quota)}>
            <div className="quota-label"><span><span className="model-name">{local?.id === 'antigravity' ? quota.model.replace(/^Claude /, '').replace(/\(High\)/gi, '· 高').replace(/\(Medium\)/gi, '· 中').replace(/\(Low\)/gi, '· 低').replace(/\(Thinking\)/gi, '· 思考') : quota.model}</span>{local?.id !== 'antigravity' && <small>{quota.period}</small>}</span><strong><span className="remaining-label">{historical ? '历史' : quota.stale ? '过时' : known ? '剩余' : '未知'}</span>{visible ? quota.remaining : '—'}{visible && <em>%</em>}</strong></div>
            <div className="quota-track" role="progressbar" aria-label={`${quota.model} ${quota.period} 剩余额度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={known ? quota.remaining! : undefined} aria-valuetext={historical ? `历史剩余 ${quota.remaining}%，当前额度待更新` : known ? `${quota.remaining}%` : quota.stale ? '记录已过时' : '未知'}>
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
  const [images, setImages] = useState(() => readImages());
  const [animeImages, setAnimeImages] = useState(() => readImages(true));
  const [animeSaving, setAnimeSaving] = useState(false);
  const [launching, setLaunching] = useState<ProviderId | null>(null);
  const [choosingApp, setChoosingApp] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState('');
  const [orderSaving, setOrderSaving] = useState(false);
  const [themeSaving, setThemeSaving] = useState(false);
  const [modulesSaving, setModulesSaving] = useState(false);
  const [qwenAccessSaving, setQwenAccessSaving] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);
  const enabledOrder = state.providerOrder.filter(id => state.enabledProviders.includes(id));
  const visibleCards = useVisibleCards(viewport, enabledOrder, state.collapsed, testMode);
  const resolvedTheme = state.theme === 'system' ? state.resolvedTheme : state.theme;
  const [draft, setDraft] = useState<Preferences>(previewState);
  const modal = useRef<HTMLDialogElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const targetImage = useRef<{ provider: ProviderId; anime: boolean }>({ provider: 'claude', anime: false });
  const visibleProviders = enabledOrder.map(id => providers.find(provider => provider.id === id)!).map((provider) => {
    if (!state.desktop && !testMode) return provider;
    const local = displayStatus?.[provider.id];
    return { ...provider, running: local?.activity === 'running', task: local?.task || '正在读取本地状态',
      quotas: local?.quotas || [], local: local || { id: provider.id, source: 'unavailable' as const,
        connection: 'unavailable' as const, activity: 'unknown' as const, activeTasks: 0,
        task: '正在读取本地状态', quotas: [], observedAt: null, sampledAt: null, detail: '等待首次读取' } };
  });
  const activeTasks = visibleProviders.reduce((total, provider) => total + (displayStatus?.[provider.id]?.activeTasks || 0), 0);
  const refreshTime = displayStatus?.sampledAt ? new Date(displayStatus.sampledAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '读取中';
  const sorting = useCardSort(enabledOrder, order => { void saveVisibleOrder(order); }, settingsOpen || state.collapsed || orderSaving || modulesSaving);
  const hiddenActive = visibleProviders.filter(provider => !visibleCards.has(provider.id)
    && (provider.running || provider.local?.activity === 'waiting'));
  function revealProvider(id: ProviderId) {
    viewport.current?.querySelector<HTMLElement>(`[data-provider="${id}"]`)?.scrollIntoView({
      behavior: state.animate && !matchMedia('(prefers-reduced-motion: reduce)').matches ? 'smooth' : 'instant', block: 'nearest',
    });
  }
  function saveVisibleOrder(order: ProviderId[]) {
    let index = 0;
    return saveOrder(state.providerOrder.map(id => state.enabledProviders.includes(id) ? order[index++] : id));
  }
  async function changeEnabled(id: ProviderId, enabled: boolean) {
    if (modulesSaving) return;
    const next = state.providerOrder.filter(value => value === id ? enabled : state.enabledProviders.includes(value));
    setModulesSaving(true);
    try {
      if (window.panel) setState(await window.panel.setEnabled(next));
      else { localStorage.setItem('ai-watch:enabled-providers', JSON.stringify(next)); setState(current => ({ ...current, enabledProviders: next })); }
    } catch { setNotice('模块选择保存失败，请重试'); }
    finally { setModulesSaving(false); }
  }
  async function changeAnimeMode(value: boolean) {
    if (animeSaving) return;
    setAnimeSaving(true);
    try {
      if (window.panel) setState(await window.panel.setAnimeMode(value));
      else { localStorage.setItem('ai-watch:anime-mode', String(value)); setState(current => ({ ...current, animeMode: value })); }
    } catch { setNotice('二次元模式保存失败，请重试'); }
    finally { setAnimeSaving(false); }
  }
  async function openProvider(provider: Provider) {
    if (testMode) { if (state.collapsed) await collapse(false); setNotice(`测试模式：已模拟打开 ${provider.name}`); return; }
    if (!window.panel) { if (state.collapsed) await collapse(false); setNotice('打开应用请使用桌面版'); return; }
    if (launching) return;
    setLaunching(provider.id);
    try {
      const result = await window.panel.openProvider(provider.id);
      if (result.status !== 'opened' && state.collapsed) await collapse(false);
      setNotice(result.message);
    } catch { setNotice('应用打开失败，请在配置中检查启动应用'); if (state.collapsed) await collapse(false); }
    finally { setLaunching(null); }
  }
  async function chooseProviderApp(provider: Provider) {
    if (testMode) { setNotice(`测试模式：已模拟选择 ${provider.name} 的启动应用`); return; }
    if (!window.panel) { setNotice('选择启动应用请使用桌面版'); return; }
    if (choosingApp) return;
    setChoosingApp(true);
    try { const result = await window.panel.chooseProviderApp(provider.id); if (result.status !== 'cancelled') setNotice(result.message); }
    catch { setNotice('启动应用保存失败，请重新选择'); }
    finally { setChoosingApp(false); }
  }
  async function changeQwenAccess(allowed: boolean) {
    if (qwenAccessSaving || !window.panel) return;
    setQwenAccessSaving(true);
    try {
      setState(await window.panel.setQwenAccess(allowed));
      setNotice(allowed ? '已允许读取千问登录；如系统弹出授权，请在系统窗口处理' : '已关闭千问登录读取，套餐和积分记录已清除');
    } catch { setNotice('千问登录读取设置保存失败，请重试'); }
    finally { setQwenAccessSaving(false); }
  }

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
  async function changeTheme(theme: Theme) {
    if (themeSaving) return;
    setThemeSaving(true);
    try {
      if (window.panel) setState(await window.panel.setTheme(theme));
      else {
        localStorage.setItem('ai-watch:theme', theme);
        setState(current => ({ ...current, theme }));
      }
    } catch { setNotice('外观保存失败，请重试'); }
    finally { setThemeSaving(false); }
  }
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
  useLayoutEffect(() => { document.documentElement.dataset.theme = resolvedTheme; }, [resolvedTheme]);
  useEffect(() => {
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && focused.matches('.provider-card')) focused.scrollIntoView({ block: 'nearest' });
  }, [state.providerOrder]);
  useEffect(() => {
    if (window.panel) return;
    const media = matchMedia('(prefers-color-scheme: dark)');
    const update = () => setState(current => ({ ...current, resolvedTheme: media.matches ? 'dark' : 'light' }));
    update(); media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
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
  function storeImage(provider: ProviderId, value: string, anime: boolean) {
    const next = { ...(anime ? animeImages : images), [provider]: value };
    try { localStorage.setItem(anime ? 'ai-watch:anime-images' : 'ai-watch:images', JSON.stringify(next)); (anime ? setAnimeImages : setImages)(next); }
    catch { setNotice('图片存储空间不足，请使用更小的图片'); }
  }
  async function chooseImage(provider: ProviderId, anime = false) {
    try {
      if (window.panel) {
        const value = await window.panel.chooseImage(provider);
        if (value) storeImage(provider, value, anime);
      } else { targetImage.current = { provider, anime }; fileInput.current?.click(); }
    } catch { setNotice('无法读取图片，请选择 8 MB 以内的 PNG、JPG 或 WebP'); }
  }
  async function readFile(file?: File) {
    if (!file) return;
    const target = targetImage.current;
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
      storeImage(target.provider, canvas.toDataURL('image/png'), target.anime);
    } catch { setNotice('无法读取这张图片'); }
  }

  return <main data-sampled-at={displayStatus?.sampledAt || ''} data-test-mode={testMode} className={`panel ${state.animeMode ? 'anime-mode' : ''} ${state.collapsed ? 'collapsed' : ''} ${settingsOpen ? 'settings-open' : ''} ${!state.animate ? 'no-animation' : ''}`}>
    {state.collapsed ? <aside className="collapsed-rail" aria-label="收起的监看面板">
      <div className="rail-grip"><GripVertical size={15} /></div>
      <button className="rail-expand" title="展开面板" aria-label="展开面板" onClick={() => collapse(false)}>{state.side === 'right' ? <ChevronLeft size={20} /> : <ChevronRight size={20} />}</button>
      <span className="rail-brand">AI</span>
      <div className="rail-providers">{visibleProviders.map((provider) => <div key={provider.id} title={`${provider.name} · ${provider.local?.task || (provider.running ? '演示运行中' : '演示待机')}`} style={{ '--accent': provider.color } as CSSProperties}>
        <LaunchAvatar provider={provider} image={(state.animeMode ? animeImages : images)[provider.id]} anime={state.animeMode} onOpen={() => void openProvider(provider)} busy={launching === provider.id} /><span className={`status-dot ${provider.running ? 'active' : provider.local?.activity === 'waiting' ? 'waiting' : provider.local?.activity === 'unknown' ? 'unknown' : ''}`} />
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
      <div ref={viewport} className="provider-viewport" aria-label="工具模块列表" aria-busy={orderSaving || modulesSaving} tabIndex={0}>
      {!visibleProviders.length && <div className="empty-providers"><p>尚未启用模块</p><button onClick={openSettings}>选择监看模块</button></div>}
      {visibleProviders.map((provider, index) => <ProviderCard key={`${testMode ? 'test' : 'live'}:${provider.id}`} provider={provider} index={index} image={(state.animeMode ? animeImages : images)[provider.id]} anime={state.animeMode} onOpen={() => void openProvider(provider)} launchBusy={launching === provider.id} testing={Boolean(displayStatus?.isTestData)} dragging={sorting.activeId === provider.id}
        sortProps={{ style: sorting.style(provider.id), onPointerDown: event => sorting.start(event, provider.id), onKeyDown: event => {
          if (event.target !== event.currentTarget || !event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key) || sorting.sorting) return;
          event.preventDefault();
          const next = [...enabledOrder], target = Math.max(0, Math.min(enabledOrder.length - 1, index + (event.key === 'ArrowUp' ? -1 : 1)));
          if (target !== index) { next.splice(index, 1); next.splice(target, 0, provider.id); void saveVisibleOrder(next); }
        } }} />)}
      </div>
    </div>}
    {!state.collapsed && !settingsOpen && !sorting.sorting && hiddenActive.length > 0 && <div className="hidden-activity" aria-label="屏幕外模块活动">
      {hiddenActive.map(provider => <button key={provider.id} className="hidden-activity-light" data-provider={provider.id}
        data-glow={provider.id === 'codex' && provider.local?.activity === 'waiting' ? 'attention' : 'running'}
        aria-label={`${provider.name} ${provider.local?.activity === 'waiting' ? '等待处理' : '正在运行'}，点击查看`}
        title={`${provider.name} · ${provider.local?.activity === 'waiting' ? '等待处理' : '正在运行'} · 点击查看`}
        onClick={() => revealProvider(provider.id)}><span className="sr-only">{provider.name}</span></button>)}
    </div>}
    <span id="card-sort-help" className="sr-only">长按卡片约半秒后上下拖动，松开保存顺序；Escape 取消。键盘聚焦卡片后可按 Alt 加上下方向键排序。</span>
    {sorting.sorting && <div className="sort-hint" role="status">拖动排序 · 第 {(sorting.target ?? 0) + 1} 位 · 松开保存</div>}
    <dialog ref={modal} className="settings-dialog" aria-labelledby="settings-title" onCancel={() => setSettingsOpen(false)}>
      <div className="settings-heading"><div><span className="eyebrow">PREFERENCES</span><h2 id="settings-title">面板配置</h2></div><button className="icon-button" aria-label="关闭配置" onClick={() => setSettingsOpen(false)}><X size={18} /></button></div>
      <div className="settings-content">
        <TestControls enabled={testMode} config={testConfig} onToggle={toggleTestMode} onChange={changeTestSelection}
          onPreset={preset => { setTestConfig(current => applyTestPreset(current, preset)); setTestSampledAt(new Date().toISOString()); }}
          onView={() => setSettingsOpen(false)} />
        <fieldset className="module-settings"><legend>监看模块 · 已启用 {state.enabledProviders.length} / {providers.length}</legend>
          <p className="appearance-hint">即时保存；超过四个可上下滚动。底边彩灯提示滚出视野的活动，点击可定位。</p>
          <div className="module-options">{state.providerOrder.map(id => {
            const provider = providers.find(item => item.id === id)!;
            return <label key={id} className="module-option"><input type="checkbox" aria-label={`启用 ${provider.name}`} checked={state.enabledProviders.includes(id)} disabled={modulesSaving} onChange={event => void changeEnabled(id, event.target.checked)} /><span>{provider.name}</span></label>;
          })}</div>
          <p className="appearance-hint">取消勾选的模块不显示、不提醒；顺序仍保留。</p>
        </fieldset>
        <fieldset className="appearance-settings"><legend>千问登录读取</legend>
          <label className="switch-row"><span>读取千问登录状态<small>仅查询套餐和积分</small></span><input aria-label="读取千问登录状态" type="checkbox" checked={state.qwenKeychainAllowed} disabled={!state.desktop || qwenAccessSaving} onChange={event => void changeQwenAccess(event.target.checked)} /></label>
          <p className="appearance-hint">仅访问千问专属的系统钥匙串记录，可能需要系统授权。登录信息不保存到面板；关闭会清除已读取的套餐和积分。拒绝授权后不会自动反复弹窗，可处理授权后手动刷新。</p>
        </fieldset>
        <fieldset className="appearance-settings"><legend>外观</legend>
          <label className="switch-row"><span>二次元模式<small>大图占卡片约四分之一</small></span><input aria-label="二次元模式" type="checkbox" checked={state.animeMode} disabled={animeSaving} onChange={event => void changeAnimeMode(event.target.checked)} /></label>
          <p className="appearance-hint">使用专属角色图片，WorkBuddy 暂用占位图；可在下方替换。普通 LOGO 独立保留。</p>
          <label className="switch-row"><span>跟随系统<small>自动切换浅色和深色外观</small></span><input aria-label="跟随系统" type="checkbox" checked={state.theme === 'system'} disabled={themeSaving} onChange={event => void changeTheme(event.target.checked ? 'system' : resolvedTheme)} /></label>
          <label className="switch-row"><span>暗夜模式<small>{state.theme === 'system' ? '手动切换后停止跟随系统' : '已手动指定外观'}</small></span><input aria-label="暗夜模式" type="checkbox" checked={resolvedTheme === 'dark'} disabled={themeSaving} onChange={event => void changeTheme(event.target.checked ? 'dark' : 'light')} /></label>
          <p className="appearance-hint">当前为{resolvedTheme === 'dark' ? '深色' : '浅色'} · 立即生效并保存</p>
        </fieldset>
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
        <div className="settings-section"><h3>二次元图片</h3><p>独立保存；推荐透明背景，完整显示不裁切</p>{providers.map(provider => <div className="image-option" key={provider.id} style={{ '--accent': provider.color } as CSSProperties}>
          <Avatar provider={provider} image={animeImages[provider.id]} anime /><span>{provider.name}</span><button onClick={() => chooseImage(provider.id, true)} aria-label={`替换 ${provider.name} 二次元图片`}>替换</button>
        </div>)}</div>
        <div className="settings-section"><h3>启动应用</h3><p>点击卡片或收起栏图标打开应用；未找到时可手动选择安装位置。</p>{providers.map(provider => <div className="app-option" key={provider.id}>
          <span>{provider.name}</span><button disabled={choosingApp} onClick={() => void chooseProviderApp(provider)} aria-label={`选择 ${provider.name} 启动应用`}>选择应用</button>
        </div>)}</div>
        <div className="settings-note"><span className="note-title">本地状态 · v0.14.1</span><p>Codex 使用已有登录每分钟查询官方额度，失败时保留历史值或读取本地记录；Antigravity 同一模型的思考等级合并显示，每 5 秒检查任务，每 30 秒读取额度。刷新按钮会重新读取，联网请求最短间隔 15 秒，失败时自动退避。运行时 LOGO 显示对应颜色的光晕，Codex 待回答或待授权时优先显示红色。</p><p>DeepSeek 使用本设备 Harness 已有登录态查询余额，每分钟更新。换设备后先在 Harness 登录，面板自动识别，无需复制 Key。账号切换或退出后会清除旧余额。</p><p>Claude 自动发现桌面与终端会话，读取桌面用量历史；Free 账号不包含 Code 权限，缺少额度时明确显示不可用。DeepSeek 结合会话记录与进程识别任务活动，黄色表示等待确认。浏览器预览全部使用示例。</p>
          {displayStatus && <>{providerIds.map((id) => <p key={id}><b>{providers.find(provider => provider.id === id)!.name}</b><br />{displayStatus[id]?.detail}<br />{displayStatus[id]?.activityDetail && <>{displayStatus[id]?.activityDetail}<br /></>}{displayStatus[id]?.observedAt ? `记录时间：${new Date(displayStatus[id]?.observedAt!).toLocaleString('zh-CN')}` : '尚无可用记录'}</p>)}</>}
          <p>{state.desktop ? `桌面版 · 显示缩放 ${state.scaleFactor}×` : '浏览器预览 · 窗口操作请使用桌面版'}</p></div>
      </div>
      <div className="settings-footer"><button className="save-button" onClick={saveSettings}><Check size={15} />保存配置</button>{state.desktop && <button className="quit-button" onClick={() => window.panel?.quit()}>退出面板</button>}</div>
      {notice && settingsOpen && <div className="toast" role="status">{notice}</div>}
    </dialog>
    <input ref={fileInput} className="hidden-input" type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => { void readFile(event.target.files?.[0]); event.target.value = ''; }} />
    {notice && !settingsOpen && <div className="toast" role="status">{notice}</div>}
  </main>;
}
