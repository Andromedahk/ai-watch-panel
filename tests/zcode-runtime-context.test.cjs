const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { ZcodeRuntimeContextError, defaultHelperPath, readZcodeRuntimeContext } = require('../electron/zcode-runtime-context.cjs');

const uid = process.getuid();
const mainPid = 4100;
const holderPid = 4101;
const home = '/fixture/home';
const mainExe = '/Applications/ZCode.app/Contents/MacOS/ZCode';
const helperExe = '/Applications/ZCode.app/Contents/Frameworks/ZCode Helper.app/Contents/MacOS/ZCode Helper';
const tasks = path.join(home, '.zcode', 'v2', 'tasks-index.sqlite');
const helperPath = '/fixture/zcode-process-context';

function info(pid, changes = {}) {
  const base = pid === mainPid
    ? { pid, uid, ppid: 1, startSeconds: 10, startMicros: 20, executable: mainExe, selectors: {}, secretOverride: false }
    : { pid, uid, ppid: mainPid, startSeconds: 11, startMicros: 21, executable: helperExe, selectors: {
      HOME: home, USERPROFILE: home, ZCODE_DESKTOP_HOME_DIR: home, ZCODE_DATA_BASE_DIR: home,
      ZCODE_ENV: ' production ', BIGMODEL_API_BASE_URL: 'https://bigmodel.cn/',
      BIGMODEL_PRODUCTION_API_BASE_URL: 'https://bigmodel.cn', BIGMODEL_OAUTH_USERINFO_URL: 'https://bigmodel.cn/api/biz/customer/getCustomerInfo',
      ZCODE_BASE_URL: 'https://zcode.z.ai', ZCODE_PRODUCTION_BASE_URL: 'https://zcode.z.ai/',
      ZCODE_ENDPOINT_ORIGIN: 'https://zcode.z.ai', BIGMODEL_TEST_API_BASE_URL: 'https://untrusted.invalid',
    }, secretOverride: false };
  return { ...base, ...changes, selectors: changes.selectors === undefined ? base.selectors : changes.selectors };
}

function runtime(options = {}) {
  let phase = 0;
  return async (command, args, settings) => {
    assert.equal(settings.timeout, 2000);
    if (command === helperPath) {
      const pid = Number(args[0]);
      const change = typeof options.info === 'function' ? options.info(pid, phase) : options.info?.[pid];
      return { stdout: JSON.stringify(info(pid, change)) };
    }
    if (command === 'ps') {
      assert.deepEqual(args, ['-axo', 'pid=,ppid=,comm=']); assert.equal(settings.maxBuffer, 1024 * 1024);
      const ppid = options.parentAt?.[phase] ?? mainPid;
      return { stdout: `${holderPid} ${ppid} ${helperExe}\n` };
    }
    if (command === 'lsof') {
      assert.deepEqual(args, ['-n', '-P', '-b', '-a', '-p', String(holderPid), '-Fpn']); assert.equal(settings.maxBuffer, 1024 * 1024);
      const names = options.namesAt?.[phase] || [tasks]; phase++;
      return { stdout: `p${holderPid}\n${names.map(name => `n${name}\n`).join('')}` };
    }
    throw new Error('unexpected command');
  };
}

async function read(runCommand) {
  return readZcodeRuntimeContext(mainPid, { home, runCommand, helperPath });
}

test('ZCode runtime context accepts only a stable default-root production helper set and returns no paths', async () => {
  const first = await read(runtime()); const second = await read(runtime());
  assert.match(first.fingerprint, /^[a-f0-9]{64}$/); assert.equal(first.fingerprint, second.fingerprint);
  assert.deepEqual(Object.keys(first), ['fingerprint']); assert.doesNotMatch(JSON.stringify(first), /fixture|ZCODE|bigmodel/);
});

test('ZCode runtime helper path points outside app.asar when packaged', () => {
  assert.equal(defaultHelperPath('/Applications/AI Watch.app/Contents/Resources/app.asar/electron'),
    '/Applications/AI Watch.app/Contents/Resources/app.asar.unpacked/electron/native/bin/zcode-process-context');
});

test('ZCode runtime context rejects custom data roots, test/unknown environments, secret override and non-production URLs', async () => {
  const base = info(holderPid).selectors;
  for (const selectors of [
    { ...base, ZCODE_DATA_BASE_DIR: '/other' }, { ...base, HOME: '/other' }, { ...base, ZCODE_ENV: 'test' },
    { ...base, ZCODE_ENV: 'unknown' }, { ...base, BIGMODEL_API_BASE_URL: 'https://other.invalid' },
    { ...base, BIGMODEL_OAUTH_USERINFO_URL: 'https://bigmodel.cn/other' }, { ...base, ZCODE_BASE_URL: 'https://other.invalid' },
  ]) await assert.rejects(read(runtime({ info: { [holderPid]: { selectors } } })), { code: 'unsupported' });
  await assert.rejects(read(runtime({ info: { [holderPid]: { secretOverride: true } } })), { code: 'unsupported' });
  await assert.rejects(read(runtime({ info: { [holderPid]: { selectors: { ...base, HOME: '  ' } } } })), { code: 'unsupported' });
  const blanks = { ...base, USERPROFILE: '  ', ZCODE_DESKTOP_HOME_DIR: '', ZCODE_DATA_BASE_DIR: '   ' };
  assert.match((await read(runtime({ info: { [holderPid]: { selectors: blanks } } }))).fingerprint, /^[a-f0-9]{64}$/);
});

test('ZCode runtime context treats test API selectors as irrelevant only under production', async () => {
  const selectors = { ...info(holderPid).selectors, BIGMODEL_TEST_API_BASE_URL: 'https://other.invalid/path?x=1' };
  assert.match((await read(runtime({ info: { [holderPid]: { selectors } } }))).fingerprint, /^[a-f0-9]{64}$/);
});

test('ZCode runtime context fails closed for malformed helper output, UID/executable errors and command failures', async () => {
  const invalid = async () => ({ stdout: '{not json' });
  await assert.rejects(read(invalid), { code: 'unavailable' });
  for (const change of [{ uid: uid + 1 }, { executable: '/bin/zcode' }, { startMicros: -1 }]) {
    await assert.rejects(read(runtime({ info: { [holderPid]: change } })), { code: 'unavailable' });
  }
  await assert.rejects(read(async () => { throw new Error('PRIVATE STDERR'); }), error => error instanceof ZcodeRuntimeContextError && error.code === 'unavailable' && !error.message.includes('PRIVATE'));
});

test('ZCode runtime context rejects missing evidence, parent changes and competing data roots', async () => {
  await assert.rejects(read(runtime({ namesAt: [[], []] })), { code: 'unavailable' });
  await assert.rejects(read(runtime({ parentAt: [mainPid, 999] })), { code: 'unavailable' });
  await assert.rejects(read(runtime({ namesAt: [[tasks, '/other/.zcode/v2/tasks-index.sqlite'], [tasks, '/other/.zcode/v2/tasks-index.sqlite']] })), { code: 'unsupported' });
});

test('ZCode runtime context rejects truncated and oversized helper output without exposing it', async () => {
  const truncated = async () => ({ stdout: '{"pid":4100' });
  const oversized = async () => ({ stdout: 'x'.repeat(16 * 1024 + 1) });
  for (const runCommand of [truncated, oversized]) {
    await assert.rejects(read(runCommand), { code: 'unavailable' });
  }
});
