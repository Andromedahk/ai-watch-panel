const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawn, spawnSync } = require('node:child_process');
const { promisify } = require('node:util');
const { once } = require('node:events');

const execute = promisify(execFile);
const isMac = process.platform === 'darwin';
const repository = path.resolve(__dirname, '..');
const source = path.join(repository, 'electron', 'native', 'zcode-process-context.c');
let directory;
let parser;
let production;

test.before(async () => {
  if (!isMac) return;
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-watch-zcode-native-'));
  parser = path.join(directory, 'parse-context');
  production = path.join(directory, 'process-context');
  const warnings = ['-O2', '-Wall', '-Wextra', '-Werror'];
  await execute('clang', [...warnings, '-DZCODE_CONTEXT_TEST', source, '-o', parser, '-lproc']);
  await execute('clang', [...warnings, source, '-o', production, '-lproc']);
});

test.after(async () => {
  if (directory) await fs.rm(directory, { recursive: true, force: true });
});

function field(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
  return Buffer.concat([bytes, Buffer.from([0])]);
}

function procargs({ executable = '/synthetic/ZCode', argv = ['/synthetic/ZCode'], env = [], argc = argv.length,
  padding = 2, trailing = 0 } = {}) {
  const count = Buffer.alloc(4); count.writeInt32LE(argc);
  return Buffer.concat([count, field(executable), Buffer.alloc(padding), ...argv.map(field), ...env.map(field), Buffer.alloc(trailing)]);
}

function parse(block) {
  const result = spawnSync(parser, [], { input: block, maxBuffer: 64 * 1024 });
  const stdout = result.stdout.toString('utf8'); const stderr = result.stderr.toString('utf8');
  return { ...result, stdout, stderr, json: stdout ? JSON.parse(stdout) : null };
}

test('ZCode native parser preserves allowed empty, spaces, equals and Unicode values', { skip: !isMac }, () => {
  const result = parse(procargs({ env: [
    'HOME=', 'ZCODE_DATA_BASE_DIR=/tmp/a path/with=value', 'ZCODE_ENV= PRODUCTION ',
    'BIGMODEL_API_BASE_URL=https://例子.invalid/a=b', 'NOT_ALLOWED=PRIVATE_NON_ALLOWLIST',
  ] }));
  assert.equal(result.status, 0); assert.equal(result.stderr, '');
  assert.deepEqual(result.json, { selectors: {
    HOME: '', ZCODE_DATA_BASE_DIR: '/tmp/a path/with=value', ZCODE_ENV: ' PRODUCTION ',
    BIGMODEL_API_BASE_URL: 'https://例子.invalid/a=b',
  }, secretOverride: false });
  assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_NON_ALLOWLIST/);
  assert.ok(result.stdout.length <= 16 * 1024);
});

test('ZCode native parser omits argv, executable, non-allowlist and secret values', { skip: !isMac }, () => {
  const sentinels = ['PRIVATE_EXECUTABLE', 'PRIVATE_ARGV', 'PRIVATE_ENV', 'PRIVATE_SECRET'];
  const result = parse(procargs({ executable: `/synthetic/${sentinels[0]}`, argv: [sentinels[0], sentinels[1]],
    env: [`NOT_ALLOWED=${sentinels[2]}`, `ZCODE_CREDENTIAL_SECRET=${sentinels[3]}`, 'USERPROFILE=/synthetic/user'] }));
  assert.equal(result.status, 0); assert.deepEqual(result.json, { selectors: { USERPROFILE: '/synthetic/user' }, secretOverride: true });
  for (const sentinel of sentinels) assert.doesNotMatch(result.stdout + result.stderr, new RegExp(sentinel));

  const empty = parse(procargs({ env: ['ZCODE_CREDENTIAL_SECRET='] }));
  assert.equal(empty.status, 0); assert.equal(empty.json.secretOverride, false);
});

test('ZCode native parser rejects duplicate selected and secret keys without leaking values', { skip: !isMac }, () => {
  for (const env of [
    ['HOME=/one', 'HOME=/two'],
    ['ZCODE_CREDENTIAL_SECRET=PRIVATE_ONE', 'ZCODE_CREDENTIAL_SECRET=PRIVATE_TWO'],
  ]) {
    const result = parse(procargs({ env }));
    assert.notEqual(result.status, 0); assert.deepEqual(result.json, { error: 'duplicate' }); assert.equal(result.stderr, '');
    assert.doesNotMatch(result.stdout + result.stderr, /\/one|\/two|PRIVATE_ONE|PRIVATE_TWO/);
  }
});

test('ZCode native parser rejects malformed, truncated, non-UTF8 and oversized blocks', { skip: !isMac }, () => {
  const truncated = procargs({ env: ['HOME=/private/truncated'] }).subarray(0, -1);
  const invalidUtf8 = procargs({ env: [Buffer.concat([Buffer.from('HOME='), Buffer.from([0xff])])] });
  const cases = [
    [procargs({ argc: 2 }), 'format'],
    [truncated, 'format'],
    [invalidUtf8, 'format'],
    [procargs({ env: [`HOME=${'x'.repeat(4097)}`] }), 'value'],
    [procargs({ env: [`NOT_ALLOWED=${'y'.repeat(4097)}`] }), 'value'],
  ];
  for (const [block, code] of cases) {
    const result = parse(block); assert.notEqual(result.status, 0); assert.deepEqual(result.json, { error: code }); assert.equal(result.stderr, '');
    assert.doesNotMatch(result.stdout + result.stderr, /truncated|x{20}|y{20}/);
  }
  const tooLarge = parse(Buffer.alloc(1024 * 1024 + 1, 65));
  assert.notEqual(tooLarge.status, 0); assert.deepEqual(tooLarge.json, { error: 'size' });
});

test('ZCode native parser refuses a success JSON larger than sixteen KiB', { skip: !isMac }, () => {
  const value = 'z'.repeat(4096);
  const result = parse(procargs({ env: [`HOME=${value}`, `USERPROFILE=${value}`, `ZCODE_DATA_BASE_DIR=${value}`, `ZCODE_ENV=${value}`] }));
  assert.notEqual(result.status, 0); assert.deepEqual(result.json, { error: 'output' }); assert.equal(result.stderr, '');
  assert.ok(result.stdout.length <= 16 * 1024); assert.doesNotMatch(result.stdout, /z{20}/);
});

test('ZCode production helper reads only a controlled same-user child context', { skip: !isMac }, async t => {
  const child = spawn(process.execPath, ['-e', "process.stdout.write('ready\\n');setInterval(()=>{},1000)", 'PRIVATE_ARGV_SENTINEL'], {
    env: {
      PATH: process.env.PATH || '/usr/bin:/bin',
      HOME: '/tmp/synthetic-zcode-home',
      ZCODE_ENV: 'production',
      ZCODE_DATA_BASE_DIR: '/tmp/synthetic-zcode-home',
      BIGMODEL_API_BASE_URL: 'https://synthetic.invalid',
      ZCODE_CREDENTIAL_SECRET: 'PRIVATE_SECRET_SENTINEL',
      NOT_ALLOWED: 'PRIVATE_ENV_SENTINEL',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { if (!child.killed) child.kill('SIGKILL'); });
  const [ready] = await once(child.stdout, 'data'); assert.match(ready.toString('utf8'), /ready/);
  const result = await execute(production, [String(child.pid)], { timeout: 5000, maxBuffer: 64 * 1024 });
  assert.equal(result.stderr, ''); assert.ok(result.stdout.length <= 16 * 1024);
  for (const sentinel of ['PRIVATE_ARGV_SENTINEL', 'PRIVATE_SECRET_SENTINEL', 'PRIVATE_ENV_SENTINEL']) {
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(sentinel));
  }
  const value = JSON.parse(result.stdout);
  assert.equal(value.pid, child.pid); assert.equal(value.uid, process.getuid()); assert.equal(value.ppid, process.pid);
  assert.ok(Number.isInteger(value.startSeconds) && value.startSeconds > 0);
  assert.ok(Number.isInteger(value.startMicros) && value.startMicros >= 0);
  assert.ok(path.isAbsolute(value.executable));
  assert.deepEqual(value.selectors, {
    HOME: '/tmp/synthetic-zcode-home', ZCODE_DATA_BASE_DIR: '/tmp/synthetic-zcode-home', ZCODE_ENV: 'production',
    BIGMODEL_API_BASE_URL: 'https://synthetic.invalid',
  });
  assert.equal(value.secretOverride, true);
});

test('ZCode production helper rejects non-integer pid arguments with fixed output', { skip: !isMac }, () => {
  const result = spawnSync(production, ['1x'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0); assert.equal(result.stderr, ''); assert.deepEqual(JSON.parse(result.stdout), { error: 'args' });
});
