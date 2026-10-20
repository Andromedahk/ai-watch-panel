'use strict';

const { execFileSync } = require('node:child_process');
const {
  cpSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { join } = require('node:path');
const { Arch } = require('builder-util');

function fail(message) {
  throw new Error(`Widget afterPack: ${message}`);
}

function validateSigningEnvironment() {
  const teamIdentifier = process.env.AI_WATCH_APPLE_TEAM_ID;
  const identity = process.env.CSC_NAME;
  if (!/^[A-Z0-9]{10}$/.test(teamIdentifier || '')) {
    fail('AI_WATCH_APPLE_TEAM_ID must be exactly 10 uppercase letters or digits');
  }
  if (typeof identity !== 'string' || !/^[A-Fa-f0-9]{40}$/.test(identity.trim())) {
    fail('CSC_NAME must be the signing certificate 40-character SHA-1 fingerprint');
  }
  return { teamIdentifier, identity: identity.trim().toUpperCase() };
}

module.exports = async function widgetAfterPack(context) {
  if (context.electronPlatformName !== 'darwin') {
    fail('the hook is macOS-only');
  }

  const repository = context.packager.projectDir;
  const artifacts = join(repository, '.local', 'widgets');
  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = join(context.appOutDir, appName);
  const contents = join(appPath, 'Contents');
  const sourceExtension = join(artifacts, 'AIWatchWidgets.appex');
  const sourceAddon = join(artifacts, 'widget-bridge.node');
  const sourceLibrary = join(artifacts, 'libAIWatchWidgetBridge.dylib');
  for (const source of [sourceExtension, sourceAddon, sourceLibrary]) {
    if (!existsSync(source)) fail(`missing build artifact ${source.slice(repository.length + 1)}`);
  }

  const plugins = join(contents, 'PlugIns');
  const widgetResources = join(contents, 'Resources', 'widgets');
  const destinationExtension = join(plugins, 'AIWatchWidgets.appex');
  mkdirSync(plugins, { recursive: true });
  mkdirSync(widgetResources, { recursive: true });
  rmSync(destinationExtension, { recursive: true, force: true });
  cpSync(sourceExtension, destinationExtension, { recursive: true });
  cpSync(sourceAddon, join(widgetResources, 'widget-bridge.node'));
  cpSync(sourceLibrary, join(widgetResources, 'libAIWatchWidgetBridge.dylib'));

  const architecture = Arch[context.arch];
  const clangArchitecture = architecture === 'x64' ? 'x86_64' : architecture;
  if (!['arm64', 'x86_64'].includes(clangArchitecture)) {
    fail(`unsupported electron-builder architecture ${architecture}`);
  }
  for (const binary of [
    join(destinationExtension, 'Contents', 'MacOS', 'AIWatchWidgets'),
    join(widgetResources, 'widget-bridge.node'),
    join(widgetResources, 'libAIWatchWidgetBridge.dylib'),
  ]) {
    execFileSync('lipo', [binary, '-verify_arch', clangArchitecture], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  }

  if (process.env.AI_WATCH_SIGN_WIDGETS === '1') {
    const { identity } = validateSigningEnvironment();
    const entitlements = join(artifacts, 'generated', 'Widget.entitlements.plist');
    if (!existsSync(entitlements)) fail('missing generated widget entitlements');
    execFileSync('codesign', [
      '--force',
      '--sign', identity,
      '--options', 'runtime',
      '--timestamp',
      '--entitlements', entitlements,
      destinationExtension,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    execFileSync('codesign', [
      '--verify',
      '--strict',
      destinationExtension,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
  }

  writeFileSync(join(artifacts, 'pack-result.json'), JSON.stringify({
    appPath,
    architecture,
  }), { mode: 0o600 });
};
