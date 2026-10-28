import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Bell, Activity, ArrowLeftToLine, ArrowRightToLine, Check, LockKeyhole, MapPin, Minimize, PanelTopClose, RefreshCw, Settings2, UnlockKeyhole, X } from 'lucide-react';
import packageInfo from '../package.json';
import { providers as baseProviders, providerIds } from './data';
import { useVisibleCards } from './useVisibleCards';
import { replayEntrance } from './motion';
import { demoJournal, emptyJournal, loadJournal, parseJournal, record, saveJournal, type Journal } from './journal';
import { SyncSettings, syncStatusText } from './SyncSettings';
import { CloudSettings } from './CloudSettings';
import { ScreenSurface } from './ScreenSurface';
import { ScreenQuotaTrend } from './ScreenQuotaTrend';
import { useScreenHistory } from './screen-history';
import { StreamSettings, defaultScreenStream } from './StreamSettings';
import { DEFAULT_INSIGHT_ORDER, InsightsArea, Mascot, useInsightSpace } from './view/insights';
import { MASCOT_INTERVAL_DEFAULT, MASCOT_INTERVAL_MAX, MASCOT_INTERVAL_MIN, clampMascotInterval, isMascotInterval } from './view/mascot-cadence';
import { TestControls } from './TestControls';
import { useCardSort } from './useCardSort';
import { applyTestPreset, defaultTestConfig, makeTestStatus, type TestSelection, type TestConfig } from './test-mode';
import { I18nContext, useI18n, createI18n, readLanguage, languages, localizeProvider, type Language } from './i18n';
import { buildView } from './view/model';
import { GrantAccessContext, Portrait, RED_ALERT } from './view/parts';
import { Overview, ProviderCard, RailItem, summarize } from './view/skins';
import type { InsightId, Insights, LocalStatus, PanelState, Preferences, Provider, ProviderId, Theme, KimiSource, ClaudeSource, Layout, Skin } from './types';
const providers = baseProviders;
const EMPTY_JOURNAL = emptyJournal();
const screenSurface = new URLSearchParams(location.search).get('surface') === 'screen';
function readScreenTest() {
  try { return JSON.parse(localStorage.getItem('ai-watch:screen-test') || 'null'); } catch { return null; }
}

const previewState: PanelState = {
  side: 'right', locked: false, animate: true, collapsed: false,
  desktop: false, platform: 'browser', scaleFactor: window.devicePixelRatio,
  trayAvailable: false, stored: false,
  widgetsEnabled: false, widgetsAvailable: false, widgetSyncError: false, widgetBackground: false, widgetLastPublishedAt: null,
  providerOrder: readOrder(), enabledProviders: readEnabled(),
  qwenKeychainAllowed: false,
  kimiSource: 'code', claudeSource: 'desktop', claudeNetworkAllowed: false, claudeHooksEnabled: false, layout: 'single', windowLayout: 'single',
  syncRole: 'off', syncPort: 47321,
  animeMode: readAnimeMode(), insights: readInsights(), insightOrder: readInsightOrder(), mascotInterval: readMascotInterval(), skin: readSkin(),
  language: window.panel ? 'zh-CN' : readLanguage(),
  theme: window.panel ? 'system' : readTheme(),
  resolvedTheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
};
function readInsights(): Insights {
  let value: Partial<Insights> | null = null;
  try { value = JSON.parse(localStorage.getItem('ai-watch:insights') || 'null'); } catch { /* defaults */ }
  return Object.fromEntries((['timeline', 'resets', 'trend', 'mascot'] as InsightId[]).map(id => [id, value?.[id] !== false])) as Insights;
}
function readInsightOrder(): InsightId[] {
  try {
    const value = JSON.parse(localStorage.getItem('ai-watch:insight-order') || 'null');
    if (Array.isArray(value) && value.length === DEFAULT_INSIGHT_ORDER.length && new Set(value).size === value.length && value.every(id => DEFAULT_INSIGHT_ORDER.includes(id))) return [...value];
  } catch { /* older or malformed preferences retain the original order */ }
  return [...DEFAULT_INSIGHT_ORDER];
}
function readMascotInterval() {
  try {
    const value = JSON.parse(localStorage.getItem('ai-watch:mascot-interval') || 'null');
    return isMascotInterval(value) ? value : MASCOT_INTERVAL_DEFAULT;
  } catch { return MASCOT_INTERVAL_DEFAULT; }
}
function readAnimeMode() {
  try { return localStorage.getItem('ai-watch:anime-mode') === 'true'; } catch { return false; }
}
function readSkin(): Skin {
  try { const skin = localStorage.getItem('ai-watch:skin'); return skin === 'dial' || skin === 'party' ? skin : 'watch'; }
  catch { return 'watch'; }
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
function TaskDetails({ provider, testing }: { provider: Provider; testing: boolean }) {
  const { t, date, number, percent } = useI18n();
  const rows = provider.local?.taskDetails || [];
  const operations: Record<string, string> = { commandExecution: '执行命令', fileChange: '修改文件', webSearch: '搜索网页', toolCall: '调用工具', agentMessage: '助手回复', reasoning: '思考',
    'turn/start': '开始任务', 'turn/end': '结束任务', 'approval/asked': '等待确认', 'approval/decided': '确认已处理', 'tool/start': '调用工具', 'tool/end': '工具已返回', turn_started: '开始任务', turn_completed: '结束任务' };
  const states = { running: '运行中', waiting: '待处理', completed: '已完成', failed: '失败', cancelled: '已取消', unknown: '未知', idle: '待机' };
  return <div className="task-details" aria-label={t('任务详情')}>
    <div className="task-details-heading"><h3>{t('任务详情')}</h3>{testing && <span className="source-tag">{t('测试数据')}</span>}</div>
    <div className="task-details-list">
      {rows.length ? rows.map((task, index) => <article className="task-entry" key={index} data-state={task.state}>
        <div className="task-entry-heading"><bdi className="task-title" title={task.title || undefined}>{task.title || t('任务名称未提供')}</bdi><span className="task-state">{t(states[task.state])}</span></div>
        <time>{t('最近更新')} · {task.updatedAt ? date(task.updatedAt) : t('未知')}</time>
        {task.stale && <span className="task-history">{t('历史任务记录')}</span>}
        {task.progress !== null && <div className="task-progress"><span>{t('进度')} · <bdi dir="ltr">{percent(task.progress)}</bdi></span><progress max={100} value={task.progress} aria-label={t('进度')} /></div>}
        <p className="task-operation">{task.operation ? t('最近操作') + ' · ' + t(operations[task.operation] || '未知')
          : task.steps !== null ? t('已记录 {p0} 步', { p0: task.steps }) : t('进度或操作摘要未提供')}</p>
        {task.toolCalls !== null && <span className="task-counter">{t('调用工具 {p0} 次', { p0: task.toolCalls })}</span>}
      </article>) : <div className="task-details-empty"><strong>{t('暂无可读任务记录')}</strong><p>{provider.local?.activityDetail || provider.task}</p><small>{t('任务名称、进度和操作摘要取决于客户端提供的记录。')}</small></div>}
    </div>
  </div>;
}
export default function App({ mobile }: { mobile?: { onOpen: (provider?: string) => void; settings: ReactNode; label: string } } = {}) {
  const [state, setState] = useState(() => ({ ...previewState, desktop: Boolean(window.panel) }));
  const [stateLoaded, setStateLoaded] = useState(!window.panel);
  const [statusLoaded, setStatusLoaded] = useState(!window.panel);
  const stream = state.stream || defaultScreenStream;
  const streamController = !screenSurface && stream.enabled;
  const [pageHidden, setPageHidden] = useState(document.hidden);
  useEffect(() => {
    const update = () => setPageHidden(document.hidden);
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  const i18n = createI18n(state.resolvedLanguage || state.language);
  const { t, date, number, percent } = i18n;
  const [languageSaving, setLanguageSaving] = useState(false);
  const [localStatus, setLocalStatus] = useState<LocalStatus | null>(null);
  const [testMode, setTestMode] = useState<boolean>(() => screenSurface && Boolean(readScreenTest()?.enabled));
  const [testConfig, setTestConfig] = useState<TestConfig>(() => screenSurface ? readScreenTest()?.config || defaultTestConfig() : defaultTestConfig());
  const [testSampledAt, setTestSampledAt] = useState(() => screenSurface ? readScreenTest()?.sampledAt || new Date().toISOString() : new Date().toISOString());
  const testStatus = useMemo(() => makeTestStatus(testConfig, testSampledAt), [testConfig, testSampledAt]);
  const displayStatus = testMode ? testStatus : localStatus;
  const [images, setImages] = useState(() => readImages());
  const [animeImages, setAnimeImages] = useState(() => readImages(true));
  const [animeSaving, setAnimeSaving] = useState(false);
  const [skinSaving, setSkinSaving] = useState(false);
  const [launching, setLaunching] = useState<ProviderId | null>(null);
  const [choosingApp, setChoosingApp] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState('');
  const [orderSaving, setOrderSaving] = useState(false);
  const [layoutSaving, setLayoutSaving] = useState(false);
  const [themeSaving, setThemeSaving] = useState(false);
  const [modulesSaving, setModulesSaving] = useState(false);
  const [qwenAccessSaving, setQwenAccessSaving] = useState(false);
  const [kimiSourceSaving, setKimiSourceSaving] = useState(false);
  const [claudeSourceSaving, setClaudeSourceSaving] = useState(false);
  const [claudeNetworkSaving, setClaudeNetworkSaving] = useState(false);
  const [claudeHooksSaving, setClaudeHooksSaving] = useState(false);
  const [cacheClearing, setCacheClearing] = useState(false);
  const [widgetsSaving, setWidgetsSaving] = useState(false);
  const storeLabel = state.platform === 'darwin' ? t("收纳到菜单栏") : t("收纳到托盘");
  const storeHint = state.trayAvailable ? t("{p0}，后台继续监看", { p0: storeLabel }) : state.desktop ? t("系统托盘暂不可用") : t("桌面版支持菜单栏与托盘收纳");
  // A sync client follows the host's Claude / Kimi sources, not its own settings.
  const remoteStatus = !testMode && displayStatus?.remote ? displayStatus : null;
  const kimiSource = remoteStatus ? remoteStatus.kimi?.kimiSource || 'code' : state.kimiSource;
  const claudeSource = remoteStatus ? remoteStatus.claude?.claudeSource || state.claudeSource : state.claudeSource;
  const providers = baseProviders.map(provider => provider.id === 'kimi' && kimiSource === 'work'
    ? { ...provider, name: 'Kimi Work', subtitle: 'MOONSHOT AI · WORK' } : provider.id === 'claude' && claudeSource === 'desktop'
    ? { ...provider, name: 'Claude', subtitle: 'ANTHROPIC' } : provider).map(provider => localizeProvider(provider, i18n));
  const viewport = useRef<HTMLDivElement>(null);
  const enabledOrder = state.providerOrder.filter(id => state.enabledProviders.includes(id));
  const layoutKey = `${state.skin}:${state.layout}:${state.animeMode}:${stateLoaded && statusLoaded}:${streamController}`;
  const visibleCards = useVisibleCards(viewport, enabledOrder, state.collapsed, testMode, layoutKey);
  const main = useRef<HTMLElement>(null);
  const [entrance, setEntrance] = useState(0);
  const stage = useRef<HTMLDivElement>(null);
  const [liveJournal, setLiveJournal] = useState(() => loadJournal());
  const [testJournal, setTestJournal] = useState(() => demoJournal());
  // A sync client shows the host's journal and keeps its own untouched.
  const [remoteJournal, setRemoteJournal] = useState<Journal | null>(null);
  const syncClient = state.syncRole === 'client';
  const screenJournal = useScreenHistory(screenSurface, syncClient ? remoteJournal || EMPTY_JOURNAL : liveJournal,
    syncClient, localStatus?.remote?.host || null);
  const [insightsSaving, setInsightsSaving] = useState(false);
  const [insightOrderSaving, setInsightOrderSaving] = useState(false);
  const [mascotSaving, setMascotSaving] = useState(false);
  // The slider previews locally and saves once it settles; turning auto refresh back on restores the last interval.
  const [mascotDraft, setMascotDraft] = useState<number | null>(null);
  const mascotSave = useRef<ReturnType<typeof setTimeout>>(undefined);
  const lastMascotInterval = useRef(MASCOT_INTERVAL_DEFAULT);
  const [insightSorting, setInsightSorting] = useState(false);
  const resolvedTheme = state.theme === 'system' ? state.resolvedTheme : state.theme;
  const [draft, setDraft] = useState<Preferences>(previewState);
  const modal = useRef<HTMLDialogElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const targetImage = useRef<{ provider: ProviderId; anime: boolean }>({ provider: 'claude', anime: false });
  const visibleProviders = enabledOrder.map(id => providers.find(provider => provider.id === id)!).map((provider) => {
    if (!state.desktop && !testMode) return provider;
    let local = displayStatus?.[provider.id];
    if (provider.id === 'kimi' && state.kimiSource === 'work' && testMode && local) {
      local = { ...local, kimiSource: 'work', activity: 'unknown', activeTasks: 0, task: t("测试数据 · Work 活动未知"),
        quotas: local.quotas.slice(0, 2).map((quota, index) => ({ ...quota, model: t("共享积分"),
          period: index ? t("赠送额度") : t("订阅额度"), resetKind: 'expiry' })) };
    } else if (provider.id === 'kimi' && local && !remoteStatus && (local.kimiSource || 'code') !== state.kimiSource) local = undefined;
    if (provider.id === 'claude' && testMode && local) local = { ...local, claudeSource: state.claudeSource };
    else if (provider.id === 'claude' && local && !remoteStatus && (local.claudeSource || 'code') !== state.claudeSource) local = undefined;
    return { ...provider, running: local?.activity === 'running', task: local?.task || t("正在读取本地状态"),
      quotas: local?.quotas || [], local: local || { id: provider.id, source: 'unavailable' as const,
        connection: 'unavailable' as const, activity: 'unknown' as const, activeTasks: 0,
        task: t("正在读取本地状态"), quotas: [], observedAt: null, sampledAt: null, detail: t("等待首次读取"),
        claudeSource: provider.id === 'claude' ? claudeSource : undefined } };
  });
  const translatedProviders = visibleProviders.map(provider => localizeProvider(provider, i18n));
  const activeTasks = visibleProviders.reduce((total, provider) => total + (displayStatus?.[provider.id]?.activeTasks || 0), 0);
  const refreshTime = displayStatus?.sampledAt ? date(displayStatus.sampledAt, {hour: '2-digit', minute: '2-digit', second: '2-digit'}) : t("读取中");
  const sorting = useCardSort(enabledOrder, order => { void saveVisibleOrder(order); }, screenSurface || streamController || settingsOpen || state.collapsed || orderSaving || modulesSaving || insightSorting);
  const hiddenActive = translatedProviders.filter(provider => !visibleCards.has(provider.id)
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
    } catch { setNotice(t("模块选择保存失败，请重试")); }
    finally { setModulesSaving(false); }
  }
  async function changeLayout(layout: Layout) {
    if (layoutSaving) return;
    setLayoutSaving(true);
    try {
      if (window.panel) setState(await window.panel.setLayout(layout));
      else setState(current => ({ ...current, layout, collapsed: false, windowLayout: layout === 'fullscreen' ? current.windowLayout : layout }));
    } catch { setNotice(t('窗口模式切换失败，请重试')); }
    finally { setLayoutSaving(false); }
  }
  async function changeAnimeMode(value: boolean) {
    if (animeSaving) return;
    setAnimeSaving(true);
    try {
      if (window.panel) setState(await window.panel.setAnimeMode(value));
      else { localStorage.setItem('ai-watch:anime-mode', String(value)); setState(current => ({ ...current, animeMode: value })); }
    } catch { setNotice(t("二次元模式保存失败，请重试")); }
    finally { setAnimeSaving(false); }
  }
  async function changeInsight(id: InsightId, value: boolean) {
    if (insightsSaving) return;
    const next = { ...(state.insights || readInsights()), [id]: value };
    setInsightsSaving(true);
    try {
      if (window.panel) setState(await window.panel.setInsights(next));
      else { localStorage.setItem('ai-watch:insights', JSON.stringify(next)); setState(current => ({ ...current, insights: next })); }
    } catch { setNotice(t('下半屏设置保存失败，请重试')); }
    finally { setInsightsSaving(false); }
  }
  async function changeMascotInterval(seconds: number) {
    const previous = state.mascotInterval ?? readMascotInterval();
    if (seconds === previous) return;
    setMascotSaving(true); setState(current => ({ ...current, mascotInterval: seconds }));
    try {
      if (window.panel) setState(await window.panel.setMascotInterval(seconds));
      else localStorage.setItem('ai-watch:mascot-interval', JSON.stringify(seconds));
    } catch { setState(current => ({ ...current, mascotInterval: previous })); setNotice(t('看板娘刷新设置保存失败，请重试')); }
    finally { setMascotSaving(false); }
  }
  function draftMascotInterval(value: number) {
    const seconds = clampMascotInterval(value);
    setMascotDraft(seconds); clearTimeout(mascotSave.current);
    mascotSave.current = setTimeout(() => { setMascotDraft(null); void changeMascotInterval(seconds); }, 400);
  }
  async function saveInsightOrder(order: InsightId[]) {
    if (insightOrderSaving) return;
    const previous = state.insightOrder || readInsightOrder();
    setInsightOrderSaving(true); setState(current => ({ ...current, insightOrder: order }));
    try {
      if (window.panel) setState(await window.panel.setInsightOrder(order));
      else localStorage.setItem('ai-watch:insight-order', JSON.stringify(order));
      setNotice(t('模块顺序已保存'));
    } catch { setState(current => ({ ...current, insightOrder: previous })); setNotice(t('顺序保存失败，已恢复原顺序')); }
    finally { setInsightOrderSaving(false); }
  }
  async function changeSkin(value: Skin) {
    if (skinSaving || value === state.skin) return;
    setSkinSaving(true);
    try {
      if (window.panel) setState(await window.panel.setSkin(value));
      else { localStorage.setItem('ai-watch:skin', value); setState(current => ({ ...current, skin: value })); }
    } catch { setNotice(t('界面风格保存失败，请重试')); }
    finally { setSkinSaving(false); }
  }
  async function grantClaudeAccess() {
    if (!window.panel || testMode) { setNotice(t('授权辅助功能请使用桌面版')); return; }
    try { setLocalStatus(await window.panel.requestClaudeActivityAccess()); setNotice(t('请在系统设置的“辅助功能”中允许 AI Watch，然后回到面板')); }
    catch { setNotice(t('保存失败，请重试')); }
  }
  async function openProvider(provider: Provider) {
    if (mobile) { mobile.onOpen(provider.id); return; }
    if (screenSurface || streamController) return;
    if (syncClient && !testMode) { setNotice(t('子客户端不能打开主客户端上的应用')); return; }
    if (testMode) { if (state.collapsed) await collapse(false); setNotice(t("测试模式：已模拟打开 {p0}", { p0: provider.name })); return; }
    if (!window.panel) { if (state.collapsed) await collapse(false); setNotice(t("打开应用请使用桌面版")); return; }
    if (launching) return;
    setLaunching(provider.id);
    try {
      const result = await window.panel.openProvider(provider.id);
      if (result.status !== 'opened' && state.collapsed) await collapse(false);
      setNotice(result.status === 'missing' ? t("未找到桌面应用，请在设置中选择启动应用。") : result.status === 'error' ? t("应用打开失败，请在配置中检查启动应用") : result.status === 'unsupported' ? t("请使用桌面版") : result.status === 'test' ? t('测试模式：已模拟打开 {p0}', {p0: provider.name}) : t("打开 {p0}", {p0: provider.name}));
    } catch { setNotice(t("应用打开失败，请在配置中检查启动应用")); if (state.collapsed) await collapse(false); }
    finally { setLaunching(null); }
  }
  async function chooseProviderApp(provider: Provider) {
    if (testMode) { setNotice(t("测试模式：已模拟选择 {p0} 的启动应用", { p0: provider.name })); return; }
    if (!window.panel) { setNotice(t("选择启动应用请使用桌面版")); return; }
    if (choosingApp) return;
    setChoosingApp(true);
    try { const result = await window.panel.chooseProviderApp(provider.id); if (result.status !== 'cancelled') setNotice(result.status === 'error' ? t('保存失败，请重试') : localStatus?.isTestData ? t('测试模式：已模拟选择 {p0} 的启动应用', {p0: provider.name}) : t('配置已保存')); }
    catch { setNotice(t("启动应用保存失败，请重新选择")); }
    finally { setChoosingApp(false); }
  }
  async function changeQwenAccess(allowed: boolean) {
    if (qwenAccessSaving || !window.panel) return;
    setQwenAccessSaving(true);
    try {
      setState(await window.panel.setQwenAccess(allowed));
      setNotice(allowed ? t("已允许读取千问登录；如系统弹出授权，请在系统窗口处理") : t("已关闭千问登录读取，套餐和积分记录已清除"));
    } catch { setNotice(t("千问登录读取设置保存失败，请重试")); }
    finally { setQwenAccessSaving(false); }
  }

  async function saveOrder(order: ProviderId[]) {
    if (screenSurface || streamController) return;
    if (orderSaving) return;
    const previous = state.providerOrder;
    setOrderSaving(true); setState(current => ({ ...current, providerOrder: order }));
    try {
      if (window.panel) setState(await window.panel.setOrder(order));
      else localStorage.setItem('ai-watch:provider-order', JSON.stringify(order));
      setNotice(t("模块顺序已保存"));
    } catch { setState(current => ({ ...current, providerOrder: previous })); setNotice(t("顺序保存失败，已恢复原顺序")); }
    finally { setOrderSaving(false); }
  }
  async function changeKimiSource(source: KimiSource) {
    if (kimiSourceSaving || !window.panel) return;
    setKimiSourceSaving(true);
    try { setState(await window.panel.setKimiSource(source)); setNotice(t("Kimi 来源已保存")); }
    catch { setNotice(t("Kimi 来源保存失败，请重试")); }
    finally { setKimiSourceSaving(false); }
  }
  async function changeClaudeSource(source: ClaudeSource) {
    if (claudeSourceSaving) return;
    setClaudeSourceSaving(true);
    try {
      if (window.panel) setState(await window.panel.setClaudeSource(source));
      else setState(current => ({ ...current, claudeSource: source }));
      setNotice(t('Claude 来源已保存'));
    } catch { setNotice(t('来源切换失败，请重试')); }
    finally { setClaudeSourceSaving(false); }
  }
  async function changeClaudeNetworkAccess(allowed: boolean) {
    if (claudeNetworkSaving || !window.panel) return;
    setClaudeNetworkSaving(true);
    try { setState(await window.panel.setClaudeNetworkAccess(allowed)); setNotice(''); }
    catch { setNotice(t('保存失败，请重试')); }
    finally { setClaudeNetworkSaving(false); }
  }

  async function changeClaudeHooks(enabled: boolean) {
    if (claudeHooksSaving || !window.panel) return;
    setClaudeHooksSaving(true);
    try {
      const next = await window.panel.setClaudeHooks(enabled); setState(next);
      const error = next.claudeHooksStatus?.error;
      setNotice(!error ? '' : error === 'settings-invalid' ? t('Claude Code 设置文件格式有误，未做修改') : error === 'unsupported-platform' ? t('此系统暂不支持状态钩子') : t('无法写入 Claude Code 设置'));
    }
    catch { setNotice(t('保存失败，请重试')); }
    finally { setClaudeHooksSaving(false); }
  }

  async function changeLanguage(language: Language) {
    if (languageSaving) return;
    setLanguageSaving(true);
    try {
      if (window.panel) setState(await window.panel.setLanguage(language));
      else { localStorage.setItem('ai-watch:language', language); setState(current => ({ ...current, language, resolvedLanguage: undefined })); }
      setNotice('');
    } catch { setNotice(t('保存失败，请重试')); }
    finally { setLanguageSaving(false); }
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
    } catch { setNotice(t("外观保存失败，请重试")); }
    finally { setThemeSaving(false); }
  }
  function toggleTestMode(enabled: boolean) {
    setTestMode(enabled); setTestSampledAt(new Date().toISOString());
    setNotice(enabled ? t("测试模式已开启") : state.desktop ? t("已恢复本地监看") : t("已恢复浏览器预览"));
  }
  function changeTestSelection(id: ProviderId, patch: Partial<TestSelection>) {
    setTestConfig(current => ({ ...current, [id]: { ...current[id], ...patch } }));
    setTestSampledAt(new Date().toISOString());
  }

  useEffect(() => {
    const bridge = window.panel;
    if (!bridge) return;
    const acceptStatus = (next: LocalStatus) => setLocalStatus((current) =>
      current?.sampledAt && (!mobile || Boolean(next.sampledAt)) && Boolean(current.remote) === Boolean(next.remote) && current.remote?.host === next.remote?.host
        && (!next.sampledAt || Date.parse(next.sampledAt) < Date.parse(current.sampledAt)) ? current : next);
    bridge.getState().then(setState).catch(() => setNotice(t("无法读取窗口状态"))).finally(() => setStateLoaded(true));
    bridge.getStatus().then(acceptStatus).catch(() => setNotice(t("无法读取本地工具状态"))).finally(() => setStatusLoaded(true));
    const stateListener = bridge.onState(setState);
    const statusListener = bridge.onStatus(acceptStatus);
    const acceptJournal = (value: unknown) => setRemoteJournal(value ? parseJournal(value) : null);
    bridge.getRemoteJournal?.().then(acceptJournal).catch(() => {});
    const journalListener = bridge.onRemoteJournal?.(acceptJournal);
    return () => { stateListener(); statusListener(); journalListener?.(); };
  }, []);
  // The journal keeps only ids, states, times and percentages; test mode has its own sample journal.
  useEffect(() => { if (!screenSurface && localStatus && !localStatus.remote) setLiveJournal(current => record(current, localStatus)); }, [localStatus]);
  useEffect(() => {
    if (screenSurface) return;
    const timer = setTimeout(() => {
      saveJournal(liveJournal);
      if (state.syncRole === 'host') void window.panel?.shareJournal({ events: liveJournal.events, samples: liveJournal.samples, last: liveJournal.last }).catch(() => {});
    }, 2000);
    return () => clearTimeout(timer);
  }, [liveJournal, state.syncRole]);
  useEffect(() => { if (testMode) setTestJournal(demoJournal()); }, [testMode]);
  useEffect(() => { if (testMode) setTestJournal(current => record(current, testStatus)); }, [testMode, testStatus]);
  useLayoutEffect(() => {
    document.documentElement.lang = i18n.language; document.documentElement.dir = i18n.dir;
    document.title = `AI Watch · ${t('AI 工具监看面板')}`;
  }, [i18n.language]);
  useLayoutEffect(() => { document.documentElement.dataset.layout = screenSurface ? 'screen' : state.collapsed ? 'single' : streamController ? 'stream-controller' : state.layout; }, [state.layout, state.collapsed, streamController]);
  useLayoutEffect(() => {
    // Swap palettes in one frame: colour transitions are for state changes, not for a theme flip.
    const root = document.documentElement;
    root.classList.add('theme-switching'); root.dataset.theme = resolvedTheme;
    let second = 0; const first = requestAnimationFrame(() => { second = requestAnimationFrame(() => root.classList.remove('theme-switching')); });
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); root.classList.remove('theme-switching'); };
  }, [resolvedTheme]);
  useLayoutEffect(() => { document.documentElement.dataset.skin = state.skin; }, [state.skin]);
  // Agent cards load in again after a refresh, a skin / layout / mode switch and when the stored panel is reopened.
  useLayoutEffect(() => { if (!screenSurface && !streamController && !state.stored && !state.collapsed) replayEntrance(main.current); }, [entrance, layoutKey, state.stored, state.collapsed]);
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
  useLayoutEffect(() => {
    const dialog = modal.current;
    if (!dialog) return;
    if (dialog.open) dialog.close();
    if (state.collapsed) return;
    if (streamController) dialog.show();
    else if (settingsOpen) dialog.showModal();
  }, [settingsOpen, streamController, state.collapsed, stateLoaded, statusLoaded]);
  useEffect(() => {
    if (streamController) setDraft({ side: state.side, locked: state.locked, animate: state.animate });
  }, [streamController]);
  useEffect(() => {
    const update = (event: StorageEvent) => {
      if (event.key === 'ai-watch:images') setImages(readImages());
      if (event.key === 'ai-watch:anime-images') setAnimeImages(readImages(true));
      if (screenSurface && event.key === 'ai-watch:screen-test') {
        const value = readScreenTest(); setTestMode(Boolean(value?.enabled));
        setTestConfig(value?.config || defaultTestConfig());
        setTestSampledAt(value?.sampledAt || new Date().toISOString());
      }
    };
    window.addEventListener('storage', update);
    return () => window.removeEventListener('storage', update);
  }, []);
  useEffect(() => {
    if (screenSurface) return;
    try { localStorage.setItem('ai-watch:screen-test', JSON.stringify({ enabled: testMode, config: testConfig, sampledAt: testSampledAt })); } catch { /* preview still works locally */ }
  }, [testMode, testConfig, testSampledAt]);
  useEffect(() => {
    if (screenSurface || streamController) return;
    const keydown = (event: KeyboardEvent) => {
      if (!event.defaultPrevented && event.key === 'Escape' && state.layout === 'fullscreen' && !settingsOpen && !sorting.sorting && !insightSorting) { event.preventDefault(); void changeLayout(state.windowLayout); }
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'b' && !state.desktop) {
        event.preventDefault(); setState((old) => ({ ...old, collapsed: !old.collapsed }));
      }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [state.desktop, state.layout, settingsOpen, sorting.sorting, insightSorting, streamController]);

  async function toggleLock() {
    try {
      if (window.panel) setState(await window.panel.setLocked(!state.locked));
      else { setState({ ...state, locked: !state.locked }); setNotice(t("浏览器预览：锁定效果请在桌面版查看")); }
    } catch { setNotice(t("窗口锁定失败，请重试")); }
  }
  async function collapse(value: boolean) {
    try {
      if (window.panel) setState(await window.panel.setCollapsed(value));
      else setState({ ...state, collapsed: value });
    } catch { setNotice(t("窗口收起失败，请重试")); }
  }
  async function storePanel() {
    try { if (window.panel) setState(await window.panel.store()); }
    catch { setNotice(t("收纳失败，面板保持打开，请重试")); }
  }
  async function refresh() {
    if (screenSurface || streamController || refreshing) return;
    setRefreshing(true);
    try {
      if (testMode) {
        await new Promise(resolve => setTimeout(resolve, 450));
        setTestSampledAt(new Date().toISOString()); setNotice(t("测试画面已刷新"));
        setEntrance(value => value + 1);
      } else if (window.panel) {
        setLocalStatus(await window.panel.refreshStatus());
        setNotice(t("本地状态已重新读取"));
        setEntrance(value => value + 1);
      } else setNotice(t("浏览器预览使用演示数据；本地接入请打开桌面版"));
    } catch { setNotice(t("本地状态读取失败，稍后自动重试")); }
    finally {
      setRefreshing(false);
    }
  }
  async function saveSettings() {
    try {
      if (window.panel) setState(await window.panel.configure(draft));
      else setState({ ...state, ...draft });
      setSettingsOpen(false); setNotice(t("配置已保存"));
    } catch { setNotice(t("保存失败，请重试")); }
  }
  function storeImage(provider: ProviderId, value: string, anime: boolean) {
    const next = { ...(anime ? animeImages : images), [provider]: value };
    try { localStorage.setItem(anime ? 'ai-watch:anime-images' : 'ai-watch:images', JSON.stringify(next)); (anime ? setAnimeImages : setImages)(next); }
    catch { setNotice(t("图片存储空间不足，请使用更小的图片")); }
  }
  async function chooseImage(provider: ProviderId, anime = false) {
    try {
      if (window.panel) {
        const value = await window.panel.chooseImage(provider);
        if (value) storeImage(provider, value, anime);
      } else { targetImage.current = { provider, anime }; fileInput.current?.click(); }
    } catch { setNotice(t("无法读取图片，请选择 8 MB 以内的 PNG、JPG 或 WebP")); }
  }
  async function readFile(file?: File) {
    if (!file) return;
    const target = targetImage.current;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 8 * 1024 * 1024) {
      setNotice(t("请选择 8 MB 以内的 PNG、JPG 或 WebP")); return;
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
    } catch { setNotice(t("无法读取这张图片")); }
  }

  const views = translatedProviders.map(provider => buildView(provider, i18n, Boolean(displayStatus?.isTestData)));
  const summary = summarize(views);
  const skin = state.skin;
  const imageFor = (id: ProviderId) => (state.animeMode ? animeImages : images)[id];
  const insights = state.insights || readInsights();
  const mascotInterval = mascotDraft ?? state.mascotInterval ?? readMascotInterval();
  if (mascotInterval > 0) lastMascotInterval.current = mascotInterval;
  const mascotSeconds = mascotInterval || lastMascotInterval.current;
  const insightSpace = useInsightSpace(stage, viewport, `${layoutKey}:${state.collapsed}:${views.map(view => view.id).join(',')}:${Object.values(insights).join(',')}`, sorting.sorting);
  const stamp = state.desktop || testMode ? refreshTime : '';
  const badge = testMode ? <button className="demo-tag test-badge" aria-label={t('测试模式设置')} onClick={openSettings}>{t('测试模式')}</button>
    : syncClient ? <span className="demo-tag sync-tag" data-sync-state={state.lanSync?.state} title={syncStatusText(state, t)}>{state.lanSync?.state === 'connected' ? t('同步') : t('未同步')}</span>
    : <span className="demo-tag">{localStatus?.isTestData ? t('测试') : state.desktop ? t('本地') : t('演示')}</span>;
  const lockButton = (className = '') => <button className={`${className} ${state.locked && state.layout !== 'fullscreen' ? 'selected' : ''}`} disabled={Boolean(mobile) || state.layout === 'fullscreen'} aria-label={t('锁定窗口')} aria-pressed={state.locked && state.layout !== 'fullscreen'}
    title={state.locked ? t('解除跨桌面锁定') : t('锁定：置顶并显示在所有桌面')} onClick={toggleLock}>{state.locked ? <LockKeyhole /> : <UnlockKeyhole />}</button>;
  const skinOptions: { id: Skin; name: string; hint: string }[] = [
    { id: 'watch', name: t('值守台'), hint: t('先提醒要你处理的，再列出全部') },
    { id: 'dial', name: t('表盘'), hint: t('每个助手一圈额度，安静好读') },
    { id: 'party', name: t('角色栏'), hint: t('像游戏队伍面板，角色当主角') },
  ];
  const section = (id: string) => modal.current?.querySelector<HTMLElement>(`[data-section="${id}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });

  if (!stateLoaded || !statusLoaded) return <I18nContext.Provider value={i18n}><div className="screen-loading" role="status">{t('读取中')}</div></I18nContext.Provider>;
  if (screenSurface) return <I18nContext.Provider value={i18n}><GrantAccessContext.Provider value={null}>
    <ScreenSurface remote={Boolean(displayStatus?.remote)} sampledAt={displayStatus?.sampledAt} providers={translatedProviders} views={views} stream={stream} skin={skin} anime={state.animeMode} animate={state.animate}
      testing={Boolean(testMode || displayStatus?.isTestData)} demo={!state.desktop} renderCard={(view, index, visible) =>
        <ProviderCard key={view.id} view={view} skin={skin} index={index} anime={state.animeMode} image={imageFor(view.id)} readOnly cycleSeconds={Math.max(3, stream.pageSeconds / 2)} animationPaused={!visible} dragging={false} fullscreen={false} sortProps={{ style: { display: visible ? undefined : 'none' } }} onOpen={() => {}} busy={false} />}
      imageForAttention={provider => animeImages[provider.id]}
      renderMascot={<Mascot views={views} anime image={view => animeImages[view.id]} interval={mascotInterval} paused={false} readOnly />}
      renderTrend={<ScreenQuotaTrend views={views} journal={testMode || !state.desktop ? testJournal : screenJournal}
        testing={Boolean(testMode || displayStatus?.isTestData)} demo={!state.desktop} pageSeconds={stream.pageSeconds} />} />
  </GrantAccessContext.Provider></I18nContext.Provider>;

  return <I18nContext.Provider value={i18n}><GrantAccessContext.Provider value={state.desktop && !syncClient ? () => void grantClaudeAccess() : null}><main ref={main} data-mobile={Boolean(mobile)} data-surface={streamController ? 'controller' : 'desktop'} lang={i18n.language} dir={i18n.dir} data-language={i18n.language} data-layout={state.layout} data-skin={skin} data-sampled-at={displayStatus?.sampledAt || ''} data-test-mode={testMode} className={`panel ${streamController && !state.collapsed ? 'stream-controller' : ''} skin-${skin} layout-${state.layout} ${state.animeMode ? 'anime-mode' : ''} ${state.collapsed ? 'collapsed' : ''} ${settingsOpen ? 'settings-open' : ''} ${pageHidden || state.stored ? 'animations-paused' : ''} ${!state.animate ? 'no-animation' : ''}`}>
    {(!streamController || state.collapsed) && (state.collapsed ? <aside className="collapsed-rail" aria-label={t('收起的监看面板')}>
      <button className="rail-expand" title={t('展开面板')} aria-label={t('展开面板')} onClick={() => collapse(false)}>{state.side === 'right' ? <ArrowLeftToLine size={18} /> : <ArrowRightToLine size={18} />}</button>
      <div className="rail-counts" title={t('运行中 {p0} · 等你处理 {p1}', { p0: summary.running, p1: summary.waiting.length })}>
        <span data-kind="running"><strong>{number(summary.running)}</strong>{t('运行')}</span>
        <span data-kind="waiting" data-active={summary.waiting.length > 0}><strong>{number(summary.waiting.length)}</strong>{t('待处理')}</span>
      </div>
      <div className="rail-providers">{views.map(view => <RailItem key={view.id} view={view} skin={skin} anime={state.animeMode} image={imageFor(view.id)} busy={launching === view.id} onOpen={() => void openProvider(view.provider)} />)}</div>
      <div className="rail-tools">
        <button className="rail-store" aria-label={storeLabel} title={storeHint} disabled={!state.trayAvailable} onClick={storePanel}><PanelTopClose size={16} /></button>
        {lockButton('rail-lock')}
        {testMode ? <button className="rail-demo test-badge" aria-label={t('测试模式设置')} onClick={async () => { await collapse(false); openSettings(); }}>{t('测试')}</button> : <span className="rail-demo" title={syncClient ? syncStatusText(state, t) : undefined}>{syncClient ? state.lanSync?.state === 'connected' ? t('同步') : t('未同步') : state.desktop ? t('本地') : t('演示')}</span>}
      </div>
    </aside> : <div className={`panel-regions ${sorting.sorting ? 'is-sorting' : ''}`}>
      <header className="control-region">
        <div className="brand"><Activity size={17} strokeWidth={2} aria-hidden="true" /><h1 dir="ltr">AI WATCH</h1></div>
        <nav className="toolbar" aria-label={t('面板控制')}>
          <button aria-label={t('刷新面板')} title={testMode ? t('刷新测试画面') : t('重新读取本地额度与任务状态')} disabled={refreshing} onClick={refresh}><RefreshCw className={refreshing ? 'spinning' : ''} /></button>
          {mobile ? <button aria-label={mobile.label} title={mobile.label} onClick={() => mobile.onOpen()}><Bell /></button> : lockButton()}
          <button aria-label={storeLabel} title={storeHint} disabled={!state.trayAvailable} onClick={storePanel}><PanelTopClose /></button>
          {state.layout === 'fullscreen' && <button aria-label={t('退出全屏')} title={t('退出全屏')} disabled={layoutSaving} onClick={() => void changeLayout(state.windowLayout)}><Minimize /></button>}
          {state.layout !== 'fullscreen' && <button className="primary" aria-label={t('收起面板')} title={t('收起为状态窄条')} onClick={() => collapse(true)}>{state.side === 'right' ? <ArrowRightToLine /> : <ArrowLeftToLine />}</button>}
          <button aria-label={t('打开配置')} title={t('配置面板')} onClick={openSettings}><Settings2 /></button>
        </nav>
      </header>
      <Overview skin={skin} summary={summary} live={state.desktop || testMode} stamp={stamp} badge={badge} anime={state.animeMode}
        image={view => imageFor(view.id)} onOpen={view => void openProvider(view.provider)} onReveal={view => revealProvider(view.id)} />
      <div ref={stage} className="provider-stage">
      <div ref={viewport} className="provider-viewport" aria-label={t('工具模块列表')} aria-busy={orderSaving || modulesSaving} tabIndex={0}>
        {!visibleProviders.length && <div className="empty-providers"><p>{t('尚未启用模块')}</p><button onClick={openSettings}>{t('选择监看模块')}</button></div>}
        {views.map((view, index) => <ProviderCard key={`${testMode ? 'test' : 'live'}:${view.id}`} view={view} skin={skin} index={index} anime={state.animeMode} image={imageFor(view.id)}
          busy={launching === view.id} onOpen={() => void openProvider(view.provider)} fullscreen={state.layout === 'fullscreen'}
          details={state.layout === 'fullscreen' ? <TaskDetails provider={view.provider} testing={Boolean(displayStatus?.isTestData)} /> : undefined}
          animationPaused={settingsOpen || !visibleCards.has(view.id)} dragging={sorting.activeId === view.id}
          sortProps={{ style: sorting.style(view.id), onPointerDown: event => sorting.start(event, view.id), onKeyDown: event => {
            if (event.target !== event.currentTarget || !event.altKey || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key) || sorting.sorting) return;
            event.preventDefault();
            const cards = [...viewport.current!.querySelectorAll<HTMLElement>(':scope > .provider-card')];
            const columns = cards.filter(card => Math.abs(card.getBoundingClientRect().top - cards[0].getBoundingClientRect().top) < 2).length;
            const delta = event.key === 'ArrowUp' ? -columns : event.key === 'ArrowDown' ? columns : (event.key === 'ArrowLeft' ? -1 : 1) * (i18n.dir === 'rtl' ? -1 : 1);
            const next = [...enabledOrder], target = Math.max(0, Math.min(enabledOrder.length - 1, index + delta));
            if (target !== index) { next.splice(index, 1); next.splice(target, 0, view.id); void saveVisibleOrder(next); }
          } }} />)}
      </div>
      {!sorting.sorting && <InsightsArea insights={insights} height={insightSpace.height} width={insightSpace.width} layout={state.layout} views={views}
        order={state.insightOrder || readInsightOrder()} onOrder={order => void saveInsightOrder(order)} onSortingChange={setInsightSorting}
        sortingDisabled={settingsOpen || state.collapsed || insightOrderSaving || insightsSaving || layoutSaving || animeSaving}
        journal={testMode ? testJournal : syncClient ? remoteJournal || EMPTY_JOURNAL : liveJournal} anime={state.animeMode} image={view => imageFor(view.id)} onOpen={view => void openProvider(view.provider)}
        interval={mascotInterval} paused={settingsOpen || pageHidden || state.stored || state.collapsed} />}
      </div>
    </div>)}
    {!streamController && !state.collapsed && !settingsOpen && !sorting.sorting && hiddenActive.length > 0 && <div className="hidden-activity" aria-label={t('屏幕外模块活动')}>
      {hiddenActive.map(provider => <button key={provider.id} className="hidden-activity-light" data-provider={provider.id} style={{ '--accent': provider.color } as CSSProperties}
        data-glow={provider.local?.activity === 'waiting' && RED_ALERT.has(provider.id) ? 'attention' : 'running'}
        aria-label={t('{p0} {p1}，点击查看', { p0: provider.name, p1: provider.local?.activity === 'waiting' ? '等待处理' : '正在运行' })}
        title={t('{p0} · {p1} · 点击查看', { p0: provider.name, p1: provider.local?.activity === 'waiting' ? '等待处理' : '正在运行' })}
        onClick={() => revealProvider(provider.id)}><span className="sr-only">{provider.name}</span></button>)}
    </div>}
    <span id="card-sort-help" className="sr-only">{t('长按卡片拖动排序；Escape 取消。Alt 加方向键按行列排序。')}</span>
    {sorting.sorting && <div className="sort-hint" role="status" title={t('排序说明')}>{t('排序')} · {t('第 {p0} 位', { p0: (sorting.target ?? 0) + 1 })}</div>}
    <dialog ref={modal} className="settings-dialog" aria-labelledby="settings-title" onCancel={event => { if (streamController) event.preventDefault(); else setSettingsOpen(false); }}>
      <div className="settings-heading"><h2 id="settings-title">{t('面板配置')}</h2>{streamController ? <div className="stream-window-actions">
        <button className="icon-button" aria-label={t('收起面板')} title={t('收起为状态窄条')} onClick={() => void collapse(true)}>{state.side === 'right' ? <ArrowRightToLine size={18} /> : <ArrowLeftToLine size={18} />}</button>
        <button className="icon-button" aria-label={t('最小化')} title={t('最小化')} onClick={() => void window.panel?.minimize().then(setState)}><Minimize size={18} /></button>
        <button className="icon-button" aria-label={storeLabel} title={storeHint} disabled={!state.trayAvailable} onClick={storePanel}><PanelTopClose size={18} /></button>
      </div> : <button className="icon-button" aria-label={t('关闭配置')} onClick={() => setSettingsOpen(false)}><X size={18} /></button>}</div>
      <nav className="settings-nav" aria-label={t('配置分区')}>
        {[['stream', i18n.language.startsWith('zh') ? '小屏幕串流' : 'Display streaming'], ['look', t('外观')], ['modules', t('模块')], ['data', t('数据来源')], ['window', t('窗口')], ['images', t('图片与应用')], ['sync', t('多端同步')], ['cloud', t('云端同步状态')], ['about', t('关于')], ...(mobile ? [['mobile', mobile.label]] : [])].filter(([id]) => !mobile || !['stream', 'data', 'images', 'sync', 'cloud'].includes(id)).map(([id, label]) =>
          <button key={id} type="button" onClick={() => section(id)}>{label}</button>)}
      </nav>
      <div className="settings-content">
        {mobile?.settings}
        <section className="settings-group" data-section="stream"><StreamSettings state={state} onState={setState} /></section>
        <section className="settings-group" data-section="look"><h3>{t('外观')}</h3>
          <fieldset className="skin-settings"><legend>{t('界面风格')}</legend>
            <div className="skin-options">{skinOptions.map(option => <button key={option.id} type="button" className={`skin-option ${skin === option.id ? 'selected' : ''}`} data-skin-option={option.id}
              aria-pressed={skin === option.id} disabled={skinSaving} onClick={() => void changeSkin(option.id)}>
              <span className="skin-preview" aria-hidden="true"><i /><i /><i /></span><strong>{option.name}</strong><small>{option.hint}</small></button>)}</div>
          </fieldset>
          <label className="switch-row"><span>{t('二次元模式')}<small>{t('三种风格都用角色图片替换 LOGO')}</small></span><input aria-label={t('二次元模式')} type="checkbox" checked={state.animeMode} disabled={animeSaving} onChange={event => void changeAnimeMode(event.target.checked)} /></label>
          <label className="switch-row"><span>{t('跟随系统')}<small>{t('自动切换浅色和深色外观')}</small></span><input aria-label={t('跟随系统')} type="checkbox" checked={state.theme === 'system'} disabled={themeSaving} onChange={event => void changeTheme(event.target.checked ? 'system' : resolvedTheme)} /></label>
          <label className="switch-row"><span>{t('暗夜模式')}<small>{state.theme === 'system' ? t('手动切换后停止跟随系统') : t('已手动指定外观')}</small></span><input aria-label={t('暗夜模式')} type="checkbox" checked={resolvedTheme === 'dark'} disabled={themeSaving} onChange={event => void changeTheme(event.target.checked ? 'dark' : 'light')} /></label>
          <fieldset className="layout-settings"><legend>{t('窗口模式')}</legend>
            <select aria-label={t('窗口模式')} value={state.layout} disabled={layoutSaving || streamController} onChange={event => void changeLayout(event.target.value as Layout)}>
              <option value="single">{t('单列模式')}</option><option value="double">{t('双排模式')}</option><option value="fullscreen">{t('全屏模式')}</option>
            </select><p className="appearance-hint">{t('双排宽度加倍；全屏显示任务详情。Escape 退出全屏。')}</p>
          </fieldset>
          <fieldset className="insight-settings"><legend>{t('下半屏')}</legend>
            {([['timeline', t('动态时间线'), t('各助手开始、等待和完成的记录')], ['resets', t('额度重置日程'), t('按时间排列下一次额度恢复')],
              ['trend', t('额度趋势'), t('近 24 小时最紧额度的变化')], ['mascot', t('看板娘'), t('仅二次元模式显示，随状态换表情')]] as [InsightId, string, string][]).map(([id, label, hint]) =>
              <label key={id} className="switch-row"><span>{label}<small>{hint}</small></span><input aria-label={label} type="checkbox" checked={insights[id]} disabled={insightsSaving} onChange={event => void changeInsight(id, event.target.checked)} /></label>)}
            <label className="switch-row"><span>{t('看板娘自动刷新')}<small>{t('按间隔换一位助手说话；有助手在工作时，每 3 句后播报一次工作状态')}</small></span><input aria-label={t('看板娘自动刷新')} type="checkbox" checked={mascotInterval > 0} disabled={mascotSaving}
              onChange={event => { clearTimeout(mascotSave.current); setMascotDraft(null); void changeMascotInterval(event.target.checked ? lastMascotInterval.current : 0); }} /></label>
            <label className="interval-row" data-disabled={mascotInterval === 0 || undefined}><span>{t('刷新间隔')}</span>
              <input type="range" aria-label={t('刷新间隔')} min={MASCOT_INTERVAL_MIN} max={MASCOT_INTERVAL_MAX} step={1} value={mascotSeconds} disabled={mascotInterval === 0}
                aria-valuetext={t('{p0} 秒', { p0: number(mascotSeconds) })} onChange={event => draftMascotInterval(Number(event.target.value))} />
              <output>{t('{p0} 秒', { p0: number(mascotSeconds) })}</output></label>
            <p className="appearance-hint">{t('可上下滚动查看所有已开启的下半屏组件。记录只保存在本机，不含任务内容。')}</p>
          </fieldset>
          <fieldset className="language-settings"><legend>{t('语言')}</legend>
            <select aria-label={t('语言')} value={state.language} disabled={languageSaving} onChange={event => void changeLanguage(event.target.value as Language)}>
              <option value="system">{t('跟随系统')}</option>
              {languages.map(language => <option key={language.id} value={language.id} lang={language.id} dir={language.dir}>{language.name}</option>)}
            </select><p className="appearance-hint">{t('语言说明')}</p>
          </fieldset>
        </section>
        <section className="settings-group" data-section="modules"><h3>{t('模块')}</h3>
          <fieldset className="module-settings"><legend>{t('监看模块 · 已启用')} <bdi dir="ltr">{number(state.enabledProviders.length)} / {number(providers.length)}</bdi></legend>
            <div className="module-options">{state.providerOrder.map(id => {
              const provider = providers.find(item => item.id === id)!;
              return <label key={id} className="module-option" style={{ '--accent': provider.color } as CSSProperties}><input type="checkbox" aria-label={t('启用 {p0}', { p0: provider.name })} checked={state.enabledProviders.includes(id)} disabled={modulesSaving} onChange={event => void changeEnabled(id, event.target.checked)} /><span>{provider.name}</span></label>;
            })}</div>
            <p className="appearance-hint">{t('取消勾选的模块不显示、不提醒；顺序仍保留。长按卡片可拖动排序。')}</p>
          </fieldset>
          <TestControls enabled={testMode} config={testConfig} onToggle={toggleTestMode} onChange={changeTestSelection}
            onPreset={preset => { setTestConfig(current => applyTestPreset(current, preset)); setTestSampledAt(new Date().toISOString()); }}
            onView={() => setSettingsOpen(false)} />
        </section>
        <section className="settings-group" data-section="data"><h3>{t('数据来源')}</h3>
          <fieldset><legend>{t('Claude 数据来源')}</legend>
            <div className="segmented" aria-label={t('Claude 数据来源')}>{(['desktop', 'code'] as const).map(source => <button key={source} className={state.claudeSource === source ? 'selected' : ''} aria-pressed={state.claudeSource === source} disabled={claudeSourceSaving} onClick={() => void changeClaudeSource(source)}>{source === 'desktop' ? 'Claude Desktop' : 'Claude Code'}</button>)}</div>
            <p className="appearance-hint">{t('桌面版与 Code 分开读取，切换后清除上个来源的套餐和状态。')}</p>
            <label className="switch-row"><span>{t('联网查询 Claude 额度')}<small>{t('复用所选客户端的本地登录')}</small></span><input aria-label={t('联网查询 Claude 额度')} type="checkbox" checked={state.claudeNetworkAllowed} disabled={!state.desktop || claudeNetworkSaving} onChange={event => void changeClaudeNetworkAccess(event.target.checked)} /></label>
            <p className="appearance-hint">{t('仅向 Claude 官方服务查询套餐与额度；macOS 可能请求钥匙串授权。凭据不保存到面板，关闭后停止查询。')}</p>
            <label className="switch-row"><span>{t('Claude Code 状态钩子')}<small>{t('即时识别运行、授权和提问，无需辅助功能')}</small></span><input aria-label={t('Claude Code 状态钩子')} type="checkbox" checked={state.claudeHooksEnabled} disabled={!state.desktop || claudeHooksSaving || state.claudeHooksStatus?.supported === false} onChange={event => void changeClaudeHooks(event.target.checked)} /></label>
            <p className="appearance-hint">{t('开启后在 Claude Code 用户设置中登记一个只写本地文件的钩子，终端与桌面版 Code 会话都会上报；只记录事件类型和会话编号，不记录对话内容。关闭即移除，不影响你自己的钩子。')}</p>
            {state.claudeSource === 'desktop' && <><button className="dock-button" disabled={!state.desktop || claudeSourceSaving} onClick={async () => {
              if (!window.panel) return; setClaudeSourceSaving(true);
              try { setLocalStatus(await window.panel.requestClaudeActivityAccess()); }
              catch { setNotice(t('来源切换失败，请重试')); }
              finally { setClaudeSourceSaving(false); }
            }}>{t('识别桌面活动（辅助功能）')}</button><p className="appearance-hint">{t('仅识别发送和停止按钮；需要系统辅助功能授权，不读取聊天正文。')}</p></>}
          </fieldset>
          <fieldset><legend>{t('Kimi 数据来源')}</legend>
            <div className="segmented" aria-label={t('Kimi 数据来源')}>{(['code', 'work'] as const).map(source => <button key={source} className={state.kimiSource === source ? 'selected' : ''} aria-pressed={state.kimiSource === source} aria-label={t('选择 Kimi {p0} 来源', { p0: source === 'work' ? 'Work' : 'Code' })} disabled={!state.desktop || kimiSourceSaving} onClick={() => void changeKimiSource(source)}>Kimi {source === 'work' ? 'Work' : 'Code'}</button>)}</div>
            <p className="appearance-hint">{t('Work 读取正在运行的桌面客户端账号及会员共享积分，活动状态暂为未知。Code 读取独立 CLI 的额度与本机服务。来源失败时保留所选客户端。')}</p>
          </fieldset>
          <fieldset><legend>{t('千问登录读取')}</legend>
            <label className="switch-row"><span>{t('读取千问登录状态')}<small>{t('仅查询套餐和积分')}</small></span><input aria-label={t('读取千问登录状态')} type="checkbox" checked={state.qwenKeychainAllowed} disabled={!state.desktop || qwenAccessSaving} onChange={event => void changeQwenAccess(event.target.checked)} /></label>
            <p className="appearance-hint">{t('仅访问千问专属的系统钥匙串记录，可能需要系统授权。登录信息不保存到面板；关闭会清除已读取的套餐和积分。拒绝授权后不会自动反复弹窗，可处理授权后手动刷新。')}</p>
          </fieldset>
          {state.platform === 'darwin' && <fieldset><legend>{t('桌面小组件')}</legend>
            <p className="appearance-hint">{t('在桌面右键选择“编辑小组件”，搜索 AI Watch，添加总览或单个工具。')}</p>
            <p className="appearance-hint">{t('总览跟随“监看模块”的选择和排序。')}</p>
            <label className="switch-row"><span>{t('同步小组件')}<small>{t('仅共享额度摘要与状态')}</small></span><input type="checkbox" aria-label={t('同步小组件')} checked={state.widgetsEnabled} disabled={!state.widgetsAvailable || widgetsSaving} onChange={async event => {
              const enabled = event.target.checked;
              setWidgetsSaving(true);
              try { if (window.panel) setState(await window.panel.setWidgetsEnabled(enabled)); }
              catch { setNotice(t('小组件同步失败，请重试')); }
              finally { setWidgetsSaving(false); }
            }} /></label>
            {!state.widgetsAvailable && <p className="appearance-hint">{t('此构建未启用已签名的原生小组件；请使用包含小组件扩展的签名版本。')}</p>}
            {state.widgetSyncError && <p className="appearance-hint" role="status">{t('小组件同步失败，请重试')}</p>}
            <p className="appearance-hint">{t('macOS 决定刷新时间；小组件显示采样时间，过期记录标为历史。')}</p>
            <button className="dock-button" disabled={!state.widgetsEnabled || !state.widgetsAvailable || widgetsSaving} onClick={async () => {
              setWidgetsSaving(true);
              try { if (window.panel) setState(await window.panel.widgetBackground()); }
              catch { setNotice(t('小组件同步失败，请重试')); }
              finally { setWidgetsSaving(false); }
            }}>{t('仅保留桌面小组件')}</button>
            <p className="appearance-hint">{t('隐藏面板、Dock 和菜单栏图标，后台继续监看。点击小组件或再次打开 AI Watch 恢复。')}</p>
          </fieldset>}
        </section>
        <section className="settings-group" data-section="window"><h3>{t('窗口')}</h3>
          <fieldset><legend>{t('默认停靠位置')}</legend><div className="segmented"><button className={draft.side === 'left' ? 'selected' : ''} onClick={() => setDraft({ ...draft, side: 'left' })}>{t('左侧')}</button><button className={draft.side === 'right' ? 'selected' : ''} onClick={() => setDraft({ ...draft, side: 'right' })}>{t('右侧')}</button></div></fieldset>
          <label className="switch-row"><span>{t('跨桌面锁定')}<small>{t('置顶并跟随桌面切换')}</small></span><input type="checkbox" checked={draft.locked} onChange={(event) => setDraft({ ...draft, locked: event.target.checked })} /></label>
          <label className="switch-row"><span>{t('状态灯动画')}<small>{t('运行中的状态灯缓慢呼吸')}</small></span><input type="checkbox" checked={draft.animate} onChange={(event) => setDraft({ ...draft, animate: event.target.checked })} /></label>
          <button className="dock-button" onClick={async () => {
            try { if (window.panel) setState(await window.panel.dock()); setNotice(t('已重新贴边')); }
            catch { setNotice(t('重新贴边失败')); }
          }}><MapPin size={14} />{t('重新贴到屏幕边缘')}</button>
          <fieldset><legend>{t('缓存维护')}</legend><button className="dock-button" disabled={!state.desktop || cacheClearing} onClick={async () => {
            if (!window.panel) return; setCacheClearing(true);
            try { const result = await window.panel.clearCache(); setNotice(t('已清理缓存 · {p0} MB', { p0: number(result.freedBytes / 1024 / 1024, { maximumFractionDigits: 1 }) })); }
            catch { setNotice(t('缓存清理失败，请重试')); }
            finally { setCacheClearing(false); }
          }}>{t('清理缓存')}</button><p className="appearance-hint">{t('清理渲染和网络缓存，设置与图片会保留；剩余磁盘缓存下次启动清理。')}</p></fieldset>
        </section>
        <section className="settings-group" data-section="images"><h3>{t('图片与应用')}</h3>
          <div className="settings-section"><h4>{t('助手图片')}</h4><p>{t('透明图片效果更好')}</p>{providers.map((provider) => <div className="image-option" key={provider.id} style={{ '--accent': provider.color } as CSSProperties}>
            <Portrait provider={provider} image={images[provider.id]} anime={false} /><span>{provider.name}</span><button onClick={() => chooseImage(provider.id)} aria-label={t('替换 {p0} 图片', { p0: provider.name })}>{t('替换')}</button>
          </div>)}</div>
          <div className="settings-section"><h4>{t('二次元图片')}</h4><p>{t('独立保存；推荐正方形透明背景，小头像会自动对准脸部')}</p>{providers.map(provider => <div className="image-option" key={provider.id} style={{ '--accent': provider.color } as CSSProperties}>
            <Portrait provider={provider} image={animeImages[provider.id]} anime /><span>{provider.name}</span><button onClick={() => chooseImage(provider.id, true)} aria-label={t('替换 {p0} 二次元图片', { p0: provider.name })}>{t('替换')}</button>
          </div>)}</div>
          <div className="settings-section"><h4>{t('启动应用')}</h4><p>{t('点击卡片或收起栏图标打开应用；未找到时可手动选择安装位置。')}</p>{providers.map(provider => <div className="app-option" key={provider.id}>
            <span>{provider.name}</span><button disabled={choosingApp} onClick={() => void chooseProviderApp(provider)} aria-label={t('选择 {p0} 启动应用', { p0: provider.name })}>{t('选择应用')}</button>
          </div>)}</div>
        </section>
        <SyncSettings state={state} onState={setState} notify={setNotice} />
        <CloudSettings state={state} onState={setState} notify={setNotice} />
        <section className="settings-group settings-note" data-section="about"><h3>{t('关于')}</h3><span className="note-title">{`AI Watch · v${packageInfo.version}`}</span>
          <p><a className="about-link" href={packageInfo.homepage} target="_blank" rel="noreferrer" onClick={event => { if (window.panel) { event.preventDefault(); void window.panel.openRepository(); } }}><bdi>{packageInfo.homepage}</bdi></a></p>
          <p>{t('作者：{p0}', { p0: 'Claude大小姐 · GPT龙娘' })}</p></section>
      </div>
      <div className="settings-footer"><button className="save-button" onClick={saveSettings}><Check size={15} />{t('保存配置')}</button>{state.desktop && <button className="quit-button" onClick={() => window.panel?.quit()}>{t('退出面板')}</button>}</div>
      {notice && settingsOpen && <div className="toast" role="status">{notice}</div>}
    </dialog>
    <input ref={fileInput} className="hidden-input" type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => { void readFile(event.target.files?.[0]); event.target.value = ''; }} />
    {notice && !settingsOpen && <div className="toast" role="status">{notice}</div>}
  </main></GrantAccessContext.Provider></I18nContext.Provider>;
}
