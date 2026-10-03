import { createContext, useContext } from 'react';
import shared from '../electron/i18n.cjs';
import type { I18n, Language } from '../electron/i18n.cjs';
import type { LocalProviderStatus, Provider } from './types';
export { type Language };
export const languages = shared.languages;
export const isLanguage = shared.isLanguage;
export const createI18n = (language: Language | undefined) => shared.createI18n(language || 'zh-CN', [...navigator.languages]);
export const I18nContext = createContext(createI18n('zh-CN'));
export const useI18n = () => useContext(I18nContext);
export function readLanguage(): Language {
  try { const value = localStorage.getItem('ai-watch:language'); return shared.isLanguage(value) ? value : 'zh-CN'; } catch { return 'zh-CN'; }
}
// Adapt public semantic fields without changing reader snapshots or quota logic.
export function localizeStatus(status: LocalProviderStatus, i18n: I18n): LocalProviderStatus {
  if (i18n.language === 'zh-CN') return status;
  const { t, label } = i18n;
  let detail = status.connection === 'ready' ? status.source === 'account' ? t('官方额度说明')
    : status.source === 'local-api' ? t('本地服务') : t('历史快照，当前值待更新')
    : status.connection === 'auth-required' ? t('登录说明') : t('身份说明');
  if (status.accessRequired || /权限|安全存储|授权/.test(status.detail)) detail = t('权限说明');
  else if (/格式|不兼容|协议/.test(status.detail)) detail = t('兼容说明');
  else if (/失败|限流|稍后重试/.test(status.detail)) detail = t('查询失败说明');
  if (status.id === 'claude' && !status.quotas.length) detail = t('未提供 Code 额度');
  if (status.id === 'deepseek' && status.connection === 'ready') detail = t('登录说明');
  if (status.source === 'unavailable' && !status.sampledAt) detail = t('尚未读取');
  const waiting = status.waitingReason === 'input' ? t('待回答') : status.waitingReason === 'approval' ? t('待授权') : t('待处理');
  const phase = { running: t('运行中'), waiting, idle: t('待机'), unknown: t('未知'), offline: t('未运行') }[status.activity];
  const task = status.activity === 'running' && status.activeTasks ? t('{p0} 项运行', { p0: status.activeTasks }) : phase;
  const sample = /测试|演示|合成/.test(status.detail);
  if (sample) detail = t('测试说明');
  const surface = (value: string) => /未运行|无运行/.test(value) ? t('未运行') : /测试/.test(value) ? t('测试') : /[0-9]+.*会话/.test(value) ? `${t('任务状态')} · ${i18n.number(Number(value.match(/[0-9]+/)![0]))}` : t('未知');
  return { ...status, task, detail, activityDetail: t(sample ? '测试说明' : '活动说明'),
    quotas: status.quotas.map(q => ({ ...q, model: label(q.model), period: label(q.period) })),
    plan: status.plan && { ...status.plan, name: status.plan.name && label(status.plan.name), status: status.plan.status },
    credits: status.credits && { ...status.credits, items: status.credits.items.map(item => ({ ...item, label: label(item.label), unit: label(item.unit) })) },
    surfaces: status.surfaces && { desktop: `${t('桌面版')} · ${surface(status.surfaces.desktop)}`, terminal: `${t('终端版')} · ${surface(status.surfaces.terminal)}` },
  };
}
export function localizeProvider(provider: Provider, i18n: I18n): Provider {
  const local = provider.local && localizeStatus(provider.local, i18n);
  return { ...provider, name: provider.id === 'qwen' && !i18n.language.startsWith('zh') ? 'Qwen' : provider.id === 'qwen' && i18n.language !== 'zh-CN' ? 'Qwen（千問）' : provider.name,
    local, task: local ? local.task : i18n.t(provider.task),
    quotas: provider.quotas.map(q => ({ ...q, model: i18n.label(q.model), period: i18n.label(q.period), reset: provider.local ? q.reset : '' })),
  };
}
