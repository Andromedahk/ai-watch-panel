import Big from 'big.js';
import type { I18n } from '../../electron/i18n.cjs';
import type { CreditItem, Provider, ProviderId, Quota, Wallet } from '../types';

export type StateKind = 'running' | 'waiting' | 'idle' | 'unknown' | 'offline';
export type QuotaRow = { key: string; label: string; period: string; remaining: number | null; known: boolean; historical: boolean; stale: boolean; low: boolean; title: string; status: string };
export type Metrics =
  | { kind: 'quota'; rows: QuotaRow[] }
  | { kind: 'balance'; wallets: Wallet[]; stale: boolean; empty: string; detail: string }
  | { kind: 'credits'; items: CreditItem[]; stale: boolean; empty: string; detail: string }
  | { kind: 'empty'; title: string; detail: string };
export type ProviderView = {
  id: ProviderId; provider: Provider; name: string; eyebrow: string; color: string;
  plan: { show: boolean; label: string; full: string; state: string; stale: boolean; title: string };
  state: StateKind; stateLabel: string; task: string; taskTitle: string;
  source: string; sourceTitle: string; isLocal: boolean; observed: string;
  metrics: Metrics; tightest: number | null; attention: boolean; inferred: boolean; accessRequired: boolean;
};

/** Where each built-in portrait's face sits, as fractions of the square image. */
export const faceFocus: Record<ProviderId, number> = {
  claude: .42, codex: .43, antigravity: .44, deepseek: .46, zcode: .46, kimi: .48, qwen: .48, workbuddy: .45,
};
export const LOW = 30;

export function money(value: string) {
  const number = new Big(value);
  if (number.gt(0) && number.lt('0.01')) return '<0.01';
  if (number.lt(0) && number.gt('-0.01')) return '−<0.01';
  return number.toFixed(2);
}
export function creditNumber(value: string) {
  try {
    const number = new Big(value);
    if (number.gt(0) && number.lt('0.01')) return '<0.01';
    return number.toFixed(2).replace(/\.?0+$/, '').replace(/^$/, '0');
  } catch { return '—'; }
}

export function buildView(provider: Provider, i18n: I18n, testing: boolean): ProviderView {
  const { t, date } = i18n;
  const local = provider.local;
  const isBalance = local?.id === 'deepseek';
  const isEntitlement = provider.id === 'qwen' || provider.id === 'workbuddy';
  const isClaudeDesktop = local?.id === 'claude' && local.claudeSource === 'desktop';

  const source = testing ? t('测试数据') : !local ? t('演示') : local.connection === 'offline' ? t('未运行')
    : local.accessRequired ? t('待授权') : local.connection === 'auth-required' ? t('待登录') : local.source === 'account' ? isBalance ? t('账号余额') : t('账号额度')
    : local.source === 'local-api' ? t('本地服务') : local.source === 'cache' ? isBalance ? t('历史记录') : local.id === 'codex' && local.plan?.status === '官方查询缓存' ? t('查询缓存') : t('本地记录') : t('未连接');
  const sourceTitle = local ? `${local.detail}${local.observedAt ? t(' 额度记录于 {p0}', { p0: date(local.observedAt) }) : ''}` : t('仅用于布局的演示数据');

  const state: StateKind = !local ? provider.running ? 'running' : 'idle' : local.activity;
  const stateLabel = !local ? provider.running ? t('演示运行') : t('演示待机')
    : { running: t('运行中'), idle: t('待机'), waiting: local.id === 'codex' || local.id === 'claude' ? local.waitingReason === 'input' ? t('待回答') : local.waitingReason === 'approval' ? t('待授权') : t('待处理') : t('待确认'), unknown: t('未知'), offline: t('离线') }[local.activity];
  const task = local?.activityAccessRequired && !['running', 'waiting'].includes(local.activity) ? t('辅助功能未授权，桌面状态未知') : local?.activity === 'unknown' && local.activityProbeError && local.activityProbeError !== 'unsupported-platform'
    ? t(local.activityAccessState === 'granted' ? '已授权，暂无法读取活动' : '活动读取失败') : provider.task;

  const plan = local?.plan;
  const expired = Boolean(plan?.expiresAt && Date.parse(plan.expiresAt) <= Date.now());
  const fullPlan = plan?.name || (local ? t('套餐未知') : t('示例套餐'));
  const planLabel = plan?.name || (local ? t('未知') : t('示例'));
  const planState = plan?.name ? plan.stale ? t('历史') : expired ? t('已到期') : '' : '';
  const planTitle = [t('套餐：{p0}', { p0: fullPlan }), plan?.status && i18n.label(plan.status), planState, plan?.expiresAt ? t('有效期至 {p0}', { p0: date(plan.expiresAt) }) : ''].filter(Boolean).join(' · ');

  function quotaTitle(quota: Quota) {
    const reset = quota.reset && local ? `${quota.resetKind === 'expiry' ? t('到期时间') : t('重置时间')} ${date(quota.reset)}` : quota.reset;
    return `${quota.model} · ${quota.period}${reset ? ` · ${reset}` : ''}${quota.variants?.length ? t(' · 合并：{p0}；剩余额度取较低值', { p0: quota.variants.join(', ') }) : ''}${quota.stale ? t(' · 已过时，历史剩余 {p0}%', { p0: quota.remaining ?? '未知' }) : ''}`;
  }

  let metrics: Metrics;
  if (isBalance) {
    metrics = { kind: 'balance', wallets: local.balance?.wallets || [], stale: Boolean(local.balance?.stale),
      empty: local.connection === 'auth-required' ? t('等待 Harness 登录') : local.connection === 'ready' ? t('暂无钱包记录') : t('余额暂不可用'), detail: local.detail };
  } else if (isEntitlement) {
    const items = local ? local.credits?.items || [] : [{ label: t('示例积分'), remaining: '1234.5', unit: t('积分'), total: '2000' }];
    metrics = { kind: 'credits', items, stale: Boolean(local?.credits?.stale),
      empty: local?.accessRequired ? t('等待登录读取授权') : local?.connection === 'auth-required' ? t('等待客户端登录') : local?.connection === 'error' ? t('积分读取失败') : t('积分 / 额度未知'),
      detail: local?.detail || t('等待首次读取') };
  } else if (local?.id === 'claude' && !local.quotas.length) {
    metrics = { kind: 'empty', title: t(isClaudeDesktop ? '额度未知' : 'Code 额度暂不可用'),
      detail: !isClaudeDesktop && local.plan?.name === 'Free' ? t('Free 账号不包含 Code 权限') : t('当前本地记录未提供额度窗口') };
  } else {
    const quotas = provider.quotas.length ? provider.quotas : [{ model: t('模型额度'), period: t('尚未读取'), remaining: null, reset: '' }];
    metrics = { kind: 'quota', rows: quotas.map((quota, index) => {
      const known = quota.remaining !== null && !quota.stale;
      const historical = provider.id === 'codex' && Boolean(quota.stale) && quota.remaining !== null;
      const label = local?.id === 'antigravity' ? quota.model.replace(/^Claude /, '').replace(/\(High\)/gi, t('· 高')).replace(/\(Medium\)/gi, t('· 中')).replace(/\(Low\)/gi, t('· 低')).replace(/\(Thinking\)/gi, t('· 思考')) : quota.model;
      return { key: `${quota.model}:${quota.period}:${index}`, label, period: local?.id === 'antigravity' ? '' : quota.period,
        remaining: known || historical ? quota.remaining : null, known, historical, stale: Boolean(quota.stale),
        low: known && quota.remaining! < LOW, title: quotaTitle(quota),
        status: historical ? t('历史') : quota.stale ? t('过时') : known ? t('剩余') : t('未知') };
    }) };
  }
  const known = metrics.kind === 'quota' ? metrics.rows.filter(row => row.known).map(row => row.remaining!) : [];
  return {
    id: provider.id, provider, name: provider.name, color: provider.color,
    eyebrow: local?.id === 'claude' ? t(local.claudeSource === 'desktop' ? '桌面版' : '终端版') : provider.subtitle,
    plan: { show: provider.id !== 'deepseek', label: planLabel, full: fullPlan, state: planState, stale: Boolean(plan?.stale), title: planTitle },
    state, stateLabel, task, taskTitle: local?.activityDetail || local?.detail || task,
    source, sourceTitle, isLocal: Boolean(local), observed: local?.observedAt ? date(local.observedAt, { hour: '2-digit', minute: '2-digit' }) : '',
    metrics, tightest: known.length ? Math.min(...known) : null, attention: local?.activity === 'waiting',
    inferred: Boolean(local?.activityInferred), accessRequired: Boolean(local?.activityAccessRequired),
  };
}
