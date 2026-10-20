const fs = require('node:fs/promises');
const path = require('node:path');

// Only regenerable Chromium cache directories in this application's own profile.
// Account data, Local Storage, Preferences and the Claude plan cache are excluded.
const DISK_CACHE_DIRECTORIES = Object.freeze([
  'GPUCache', 'Code Cache', 'DawnCache', 'DawnGraphiteCache', 'GraphiteDawnCache',
  'DawnWebGPUCache', 'GPUPersistentCache', 'GrShaderCache', 'ShaderCache',
]);
async function profileRoot(userData, io) {
  if (typeof userData !== 'string' || !path.isAbsolute(userData) || userData.includes('\0')) throw new Error('Invalid application profile');
  const stat = await io.lstat(userData);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid application profile');
  return io.realpath(userData);
}
function allocatedBytes(stat) {
  return typeof stat.blocks === 'number' ? stat.blocks * 512 : stat.size;
}
async function directorySize(directory, io, maxEntries = 10000) {
  const pending = [directory]; let bytes = 0, entries = 0;
  while (pending.length) {
    const current = pending.pop(), stat = await io.lstat(current);
    if (stat.isSymbolicLink()) continue;
    bytes += allocatedBytes(stat);
    if (!stat.isDirectory()) continue;
    const children = await io.readdir(current, { withFileTypes: true });
    for (const child of children) {
      if (++entries > maxEntries) return { bytes, complete: false };
      if (!child.isSymbolicLink()) pending.push(path.join(current, child.name));
    }
  }
  return { bytes, complete: true };
}
async function cacheCandidate(root, name, io) {
  const file = path.join(root, name);
  try {
    const stat = await io.lstat(file);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return { name, skipped: true };
    if (await io.realpath(file) !== file) return { name, skipped: true };
    return { name, file, stat, ...(await directorySize(file, io)) };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    return { name, failed: true };
  }
}
async function previewStartupDiskCaches({ userData, io = fs } = {}) {
  const root = await profileRoot(userData, io), entries = [];
  for (const name of DISK_CACHE_DIRECTORIES) {
    const candidate = await cacheCandidate(root, name, io);
    if (!candidate) continue;
    // Paths and filenames inside caches never cross the preload bridge.
    entries.push({ name, bytes: candidate.bytes || 0, complete: candidate.complete === true,
      skipped: candidate.skipped === true, failed: candidate.failed === true });
  }
  return { bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0), entries };
}

/** Call before constructing BrowserWindow, once the previous app has exited. */
async function clearStartupDiskCaches({ userData, io = fs } = {}) {
  const root = await profileRoot(userData, io);
  const result = { cleared: [], skipped: [], failed: [], estimatedBytes: 0 };
  for (const name of DISK_CACHE_DIRECTORIES) {
    const candidate = await cacheCandidate(root, name, io);
    if (!candidate) continue;
    if (candidate.skipped) { result.skipped.push(name); continue; }
    if (candidate.failed) { result.failed.push(name); continue; }
    try {
      const current = await io.lstat(candidate.file);
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== candidate.stat.dev || current.ino !== candidate.stat.ino
        || await io.realpath(candidate.file) !== candidate.file) { result.skipped.push(name); continue; }
      await io.rm(candidate.file, { recursive: true, force: false });
      result.cleared.push(name);
      result.estimatedBytes += candidate.bytes;
    } catch { result.failed.push(name); }
  }
  return result;
}

/** Clear live session caches through Electron, without resetting stored user data. */
async function clearSessionCaches({ session } = {}) {
  const result = { cleared: [], failed: [], freedBytes: 0 };
  let before = 0;
  try { before = await session.getCacheSize(); } catch { /* Older sessions may not report size. */ }
  for (const [name, method, args] of [
    ['http', 'clearCache', []],
    ['code', 'clearCodeCaches', [{ urls: [] }]],
    ['shader-and-resource', 'clearStorageData', [{ storages: ['shadercache', 'cachestorage'] }]],
  ]) {
    try {
      if (typeof session?.[method] !== 'function') throw new Error('Cache operation unavailable');
      await session[method](...args);
      result.cleared.push(name);
    } catch { result.failed.push(name); }
  }
  try { result.freedBytes = Math.max(0, before - await session.getCacheSize()); } catch { /* Size reporting is optional. */ }
  return result;
}
module.exports = { DISK_CACHE_DIRECTORIES, previewStartupDiskCaches, clearStartupDiskCaches, clearSessionCaches };
