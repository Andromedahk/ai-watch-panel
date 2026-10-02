// Keep provider payloads behind an allowlist before crossing the preload bridge.
const ACTIVITY_FRESH_MS = 10 * 60 * 1000;
const QUOTA_FRESH_MS = 30 * 60 * 1000;
const number = (value) => typeof value === 'number' && Number.isFinite(value) ? value : null;
const timestamp = (value) => {
  const parsed = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 8640000000000000 ? parsed : null;
};
const text = (value, fallback) => typeof value === 'string' && value.trim()
  ? value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 96) : fallback;
const percentage = (value) => value === null ? null : Math.round(Math.min(100, Math.max(0, value)) * 10) / 10;
const CODEX_PLANS = Object.freeze({ free: 'Free', go: 'Go', plus: 'Plus', pro: 'Pro',
  team: 'Team', business: 'Business', enterprise: 'Enterprise', edu: 'Edu' });
const ANTIGRAVITY_PLANS = Object.freeze({ free: 'Free', pro: 'Pro', ultra: 'Ultra',
  teams: 'Teams', enterprise: 'Enterprise', 'google ai plus': 'Google AI Plus',
  'google ai pro': 'Google AI Pro', 'google ai ultra': 'Google AI Ultra' });
function planName(value, names) {
  if (typeof value !== 'string' || value.length > 48) return null;
  const key = value.trim().toLowerCase();
  return Object.hasOwn(names, key) ? names[key] : null;
}
function snapshotStale(observedAt, now) {
  const observed = timestamp(observedAt);
  return !observed || now - observed > QUOTA_FRESH_MS || observed > now + 120000;
}
function normalizeCodexPlan(payload, observedAt, now = Date.now()) {
  // Review/other buckets can have a different entitlement. Only the main bucket is authoritative.
  const bucket = payload?.rateLimitsByLimitId && typeof payload.rateLimitsByLimitId === 'object'
    ? payload.rateLimitsByLimitId.codex : payload?.rateLimits || payload;
  return { name: planName(bucket?.plan_type ?? bucket?.planType, CODEX_PLANS),
    status: '本地快照', stale: snapshotStale(observedAt, now) };
}
function normalizeAntigravityPlan(payload, observedAt, now = Date.now()) {
  const status = payload?.userStatus;
  // Never read userStatus.name: it is the user's identity, not the product name.
  // If a newer tier is present but unknown, don't replace it with an older generic plan.
  const value = status?.userTier && Object.hasOwn(status.userTier, 'name')
    ? status.userTier.name : status?.planStatus?.planInfo?.planName;
  return { name: planName(value, ANTIGRAVITY_PLANS), stale: snapshotStale(observedAt, now) };
}
function period(minutes) {
  if (minutes === 10080) return '1 周';
  if (minutes && minutes % 60 === 0) return `${minutes / 60} 小时`;
  return minutes && minutes > 0 ? `${minutes} 分钟` : '周期未知';
}
function unknownCodexQuotas() {
  return [
    { model: '短时额度', period: '5 小时', remaining: null, reset: '', stale: false },
    { model: '周额度', period: '1 周', remaining: null, reset: '', stale: false },
  ];
}
function normalizeCodexRates(payload, observedAt, now = Date.now()) {
  const observed = timestamp(observedAt);
  const old = !observed || now - observed > QUOTA_FRESH_MS || observed > now + 120000;
  const buckets = payload?.rateLimitsByLimitId && typeof payload.rateLimitsByLimitId === 'object'
    ? Object.entries(payload.rateLimitsByLimitId).slice(0, 12)
    : [[payload?.limit_id || payload?.limitId || 'codex', payload?.rateLimits || payload]];
  const quotas = [];
  for (const [id, bucket] of buckets) {
    if (!bucket || typeof bucket !== 'object') continue;
    for (const name of ['primary', 'secondary']) {
      const window = bucket[name];
      if (!window || typeof window !== 'object') continue;
      const used = number(window.used_percent ?? window.usedPercent);
      const minutes = number(window.window_minutes ?? window.windowDurationMins);
      const seconds = number(window.resets_at ?? window.resetsAt);
      const resetAt = seconds !== null && seconds > 0 && seconds <= 8640000000000 ? seconds * 1000 : null;
      const stale = old || (resetAt !== null && resetAt <= now);
      quotas.push({ model: id === 'codex_reviews' ? '代码审查' : 'Codex', period: period(minutes),
        remaining: used !== null && used >= 0 && used <= 100 ? percentage(100 - used) : null,
        reset: resetAt === null ? '' : new Date(resetAt).toISOString(), stale });
    }
  }
  if (!quotas.length) return unknownCodexQuotas();
  // A missing window is unknown, never an inferred full allowance.
  if (!quotas.some((quota) => quota.period === '5 小时')) quotas.unshift(unknownCodexQuotas()[0]);
  return quotas;
}
function normalizeAntigravityQuotas(payload, observedAt, now = Date.now()) {
  const observed = timestamp(observedAt);
  const old = !observed || now - observed > QUOTA_FRESH_MS || observed > now + 120000;
  const models = payload?.userStatus?.cascadeModelConfigData?.clientModelConfigs;
  if (!Array.isArray(models)) return [];
  return models.slice(0, 100).map((model) => {
    const fraction = number(model?.quotaInfo?.remainingFraction);
    const resetAt = timestamp(model?.quotaInfo?.resetTime);
    return { model: text(model?.label, '未命名模型'), period: '模型额度',
      remaining: fraction !== null && fraction >= 0 && fraction <= 1 ? percentage(fraction * 100) : null,
      reset: resetAt === null ? '' : new Date(resetAt).toISOString(),
      stale: old || (resetAt !== null && resetAt <= now) };
  }).sort((a, b) => a.model.localeCompare(b.model, 'en', { numeric: true }));
}
function normalizeCodexActivity(rows, latest, processRunning, now = Date.now()) {
  if (!processRunning) return { activity: 'offline', activeTasks: 0, task: '未检测到 Codex 进程' };
  if (!Array.isArray(rows)) return { activity: 'unknown', activeTasks: 0, task: '任务记录暂不可读' };
  const fresh = rows.filter((row) => {
    const started = number(row.started_at);
    const last = number(row.last_item_at);
    const activityAt = Math.max(started === null ? 0 : started * 1000, last ?? 0);
    return activityAt > 0 && now - activityAt <= ACTIVITY_FRESH_MS && activityAt <= now + 120000;
  });
  if (fresh.length) return { activity: 'running', activeTasks: fresh.length, task: `${fresh.length} 项任务有近期活动` };
  const completed = number(latest?.completed_at);
  if (rows.length && (!completed || now - completed * 1000 > ACTIVITY_FRESH_MS)) {
    return { activity: 'unknown', activeTasks: 0, task: '未结束的任务记录已过时' };
  }
  if (!latest) return { activity: 'unknown', activeTasks: 0, task: '暂无可用任务记录' };
  return { activity: 'idle', activeTasks: 0, task: '本地记录中暂无运行任务' };
}
function normalizeAntigravityActivity(rows, processRunning) {
  if (!processRunning) return { activity: 'offline', activeTasks: 0, task: '未检测到 Antigravity 服务' };
  if (!Array.isArray(rows)) return { activity: 'unknown', activeTasks: 0, task: '任务状态暂不可读' };
  const active = rows.filter((row) => row?.status === 'CASCADE_RUN_STATUS_RUNNING' && !row.killed);
  if (active.length) return { activity: 'running', activeTasks: active.length, task: `${active.length} 项任务正在运行` };
  const unknown = rows.some((row) => !row.killed && (row.status !== 'CASCADE_RUN_STATUS_IDLE' || Boolean(row.not_fully_idle)));
  if (unknown) return { activity: 'unknown', activeTasks: 0, task: '存在尚未确认的任务状态' };
  return { activity: 'idle', activeTasks: 0, task: '本地服务中暂无运行任务' };
}
module.exports = { ACTIVITY_FRESH_MS, QUOTA_FRESH_MS, normalizeCodexRates, unknownCodexQuotas,
  normalizeCodexPlan, normalizeAntigravityPlan, normalizeAntigravityQuotas,
  normalizeCodexActivity, normalizeAntigravityActivity };
