const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { DISK_CACHE_DIRECTORIES, previewStartupDiskCaches, clearStartupDiskCaches, clearSessionCaches } = require('../electron/app-cache.cjs');

test('session cleanup reports freed HTTP bytes without exposing storage data', async () => {
  let size = 4096;
  const result = await clearSessionCaches({ session: {
    getCacheSize: async () => size, clearCache: async () => { size = 1024; },
    clearCodeCaches: async () => {}, clearStorageData: async options => assert.deepEqual(options.storages, ['shadercache', 'cachestorage']),
  } });
  assert.equal(result.freedBytes, 3072); assert.deepEqual(result.failed, []);
});
async function profile(run) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-watch-cache-test-'));
  try { await run(temporary); } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}
test('live session clearing specifies cache types and never clears account or image storage', async () => {
  const calls = []; const session = Object.fromEntries(['clearCache', 'clearCodeCaches', 'clearStorageData'].map(name =>
    [name, async (...args) => calls.push([name, args])]));
  const result = await clearSessionCaches({ session });
  assert.deepEqual(result.failed, []); assert.equal(result.cleared.length, 3);
  assert.deepEqual(calls, [['clearCache', []], ['clearCodeCaches', [{ urls: [] }]],
    ['clearStorageData', [{ storages: ['shadercache', 'cachestorage'] }]]]);
});
test('cache API failures do not trigger broad storage reset or stop other cache operations', async () => {
  const calls = []; const session = { clearCache: async () => { throw new Error('Busy'); },
    clearCodeCaches: async options => calls.push(options), clearStorageData: async options => calls.push(options) };
  const result = await clearSessionCaches({ session });
  assert.deepEqual(result.failed, ['http']); assert.equal(calls.length, 2);
  assert.deepEqual((await clearSessionCaches()).failed, ['http', 'code', 'shader-and-resource']);
});
test('startup cache cleanup removes only regenerable exact directories and preserves protected data', async () => {
  await profile(async root => {
    for (const name of ['GPUCache', 'Code Cache', 'DawnGraphiteCache', 'GraphiteDawnCache']) {
      await fs.mkdir(path.join(root, name)); await fs.writeFile(path.join(root, name, 'cache-entry'), 'CACHE');
    }
    for (const name of ['preferences.json', 'Preferences', 'Local State', 'claude-desktop-plan.json']) await fs.writeFile(path.join(root, name), 'KEEP');
    for (const name of ['Local Storage', 'Session Storage', 'provider-apps', 'GPUCache-backup']) {
      await fs.mkdir(path.join(root, name)); await fs.writeFile(path.join(root, name, 'data'), 'KEEP');
    }
    const before = await previewStartupDiskCaches({ userData: root }); assert.ok(before.bytes > 0); assert.equal(before.entries.length, 4);
    assert.ok(!JSON.stringify(before).includes(root));
    const result = await clearStartupDiskCaches({ userData: root }); assert.equal(result.cleared.length, 4); assert.deepEqual(result.failed, []);
    assert.equal((await previewStartupDiskCaches({ userData: root })).bytes, 0);
    for (const name of ['preferences.json', 'Preferences', 'Local State', 'claude-desktop-plan.json']) assert.equal(await fs.readFile(path.join(root, name), 'utf8'), 'KEEP');
    for (const name of ['Local Storage', 'Session Storage', 'provider-apps', 'GPUCache-backup']) assert.equal(await fs.readFile(path.join(root, name, 'data'), 'utf8'), 'KEEP');
  });
});
test('preview does not delete caches and cleanup can be repeated', async () => {
  await profile(async root => {
    await fs.mkdir(path.join(root, 'DawnWebGPUCache')); await fs.writeFile(path.join(root, 'DawnWebGPUCache', 'entry'), 'cache');
    await previewStartupDiskCaches({ userData: root }); assert.equal(await fs.readFile(path.join(root, 'DawnWebGPUCache', 'entry'), 'utf8'), 'cache');
    await clearStartupDiskCaches({ userData: root }); assert.deepEqual((await clearStartupDiskCaches({ userData: root })).cleared, []);
  });
});
test('symlink caches, symlink profile and non-directory cache names are not followed', async () => {
  await profile(async temporary => {
    const root = path.join(temporary, 'profile'), other = path.join(temporary, 'protected'); await fs.mkdir(root); await fs.mkdir(other);
    await fs.writeFile(path.join(other, 'important'), 'KEEP'); await fs.symlink(other, path.join(root, 'GPUCache'), 'dir');
    await fs.writeFile(path.join(root, 'Code Cache'), 'KEEP');
    const result = await clearStartupDiskCaches({ userData: root }); assert.deepEqual(result.skipped.sort(), ['Code Cache', 'GPUCache']);
    assert.equal(await fs.readFile(path.join(other, 'important'), 'utf8'), 'KEEP'); assert.equal(await fs.readFile(path.join(root, 'Code Cache'), 'utf8'), 'KEEP');
    await fs.symlink(root, path.join(temporary, 'profile-link'), 'dir');
    await assert.rejects(clearStartupDiskCaches({ userData: path.join(temporary, 'profile-link') }), /Invalid application profile/);
  });
});
test('cache content symlinks do not delete their external targets', async () => {
  await profile(async root => {
    const target = path.join(root, 'image.png'), cache = path.join(root, 'GPUCache');
    await fs.writeFile(target, 'KEEP'); await fs.mkdir(cache); await fs.symlink(target, path.join(cache, 'image-link'));
    await clearStartupDiskCaches({ userData: root }); assert.equal(await fs.readFile(target, 'utf8'), 'KEEP');
  });
});
test('invalid profile arguments are rejected before filesystem mutation', async () => {
  for (const userData of [undefined, '', '.', 'relative/profile', 'bad\0profile']) await assert.rejects(clearStartupDiskCaches({ userData }), /Invalid application profile/);
  assert.ok(!DISK_CACHE_DIRECTORIES.some(name => /Local Storage|Preferences|claude|cookies/i.test(name)));
});
test('an identity change between preview and removal is skipped', async () => {
  await profile(async root => {
    const cache = path.join(root, 'GPUCache'); await fs.mkdir(cache); await fs.writeFile(path.join(cache, 'entry'), 'CACHE');
    let checks = 0; const io = { ...fs, lstat: async file => {
      const stat = await fs.lstat(file);
      if (path.basename(file) === 'GPUCache' && ++checks === 3) return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { ino: stat.ino + 1 });
      return stat;
    } };
    const result = await clearStartupDiskCaches({ userData: root, io }); assert.deepEqual(result.skipped, ['GPUCache']);
    assert.equal(await fs.readFile(path.join(cache, 'entry'), 'utf8'), 'CACHE');
  });
});
