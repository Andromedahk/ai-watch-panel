import type { Provider } from './types';

// UI samples only. These labels and percentages are not provider plan specifications.
export const providers: Provider[] = [
  { id: 'claude', name: 'Claude Code', subtitle: 'ANTHROPIC', color: '#dba487', running: true,
    task: '正在整理项目结构', image: 'Claude.svg', quotas: [
      { model: 'Sonnet', period: '5 小时', remaining: 72, reset: '2 小时 18 分钟后重置' },
      { model: 'Opus', period: '5 小时', remaining: 38, reset: '2 小时 18 分钟后重置' },
      { model: '全部模型', period: '1 周', remaining: 86, reset: '4 天 6 小时后重置' },
    ] },
  { id: 'codex', name: 'Codex', subtitle: 'OPENAI', color: '#c9d4df', running: true,
    task: '正在构建监看面板', image: 'Codex.svg', quotas: [
      { model: '主要额度', period: '5 小时', remaining: 64, reset: '3 小时 42 分钟后重置' },
      { model: '周额度', period: '1 周', remaining: 91, reset: '5 天 2 小时后重置' },
    ] },
  { id: 'antigravity', name: 'Antigravity', subtitle: 'GOOGLE', color: '#aca8ef', running: false,
    task: '等待新任务', image: 'Antigravity.svg', quotas: [
      { model: 'Gemini', period: '5 小时', remaining: 100, reset: '额度充足' },
      { model: 'Claude', period: '5 小时', remaining: 24, reset: '1 小时 08 分钟后重置' },
      { model: '全部模型', period: '1 周', remaining: 78, reset: '3 天 12 小时后重置' },
    ] },
  { id: 'deepseek', name: 'DeepSeek Harness', subtitle: 'DEEPSEEK', color: '#7fbdb3', running: false,
    task: '等待新任务', image: 'DeepSeek.ico', quotas: [
      { model: 'DeepSeek', period: '可用额度', remaining: 95, reset: '自定义额度示例' },
      { model: '任务预算', period: '本次', remaining: 100, reset: '暂无运行任务' },
    ] },
];
