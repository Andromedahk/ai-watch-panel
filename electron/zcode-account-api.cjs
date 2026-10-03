const https = require('node:https');

const MAX_BYTES = 128 * 1024;
const MAX_ROWS = 32;
const MAX_TOKEN_BYTES = 16 * 1024;
const ENDPOINTS = Object.freeze({
  zai: Object.freeze({ hostname: 'api.z.ai' }),
  bigmodel: Object.freeze({ hostname: 'bigmodel.cn' }),
});
const PATHS = Object.freeze({
  identity: '/api/biz/customer/getCustomerInfo',
  subscription: '/api/biz/subscription/list',
  quota: '/api/monitor/usage/quota/limit',
});
const PLAN_NAMES = new Map([
  ['GLM Coding Lite', 'Lite'], ['GLM Coding Pro', 'Pro'], ['GLM Coding Max', 'Max'],
  ['GLM Coding Plan Lite', 'Lite'], ['GLM Coding Plan Pro', 'Pro'], ['GLM Coding Plan Max', 'Max'],
  ['Coding Plan Lite', 'Lite'], ['Coding Plan Pro', 'Pro'], ['Coding Plan Max', 'Max'],
]);
const NUMERIC_LIMIT_FIELDS = Object.freeze(['unit', 'number', 'usage', 'currentValue', 'remaining', 'percentage', 'nextResetTime']);

class ZcodeAccountError extends Error {
  constructor(code, retryMs = 60000) {
    super(code);
    this.code = code;
    this.retryMs = retryMs;
  }
}

function retryDelay(value, now = Date.now()) {
  if (typeof value !== 'string') return 60000;
  const delay = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now;
  return Number.isFinite(delay) ? Math.max(60000, Math.min(86400000, delay)) : 60000;
}

function rawToken(value) {
  if (typeof value !== 'string') return null;
  const candidate = value.replace(/^Bearer[ \t]+/i, '');
  return /^[\x21-\x7e]{1,16384}$/.test(candidate) && Buffer.byteLength(candidate, 'ascii') <= MAX_TOKEN_BYTES ? candidate : null;
}

function responseHeader(headers, name) {
  if (!headers || typeof headers !== 'object') return undefined;
  const target = name.toLowerCase();
  return Object.entries(headers).find(([key]) => String(key).toLowerCase() === target)?.[1];
}

function successfulData(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new ZcodeAccountError('format');
  if (payload.code === 401 || payload.code === 403) throw new ZcodeAccountError('login');
  if (payload.success !== undefined && payload.success !== true) throw new ZcodeAccountError('format');
  if (payload.code !== undefined && payload.code !== 0 && payload.code !== 200) throw new ZcodeAccountError('format');
  if (!Object.prototype.hasOwnProperty.call(payload, 'data')) throw new ZcodeAccountError('format');
  return payload.data;
}

function normalizeIdentity(payload) {
  const data = successfulData(payload);
  if (!data || typeof data !== 'object' || Array.isArray(data)
    || typeof data.customerNumber !== 'string' || !data.customerNumber.trim() || data.customerNumber.length > 256) {
    throw new ZcodeAccountError('format');
  }
  // Deliberately return only the opaque identifier needed for an account-binding check.
  return { customerNumber: data.customerNumber };
}

function isCurrentCodingPlan(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)
    || row.status !== 'VALID' || row.inCurrentPeriod !== true) return false;
  return [row.productId, row.productName].some(product => typeof product === 'string'
    && product.toLowerCase().includes('coding'));
}

function normalizeSubscription(payload) {
  const data = successfulData(payload);
  if (!Array.isArray(data) || data.length > MAX_ROWS) throw new ZcodeAccountError('format');
  const active = data.filter(isCurrentCodingPlan);
  // More than one matching entitlement cannot be assigned to a displayed tier safely.
  if (active.length !== 1) return { plan: { name: null } };
  const row = active[0];
  const title = typeof row.productName === 'string' ? row.productName : row.productId;
  return { plan: { name: PLAN_NAMES.get(title) || null } };
}

function normalizeQuota(payload) {
  const data = successfulData(payload);
  if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.limits) || data.limits.length > MAX_ROWS) {
    throw new ZcodeAccountError('format');
  }
  const limits = [];
  for (const row of data.limits) {
    if (!row || typeof row !== 'object' || Array.isArray(row)
      || typeof row.type !== 'string' || !row.type || row.type.length > 64) continue;
    const safe = { type: row.type };
    for (const field of NUMERIC_LIMIT_FIELDS) {
      if (typeof row[field] === 'number' && Number.isFinite(row[field])) safe[field] = row[field];
    }
    limits.push(safe);
  }
  return limits;
}

function displayRemaining(percentage) {
  if (typeof percentage !== 'number' || !Number.isFinite(percentage) || percentage < 0 || percentage > 100) return null;
  return Math.round((100 - percentage) * 10) / 10;
}

function displayReset(nextResetTime) {
  if (typeof nextResetTime !== 'number' || !Number.isFinite(nextResetTime) || nextResetTime <= 0) return '';
  const date = new Date(nextResetTime);
  return Number.isFinite(date.getTime()) ? date.toISOString() : '';
}

function displayBucket(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  if (row.type === 'TIME_LIMIT' && row.unit === 5 && row.number === 1) return 'monthlyTool';
  if (!['TOKENS_LIMIT', 'CREDIT_LIMIT'].includes(row.type)) return null;
  if (row.unit === 3 && row.number === 5) return 'fiveHour';
  if (row.unit === 6) return 'weekly';
  return null;
}

// This only maps renderer-verified bucket identifiers. It intentionally does
// not derive a display period from a count, an unknown unit, or reset spacing.
function normalizeDisplayQuotas(limits) {
  if (!Array.isArray(limits) || limits.length > MAX_ROWS) return [];
  const rows = new Map();
  const duplicates = new Set();
  for (const row of limits) {
    const bucket = displayBucket(row);
    if (!bucket) continue;
    if (rows.has(bucket)) { rows.delete(bucket); duplicates.add(bucket); continue; }
    if (!duplicates.has(bucket)) rows.set(bucket, row);
  }
  const definitions = [
    ['fiveHour', '共享额度', '5 小时'],
    ['weekly', '共享额度', '1 周'],
    ['monthlyTool', '工具调用', '1 月'],
  ];
  return definitions.filter(([bucket]) => rows.has(bucket)).map(([bucket, model, period]) => {
    const row = rows.get(bucket);
    return { model, period, remaining: displayRemaining(row.percentage), reset: displayReset(row.nextResetTime) };
  });
}

function requestZcodeJson(family, kind, token, { transport = https, timeoutMs = 5000 } = {}) {
  const endpoint = Object.hasOwn(ENDPOINTS, family) ? ENDPOINTS[family] : null;
  const path = Object.hasOwn(PATHS, kind) ? PATHS[kind] : null;
  const authorization = rawToken(token);
  if (!endpoint || !path || !authorization || (kind === 'identity' && family !== 'bigmodel')) {
    return Promise.reject(new ZcodeAccountError('endpoint'));
  }
  const deadlineMs = Number.isFinite(timeoutMs) ? Math.max(1, Math.min(5000, timeoutMs)) : 5000;
  return new Promise((resolve, reject) => {
    let settled = false;
    let request;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      callback(value);
    };
    const deadline = setTimeout(() => {
      finish(reject, new ZcodeAccountError('network'));
      request?.destroy();
    }, deadlineMs);
    try {
      request = transport.request({
        protocol: 'https:', hostname: endpoint.hostname, path, method: 'GET', agent: false,
        headers: { Accept: 'application/json', Authorization: authorization },
      }, response => {
        let completed = false;
        response.on('error', () => finish(reject, new ZcodeAccountError('network')));
        response.on('aborted', () => finish(reject, new ZcodeAccountError('network')));
        response.on('close', () => { if (!completed) finish(reject, new ZcodeAccountError('network')); });
        if (response.statusCode !== 200) {
          const error = response.statusCode === 401 || response.statusCode === 403 ? new ZcodeAccountError('login')
            : response.statusCode === 429 ? new ZcodeAccountError('rate', retryDelay(responseHeader(response.headers, 'retry-after')))
              : new ZcodeAccountError('network');
          finish(reject, error);
          response.destroy();
          return;
        }
        const chunks = [];
        let bytes = 0;
        response.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > MAX_BYTES) {
            finish(reject, new ZcodeAccountError('format'));
            response.destroy();
          } else chunks.push(chunk);
        });
        response.on('end', () => {
          if (settled) return;
          completed = true;
          try { finish(resolve, JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
          catch { finish(reject, new ZcodeAccountError('format')); }
        });
      });
      request.on('error', () => finish(reject, new ZcodeAccountError('network')));
      request.end();
    } catch {
      finish(reject, new ZcodeAccountError('network'));
    }
  });
}

module.exports = { ENDPOINTS, PATHS, PLAN_NAMES, ZcodeAccountError, retryDelay, rawToken,
  normalizeIdentity, normalizeSubscription, normalizeQuota, normalizeDisplayQuotas, requestZcodeJson };
