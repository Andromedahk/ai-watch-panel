const https = require('node:https');

const MAX_BYTES = 128 * 1024;
const MAX_BALANCES = 32;
const HOSTNAME = 'www.kimi.com';
const SUBSCRIPTION_PATH = '/apiv2/kimi.gateway.membership.v2.MembershipService/GetSubscription';
const PLAN_NAMES = new Map(['Free', 'Adagio', 'Andante', 'Moderato', 'Allegretto', 'Vivace', 'Allegro', 'Plus', 'Pro', 'Max', 'Ultra']
  .map(name => [name.toLowerCase(), name]));

class KimiWorkError extends Error {
  constructor(code, retryMs = 60000) { super(code); this.code = code; this.retryMs = retryMs; }
}

function retryDelay(value, now = Date.now()) {
  if (typeof value !== 'string') return 60000;
  const delay = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now;
  return Number.isFinite(delay) ? Math.max(60000, Math.min(86400000, delay)) : 60000;
}

function validToken(value) {
  return typeof value === 'string' && /^[\x21-\x7e]{1,16384}$/.test(value);
}

function resetTime(value) {
  if (typeof value !== 'string' || value.length > 128) return '';
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : '';
}

function planName(value) {
  if (typeof value !== 'string' || value.length > 128) return null;
  return PLAN_NAMES.get(value.trim().toLowerCase()) || null;
}

function normalizeKimiWorkSubscription(payload, now = Date.now()) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || !Array.isArray(payload.balances) || payload.balances.length > MAX_BALANCES) throw new KimiWorkError('format');

  const candidates = new Map();
  const seen = new Set();
  const duplicated = new Set();
  for (const balance of payload.balances) {
    if (!balance || typeof balance !== 'object' || Array.isArray(balance)) throw new KimiWorkError('format');
    // Only the documented shared-credit balance can be labelled. Other features remain unknown.
    if (balance.feature !== 'FEATURE_OMNI') continue;
    if (balance.unit !== 'UNIT_CREDIT' || !['SUBSCRIPTION', 'GIFT'].includes(balance.type)) continue;
    const key = balance.type;
    if (seen.has(key)) { duplicated.add(key); continue; }
    seen.add(key);
    const ratio = balance.amountUsedRatio;
    if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio < 0 || ratio > 1) continue;
    candidates.set(key, { model: '共享积分', period: key === 'SUBSCRIPTION' ? '订阅额度' : '赠送额度',
      remaining: Math.round((1 - ratio) * 1000) / 10, reset: resetTime(balance.expireTime), resetKind: 'expiry' });
  }
  const quotas = ['SUBSCRIPTION', 'GIFT'].filter(key => !duplicated.has(key) && candidates.has(key)).map(key => candidates.get(key));
  return { plan: { name: planName(payload.subscription?.goods?.title) }, quotas };
}

function requestKimiWorkSubscription(token, { transport = https, timeoutMs = 5000 } = {}) {
  if (!validToken(token)) return Promise.reject(new KimiWorkError('endpoint'));
  const deadlineMs = Number.isFinite(timeoutMs) ? Math.max(1, Math.min(5000, timeoutMs)) : 5000;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      callback(value);
    };
    let request;
    const deadline = setTimeout(() => { finish(reject, new KimiWorkError('network')); request?.destroy(); }, deadlineMs);
    try {
      request = transport.request({ protocol: 'https:', hostname: HOSTNAME, path: SUBSCRIPTION_PATH, method: 'POST', agent: false,
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
          'Content-Length': '2', 'Connect-Protocol-Version': '1' } }, response => {
        response.on('error', () => finish(reject, new KimiWorkError('network')));
        if (response.statusCode !== 200) {
          const error = response.statusCode === 401 || response.statusCode === 403 ? new KimiWorkError('login')
            : response.statusCode === 429 ? new KimiWorkError('rate', retryDelay(response.headers?.['retry-after']))
              : new KimiWorkError('network');
          finish(reject, error); response.destroy(); return;
        }
        const chunks = []; let bytes = 0;
        response.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > MAX_BYTES) { finish(reject, new KimiWorkError('format')); response.destroy(); }
          else chunks.push(chunk);
        });
        response.on('end', () => {
          if (settled) return;
          try { finish(resolve, JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
          catch { finish(reject, new KimiWorkError('format')); }
        });
      });
      request.on('error', () => finish(reject, new KimiWorkError('network')));
      // A transport may close its upload before delivering the response. Errors,
      // response completion and the independent total deadline settle the query.
      request.end('{}');
    } catch { finish(reject, new KimiWorkError('network')); }
  });
}

module.exports = { HOSTNAME, SUBSCRIPTION_PATH, KimiWorkError, retryDelay, validToken,
  normalizeKimiWorkSubscription, requestKimiWorkSubscription };
