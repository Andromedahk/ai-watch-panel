const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { ProviderLauncher, validateExecutable, discoverMacApp } = require('../electron/provider-launcher.cjs');
const { PROVIDER_ORDER } = require('../electron/window-policy.cjs');

async function temp(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-watch-launcher-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
async function macApp(root, name) {
  const file = path.join(root, `${name}.app`);
  await fs.mkdir(path.join(file, 'Contents', 'MacOS'), { recursive: true });
  await fs.writeFile(path.join(file, 'Contents', 'MacOS', 'App'), 'fake binary', { mode: 0o755 });
  await fs.writeFile(path.join(file, 'Contents', 'Info.plist'), 'fake plist');
  return file;
}

test('only the eight known provider IDs are accepted before touching launch dependencies', async () => {
  let calls = 0;
  const launcher = new ProviderLauncher({ discover: async () => { calls++; }, open: async () => { calls++; } });
  for (const id of [null, undefined, {}, ['codex'], '', 'other', '__proto__', 'codex; touch nope', '/Applications/Codex.app']) {
    await assert.rejects(launcher.launch(id), /Invalid provider/);
    await assert.rejects(launcher.choose(id, async () => { calls++; }, () => { calls++; }), /Invalid provider/);
  }
  assert.equal(calls, 0);
});

test('fixture profiles simulate every provider without filesystem, picker, persistence or launch effects', async () => {
  const forbidden = () => { throw new Error('fixture side effect'); };
  const launcher = new ProviderLauncher({ fixtureMode: true, discover: forbidden, validate: forbidden, open: forbidden });
  for (const id of PROVIDER_ORDER) {
    assert.equal((await launcher.launch(id, '/private/fake.app')).status, 'test');
    const choice = await launcher.choose(id, forbidden, forbidden);
    assert.equal(choice.status, 'selected');
    assert.match(choice.message, /测试模式/);
  }
});

test('discovery uses bundle identity so renamed official apps are found and impostor names are skipped', async t => {
  const root = await temp(t);
  const impostor = await macApp(root, 'Codex');
  const official = await macApp(root, 'ChatGPT');
  const plist = async (file, key) => key === 'CFBundleExecutable' ? 'App' : file.startsWith(official) ? 'com.openai.codex' : 'com.other.app';
  assert.equal(await discoverMacApp('codex', { roots: [root], plist }), await fs.realpath(official));
  assert.notEqual(await discoverMacApp('codex', { roots: [root], plist }), impostor);
  assert.equal(await discoverMacApp('kimi', { roots: [root], plist }), null);
});

test('discovery supports category folders but ignores broken or nested application bundles', async t => {
  const root = await temp(t);
  const broken = path.join(root, 'Broken.app');
  await fs.mkdir(broken);
  const category = path.join(root, 'Tools');
  const nested = await macApp(category, 'Actual');
  const plist = async (file, key) => { if (file.startsWith(broken)) throw new Error('bad plist'); return key === 'CFBundleExecutable' ? 'App' : 'com.deepseek.dsh'; };
  assert.equal(await discoverMacApp('deepseek', { roots: [path.join(root, 'absent'), root], plist }), await fs.realpath(nested));
});

test('mac selection accepts a real app bundle and rejects non-app paths and unsafe executable names', async t => {
  const root = await temp(t);
  const app = await macApp(root, 'Chosen');
  assert.equal(await validateExecutable(app, 'darwin', fs, async () => 'App'), await fs.realpath(app));
  for (const bad of ['relative.app', 'https://example.invalid/app', `${app}\0`, root]) assert.equal(await validateExecutable(bad, 'darwin', fs, async () => 'App'), null);
  for (const bad of ['../../payload', '..', '.', 'a/b', 'a\\b', '']) assert.equal(await validateExecutable(app, 'darwin', fs, async () => bad), null);
  await fs.chmod(path.join(app, 'Contents', 'MacOS', 'App'), 0o644);
  assert.equal(await validateExecutable(app, 'darwin', fs, async () => 'App'), null);
});

test('prepared Windows and Linux selection accepts executable formats rather than scripts or URLs', async t => {
  const root = await temp(t);
  const exe = path.join(root, 'Client.exe');
  const elf = path.join(root, 'Client.AppImage');
  const script = path.join(root, 'script.sh');
  await fs.writeFile(exe, 'MZ');
  await fs.writeFile(elf, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1]), { mode: 0o755 });
  await fs.writeFile(script, '#!/bin/sh\nexit 0', { mode: 0o755 });
  assert.equal(await validateExecutable(exe, 'win32'), await fs.realpath(exe));
  assert.equal(await validateExecutable(script, 'win32'), null);
  assert.equal(await validateExecutable(elf, 'linux'), await fs.realpath(elf));
  assert.equal(await validateExecutable(script, 'linux'), null);
  await fs.chmod(elf, 0o644);
  assert.equal(await validateExecutable(elf, 'linux'), null);
  assert.equal(await validateExecutable(exe, 'other'), null);
});

test('custom selections take priority and a missing selected app does not launch an unexpected fallback', async () => {
  let discovered = 0; const opened = [];
  const launcher = new ProviderLauncher({ platform: 'darwin', validate: async file => file === '/chosen.app' ? file : null,
    discover: async () => { discovered++; return '/auto.app'; }, open: async file => opened.push(file) });
  assert.equal((await launcher.launch('codex', '/chosen.app')).status, 'opened');
  assert.equal((await launcher.launch('codex', '/deleted.app')).status, 'missing');
  assert.equal(discovered, 0);
  assert.deepEqual(opened, ['/chosen.app']);
});

test('rapid repeated clicks share in-flight and recent launches but allow reopening later', async () => {
  let count = 0; let release; let now = 1000;
  const pause = new Promise(resolve => { release = resolve; });
  const launcher = new ProviderLauncher({ platform: 'darwin', now: () => now, discover: async () => '/found.app', open: async () => { count++; await pause; } });
  const one = launcher.launch('codex'); const two = launcher.launch('codex');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(count, 1);
  release();
  assert.deepEqual(await one, await two);
  await launcher.launch('codex'); assert.equal(count, 1);
  now += 2001;
  await launcher.launch('codex'); assert.equal(count, 2);
});

test('launch errors do not expose filesystem paths or retain a failed attempt forever', async () => {
  let calls = 0;
  const launcher = new ProviderLauncher({ platform: 'darwin', discover: async () => '/private/secret.app', open: async () => { calls++; if (calls === 1) throw new Error('/private/secret.app permission'); } });
  const first = await launcher.launch('claude');
  assert.equal(first.status, 'error'); assert.doesNotMatch(first.message, /private|secret/);
  assert.equal((await launcher.launch('claude')).status, 'opened');
  const unsupported = new ProviderLauncher({ platform: 'other' });
  assert.equal((await unsupported.launch('claude')).status, 'unsupported');
});

test('unknown desktop sources return actionable missing feedback instead of guessing commands', async () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    const launcher = new ProviderLauncher({ platform, discover: async () => null, open: async () => { throw new Error('must not open'); } });
    const result = await launcher.launch('kimi');
    assert.equal(result.status, 'missing'); assert.match(result.message, /设置中选择启动应用/);
  }
});

test('native selection validates first, persists only the canonical path and never opens the selected app', async () => {
  const saved = []; let opened = 0;
  const launcher = new ProviderLauncher({ platform: 'darwin', validate: async file => file === '/picked.app' ? '/canonical.app' : null, open: async () => { opened++; } });
  const result = await launcher.choose('zcode', async options => {
    assert.deepEqual(options.filters, [{ name: '应用', extensions: ['app'] }]);
    return { canceled: false, filePaths: ['/picked.app'] };
  }, (id, file) => saved.push([id, file]));
  assert.equal(result.status, 'selected');
  assert.deepEqual(saved, [['zcode', '/canonical.app']]);
  assert.equal(opened, 0); assert.doesNotMatch(result.message, /canonical|picked/);
});

test('cancelled, invalid and failed native choices never leak paths or silently persist', async () => {
  const saved = [];
  const launcher = new ProviderLauncher({ platform: 'darwin', validate: async () => null });
  const save = (...args) => saved.push(args);
  assert.equal((await launcher.choose('kimi', async () => ({ canceled: true }), save)).status, 'cancelled');
  assert.equal((await launcher.choose('kimi', async () => ({ canceled: false, filePaths: [] }), save)).status, 'error');
  assert.equal((await launcher.choose('kimi', async () => ({ canceled: false, filePaths: ['/private/invalid'] }), save)).status, 'error');
  assert.equal((await launcher.choose('kimi', async () => { throw new Error('/private/secret'); }, save)).status, 'error');
  assert.deepEqual(saved, []);
  const valid = new ProviderLauncher({ platform: 'darwin', validate: async () => '/valid.app' });
  const result = await valid.choose('kimi', async () => ({ canceled: false, filePaths: ['/picked.app'] }), () => { throw new Error('/private/preferences.json'); });
  assert.equal(result.status, 'error'); assert.doesNotMatch(result.message, /private|picked|preferences/);
});

test('Kimi Work discovery uses its identity only when explicitly selected', async t => {
  const root = await temp(t);
  const work = await macApp(root, 'Kimi');
  const impostor = await macApp(root, 'KimiWork');
  const plist = async (file, key) => key === 'CFBundleExecutable' ? 'App' : file.startsWith(work) ? 'com.moonshot.kimichat' : 'com.other.app';
  assert.equal(await discoverMacApp('kimi', { roots: [root], plist, kimiSource: 'work' }), await fs.realpath(work));
  assert.equal(await discoverMacApp('kimi', { roots: [root], plist, kimiSource: 'code' }), null);
  assert.notEqual(await discoverMacApp('kimi', { roots: [root], plist, kimiSource: 'work' }), impostor);
  const sources = [];
  const launcher = new ProviderLauncher({ platform: 'darwin', discover: async (id, source) => { sources.push(source); return source === 'work' ? work : null; }, open: async () => {} });
  assert.match((await launcher.launch('kimi', null, 'work')).message, /Kimi Work/);
  assert.equal((await launcher.launch('kimi', null, 'code')).status, 'missing');
  assert.deepEqual(sources, ['work', 'code']);
});
