'use strict';
const { createHash } = require('node:crypto');
const PROVIDERS = new Set(['claude', 'codex', 'antigravity', 'deepseek', 'zcode', 'kimi', 'qwen', 'workbuddy']);
const CONNECTIONS = new Set(['ready', 'offline', 'unavailable', 'error', 'auth-required']);
const ACTIVITIES = new Set(['running', 'waiting', 'idle', 'unknown', 'offline']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v, max, empty = false) => typeof v === 'string' && (empty || v.length > 0) && v.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v);
const integer = (v, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(v) && v >= min && v <= max;
const keys = (v, allowed) => isObject(v) && Object.keys(v).every(k => allowed.includes(k));
const unique = (list, key) => list.every(isObject) && new Set(list.map(v => v[key])).size === list.length;
const digest = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
// Command equality is semantic: native JSON encoders may reorder object keys on retry.
const canonical = v => Array.isArray(v) ? v.map(canonical) : isObject(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
const commandDigest = v => digest(canonical(v));
function error(code, status = 400) { const e = new Error(code); e.status = status; return e; }
function ensure(ok, code = 'invalid-body', status = 400) { if (!ok) throw error(code, status); }
// Full context is an explicit desktop opt-in. Keep the original metadata/answer
// identifiers stable, and reject terminal control characters in optional text.
const fullText = (value, max) => text(value, max, true) && !/[\u007f-\u009f]/.test(value);
function validateFullContent(request) {
  const full = request.fullContent;
  if (full === undefined) return;
  const allowed = request.kind === 'input' ? ['questions'] : request.title === 'codex.commandApproval'
    ? ['command', 'cwd', 'reason'] : ['cwd', 'grantRoot', 'reason'];
  ensure(keys(full, allowed), 'invalid-full-content');
  for (const [name, limit] of Object.entries({ command: 4096, cwd: 1024, reason: 4096, grantRoot: 1024 })) {
    ensure(full[name] === undefined || fullText(full[name], limit), 'invalid-full-content');
  }
  if (full.questions !== undefined) {
    ensure(Array.isArray(full.questions) && full.questions.length === request.questions.length, 'invalid-full-content');
    for (const [index, q] of full.questions.entries()) {
      const metadata = request.questions[index];
      ensure(keys(q, ['id', 'header', 'question', 'options']) && q.id === metadata.id && fullText(q.header, 256)
        && fullText(q.question, 4096) && Array.isArray(q.options) && q.options.length === metadata.options.length, 'invalid-full-content');
      for (const option of q.options) ensure(keys(option, ['label', 'description']) && fullText(option.label, 256)
        && fullText(option.description, 1024), 'invalid-full-content');
    }
  }
}
function validateSnapshot(value) {
  ensure(keys(value, ['p', 'requests', 'sample', 'stale', 'limited']) && typeof value.sample === 'boolean' && (value.stale === undefined || value.stale === true) && (value.limited === undefined || value.limited === true));
  ensure(Array.isArray(value.p) && value.p.length <= 8 && unique(value.p, 'i'));
  for (const p of value.p) {
    ensure(keys(p, ['i', 'c', 'a', 'n', 'w', 'q']) && PROVIDERS.has(p.i) && CONNECTIONS.has(p.c) && ACTIVITIES.has(p.a) && integer(p.n, 0, 100000));
    ensure(p.w === undefined || ['input', 'approval', 'both'].includes(p.w));
    ensure(Array.isArray(p.q) && p.q.length <= 16);
    for (const q of p.q) ensure(keys(q, ['m', 'p', 'r', 's', 'z']) && text(q.m, 120, true) && text(q.p, 120, true)
      && (q.r === null || typeof q.r === 'number' && Number.isFinite(q.r) && q.r >= 0 && q.r <= 100)
      && (q.s === undefined || q.s === true) && (q.z === undefined || text(q.z, 64, true)));
  }
  ensure(Array.isArray(value.requests) && value.requests.length <= 32 && unique(value.requests, 'id'));
  const executables = new Set(['git', 'npm', 'npx', 'node', 'python', 'python3', 'pip', 'pip3', 'bash', 'sh', 'zsh', 'pwsh', 'powershell', 'cargo', 'go', 'make', 'cmake', 'swift', 'xcodebuild', 'gradle', 'docker', 'curl', 'wget', 'ls', 'cat', 'rg', 'find', 'cp', 'mv', 'rm', 'command']);
  for (const r of value.requests) {
    ensure(keys(r, ['id', 'provider', 'kind', 'title', 'detail', 'questions', 'expiresAt', 'fullContent']) && /^codex-[a-f0-9]{64}$/.test(r.id) && r.provider === 'codex'
      && ['input', 'approval'].includes(r.kind) && integer(r.expiresAt, 1), 'private-request-rejected');
    if (r.kind === 'input') {
      ensure(r.title === 'codex.input' && r.detail === 'input' && Array.isArray(r.questions) && r.questions.length >= 1 && r.questions.length <= 16 && unique(r.questions, 'id'), 'private-request-rejected');
      for (const [index, q] of r.questions.entries()) {
        ensure(keys(q, ['id', 'header', 'question', 'options', 'isOther']) && /^[a-f0-9]{64}$/.test(q.id) && q.header === `question.${index + 1}` && q.question === 'review.questionOnDesktop'
          && (q.isOther === undefined || typeof q.isOther === 'boolean'), 'private-request-rejected');
        ensure(Array.isArray(q.options) && q.options.length <= 32, 'private-request-rejected');
        for (const [optionIndex, o] of q.options.entries()) ensure(keys(o, ['label', 'description']) && o.label === `option.${optionIndex + 1}` && o.description === '', 'private-request-rejected');
      }
    } else {
      ensure(r.questions === undefined && (r.title === 'codex.commandApproval' && executables.has(r.detail) || r.title === 'codex.fileApproval' && r.detail === 'fileChange'), 'private-request-rejected');
    }
    validateFullContent(r);
  }
  return value;
}
function validateSync(value) {
  ensure(keys(value, ['v', 'd', 's', 'n', 't', 'h', 'snapshot', 'results']) && value.v === 1 && UUID.test(value.d) && UUID.test(value.s)
    && integer(value.n, 1) && integer(value.t, 1) && /^[0-9a-f]{64}$/.test(value.h));
  if (value.snapshot !== undefined) { validateSnapshot(value.snapshot); ensure(digest(value.snapshot) === value.h, 'snapshot-hash-mismatch'); }
  if (value.results !== undefined) {
    ensure(Array.isArray(value.results) && value.results.length <= 64 && unique(value.results, 'id'));
    for (const r of value.results) ensure(keys(r, ['id', 'status', 'error']) && UUID.test(r.id) && ['succeeded', 'failed'].includes(r.status)
      && (r.error === undefined || /^[a-z0-9-]{1,100}$/.test(r.error)));
  }
  return value;
}
function validateCommand(value) {
  ensure(keys(value, ['id', 'requestId', 'kind', 'answer', 'answers', 'choice']) && UUID.test(value.id) && text(value.requestId, 256)
    && ['answer', 'approve', 'deny'].includes(value.kind));
  ensure(value.answer === undefined || text(value.answer, 16384, true));
  ensure(value.choice === undefined || text(value.choice, 256));
  if (value.answers !== undefined) {
    ensure(isObject(value.answers) && Object.keys(value.answers).length <= 16);
    for (const [k, v] of Object.entries(value.answers)) ensure(text(k, 256) && !['__proto__', 'constructor', 'prototype'].includes(k)
      && keys(v, ['answers']) && Array.isArray(v.answers) && v.answers.length <= 32 && v.answers.every(x => text(x, 4096, true)));
  }
  ensure(Buffer.byteLength(JSON.stringify(value)) <= 32768, 'command-too-large', 413);
  if (value.kind !== 'answer') ensure(value.answer === undefined && value.answers === undefined);
  else ensure(value.answer !== undefined || value.answers !== undefined || value.choice !== undefined, 'answer-required');
  return value;
}
function validatePair(value) {
  ensure(keys(value, ['id', 'name', 'platform']) && UUID.test(value.id) && text(value.name, 80) && ['android', 'ios'].includes(value.platform));
  return value;
}
function validateDevice(value) {
  ensure(keys(value, ['id', 'platform', 'token', 'environment', 'transport', 'liveUpdates', 'liveActivity']) && UUID.test(value.id) && ['android', 'ios'].includes(value.platform));
  ensure(value.platform === 'ios' ? /^[0-9a-f]{64,200}$/i.test(value.token) : value.transport && value.transport !== 'fcm'
    ? /^[A-Za-z0-9_:+/=.-]{20,4096}$/.test(value.token) : /^[A-Za-z0-9_:\-\.]{20,4096}$/.test(value.token));
  ensure(value.environment === undefined || ['sandbox', 'production'].includes(value.environment));
  ensure(value.transport === undefined || value.platform === 'android' && ['fcm', 'mipush', 'vpush', 'opush'].includes(value.transport));
  ensure(value.liveUpdates === undefined || typeof value.liveUpdates === 'boolean');
  if (value.liveActivity !== undefined) ensure(value.platform === 'android' && keys(value.liveActivity, ['notificationId', 'locallyCreated'])
    && integer(value.liveActivity.notificationId, 1, 2147483647) && typeof value.liveActivity.locallyCreated === 'boolean');
  return value;
}
module.exports = { UUID, PROVIDERS, isObject, text, integer, digest, commandDigest, error, ensure, validateSnapshot, validateSync, validateCommand, validateDevice, validatePair };
