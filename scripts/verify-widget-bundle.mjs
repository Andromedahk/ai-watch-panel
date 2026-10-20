import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') throw new Error('Widget bundle checks require macOS');
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const hook = require('./widget-after-pack.cjs');
const { Arch } = require('builder-util');
const resultFile = join(repository, '.local', 'widgets', 'pack-result.json');
const previousResult = existsSync(resultFile) ? readFileSync(resultFile) : null;
const destination = mkdtempSync(join(repository, '.local', 'widget layout check '));
const previousSigning = process.env.AI_WATCH_SIGN_WIDGETS;
try {
  // Exercise the real copy/architecture hook without signing, registration or installation.
  delete process.env.AI_WATCH_SIGN_WIDGETS;
  await hook({ electronPlatformName: 'darwin', arch: process.arch === 'arm64' ? Arch.arm64 : Arch.x64,
    appOutDir: destination, packager: { projectDir: repository, appInfo: { productFilename: 'AI Watch' } } });
  const appPath = join(destination, 'AI Watch.app');
  for (const file of ['PlugIns/AIWatchWidgets.appex/Contents/Info.plist', 'Resources/widgets/widget-bridge.node',
    'Resources/widgets/libAIWatchWidgetBridge.dylib']) assert.ok(existsSync(join(appPath, 'Contents', file)), file);
  assert.deepEqual(JSON.parse(readFileSync(resultFile, 'utf8')), { appPath, architecture: process.arch });
  console.log('Unsigned bundle layout and architecture hook passed, including paths containing spaces.');
} finally {
  if (previousSigning === undefined) delete process.env.AI_WATCH_SIGN_WIDGETS;
  else process.env.AI_WATCH_SIGN_WIDGETS = previousSigning;
  if (previousResult) writeFileSync(resultFile, previousResult, { mode: 0o600 });
  else rmSync(resultFile, { force: true });
  rmSync(destination, { recursive: true, force: true });
}
