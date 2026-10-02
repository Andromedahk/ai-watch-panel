import type { LocalProviderStatus, LocalStatus, ProviderId, Quota } from './types';
import { providerIds } from './data';

export type TestActivity = 'running' | 'idle' | 'waiting' | 'input' | 'approval' | 'mixed' | 'unknown' | 'offline';
export type TestData = 'normal' | 'low' | 'zero' | 'full' | 'unknown' | 'stale' | 'free' | 'tiny' | 'signed-out' | 'error';
export type TestSelection = { activity: TestActivity; data: TestData };
export type TestConfig = Record<ProviderId, TestSelection>;
export type TestPreset = 'running' | 'idle' | 'input' | 'approval';

export function defaultTestConfig(): TestConfig {
  return {
    claude: { activity: 'running', data: 'normal' }, codex: { activity: 'running', data: 'normal' },
    antigravity: { activity: 'running', data: 'normal' }, deepseek: { activity: 'running', data: 'normal' },
    zcode: { activity: 'running', data: 'normal' }, kimi: { activity: 'running', data: 'normal' },
  };
}
export function applyTestPreset(config: TestConfig, preset: TestPreset): TestConfig {
  if (preset === 'input' || preset === 'approval') return { ...config, codex: { ...config.codex, activity: preset } };
  return Object.fromEntries(Object.entries(config).map(([id, selection]) => [id, { ...selection, activity: preset }])) as TestConfig;
}
export function activityOptions(id: ProviderId): [TestActivity, string][] {
  return [
    ['running', '运行中'], ['idle', '待机'],
    ...(id === 'codex' ? [['input', '等待回答'], ['approval', '等待授权'], ['mixed', '等待 + 其他任务运行']] as [TestActivity, string][]
      : [['waiting', '等待确认']] as [TestActivity, string][]),
    ['unknown', '状态未知'], ['offline', '离线'],
  ];
}
export function dataOptions(id: ProviderId): [TestData, string][] {
  if (id === 'deepseek') return [
    ['normal', '正常余额 · 双币种'], ['zero', '零余额'], ['tiny', '小于 0.01'], ['stale', '历史余额'],
    ['signed-out', '未登录'], ['unknown', '余额未知'], ['error', '读取失败'],
  ];
  return [
    ['normal', id === 'antigravity' ? '正常额度 · 3 页' : '正常额度'], ['low', '低额度 12.5%'],
    ['zero', '额度耗尽 0%'], ['full', '满额 100%'], ['unknown', '额度未知'], ['stale', '记录过时'],
    ...(id === 'claude' ? [['free', 'Free · 无 Code 额度']] as [TestData, string][] : []),
  ];
}
function testQuotas(id: ProviderId, data: TestData, at: string): Quota[] {
  if (id === 'deepseek' || data === 'free') return [];
  const models = id === 'antigravity'
    ? ['Gemini 测试模型（高）', 'Gemini 测试模型（思考）', 'Gemini 测试模型（中）', 'Claude 测试模型（高）', 'Claude 测试模型（低）', '测试模型 · 较长名称与额度分页显示', '其他测试模型']
    : id === 'claude' ? ['Claude', 'Sonnet', 'Opus'] : ['短时额度', id === 'kimi' ? 'Kimi Code' : id === 'zcode' ? 'ZCode' : 'Codex'];
  return models.map((model, index) => ({
    model, period: id === 'antigravity' ? '测试窗口' : index === 0 ? '5 小时' : '1 周',
    remaining: data === 'unknown' ? null : data === 'zero' ? 0 : data === 'full' ? 100 : data === 'low' ? 12.5 : [78.4, 56.2, 99.7][index % 3],
    reset: new Date(Date.parse(at) + (data === 'stale' ? -3600000 : 18000000)).toISOString(), stale: data === 'stale',
  }));
}

// UI-only data: never mutate adapter snapshots, account state, or saved preferences.
export function makeTestStatus(config: TestConfig, at: string): LocalStatus {
  const result = { sampledAt: at, isTestData: true } as LocalStatus;
  for (const id of providerIds) {
    const { activity, data } = config[id];
    const waiting = ['waiting', 'input', 'approval', 'mixed'].includes(activity);
    const status: LocalProviderStatus = {
      id, source: id === 'deepseek' ? 'account' : id === 'antigravity' ? 'local-api' : 'cache', connection: 'ready',
      activity: waiting ? 'waiting' : activity as LocalProviderStatus['activity'],
      activeTasks: activity === 'running' || activity === 'mixed' ? 1 : 0,
      task: `测试 · ${activityOptions(id).find(([value]) => value === activity)?.[1] || '待机'}`,
      quotas: testQuotas(id, data, at), sampledAt: at,
      observedAt: data === 'stale' ? new Date(Date.parse(at) - 7200000).toISOString() : at,
      detail: '界面测试数据，仅用于预览显示效果。', activityDetail: '手动选择的测试状态，不代表真实任务。',
    };
    if (id === 'codex' && waiting) Object.assign(status, {
      waitingTasks: activity === 'mixed' ? 2 : 1,
      waitingReason: activity === 'input' ? 'input' : activity === 'approval' ? 'approval' : 'both', attentionAvailable: true,
    });
    if (id === 'claude') status.surfaces = { desktop: '测试 · 桌面版状态', terminal: '测试 · 终端版状态' };
    if (id === 'deepseek') {
      const empty = ['signed-out', 'unknown', 'error'].includes(data);
      status.balance = { stale: data === 'stale', wallets: empty ? [] : [
        { currency: 'CNY', total: data === 'zero' ? '0' : data === 'tiny' ? '0.003' : '13.57', paid: data === 'zero' ? '0' : data === 'tiny' ? '0.001' : '12.34', bonus: data === 'zero' ? '0' : data === 'tiny' ? '0.002' : '1.23' },
        { currency: 'USD', total: data === 'zero' ? '0' : data === 'tiny' ? '0.006' : '2.10', paid: data === 'zero' ? '0' : data === 'tiny' ? '0.004' : '2.00', bonus: data === 'zero' ? '0' : data === 'tiny' ? '0.002' : '0.10' },
      ] };
      if (empty) {
        status.connection = data === 'signed-out' ? 'auth-required' : data === 'error' ? 'error' : 'unavailable';
        status.detail = `测试 · ${data === 'signed-out' ? '尚未登录 Harness' : data === 'error' ? '余额读取失败，请稍后重试' : '暂无可用余额记录'}`;
      }
    }
    if (activity === 'offline') status.connection = 'offline';
    result[id] = status;
  }
  return result;
}
