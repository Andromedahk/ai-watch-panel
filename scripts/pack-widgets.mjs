import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { arch as hostArch } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Arch, Platform, build } from 'electron-builder';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function fail(message) {
  throw new Error(`Widget packaging: ${message}`);
}

function parseArchitecture(argv) {
  let architecture;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--arch') {
      architecture = argv[++index];
      if (!architecture) fail('--arch requires arm64 or x64');
    } else if (argument.startsWith('--arch=')) {
      architecture = argument.slice('--arch='.length);
    } else {
      fail(`unknown argument ${argument}`);
    }
  }
  architecture ??= process.env.AI_WATCH_WIDGET_ARCH ?? process.env.npm_config_arch ?? hostArch();
  if (!['arm64', 'x64'].includes(architecture)) fail(`unsupported architecture ${architecture}`);
  return architecture;
}

function run(program, args, options = {}) {
  return execFileSync(program, args, {
    cwd: repository,
    env: packagingEnvironment,
    encoding: options.encoding,
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
}

function signedEntitlements(path) {
  return execFileSync('codesign', ['--display', '--entitlements', ':-', path], {
    cwd: repository,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function signingTeam(path) {
  const result = spawnSync('codesign', ['--display', '--verbose=2', path], {
    cwd: repository,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) fail('codesign could not inspect a packaged binary');
  const match = /^TeamIdentifier=([A-Z0-9]{10})$/m.exec(result.stderr);
  if (!match) fail('a packaged binary has no certificate-derived TeamIdentifier');
  return match[1];
}

function plistValue(plist, key, format = 'raw') {
  return execFileSync('plutil', ['-extract', key, format, '-o', '-', '-'], {
    cwd: repository,
    input: plist,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

if (process.platform !== 'darwin') fail('signed widget packaging is macOS-only');

const teamIdentifier = process.env.AI_WATCH_APPLE_TEAM_ID;
const identity = process.env.CSC_NAME;
if (!/^[A-Z0-9]{10}$/.test(teamIdentifier || '')) {
  fail('AI_WATCH_APPLE_TEAM_ID must be exactly 10 uppercase letters or digits');
}
if (typeof identity !== 'string' || !/^[A-Fa-f0-9]{40}$/.test(identity.trim())) {
  fail('CSC_NAME must be the signing certificate 40-character SHA-1 fingerprint');
}
const signingFingerprint = identity.trim().toUpperCase();

const architecture = parseArchitecture(process.argv.slice(2));
const appGroup = `${teamIdentifier}.app.aiwatch.panel`;
const packagingEnvironment = {
  ...process.env,
  AI_WATCH_APP_GROUP: appGroup,
  AI_WATCH_SIGN_WIDGETS: '1',
  AI_WATCH_WIDGET_ARCH: architecture,
};
process.env.AI_WATCH_APP_GROUP = appGroup;
process.env.AI_WATCH_SIGN_WIDGETS = '1';
process.env.AI_WATCH_WIDGET_ARCH = architecture;

const electronDistribution = resolve(
  process.env.AI_WATCH_ELECTRON_DIST || join(repository, 'node_modules', 'electron', 'dist'),
);
const electronExecutable = join(electronDistribution, 'Electron.app', 'Contents', 'MacOS', 'Electron');
if (!existsSync(electronExecutable)) {
  fail('Electron.app is missing; install the project dependencies or set AI_WATCH_ELECTRON_DIST');
}
try {
  run('lipo', [
    electronExecutable,
    '-verify_arch',
    architecture === 'x64' ? 'x86_64' : architecture,
  ], { capture: true });
} catch {
  fail(`the installed Electron.app does not contain the requested ${architecture} architecture`);
}

run(process.env.npm_execpath ? process.execPath : 'npm', process.env.npm_execpath
  ? [process.env.npm_execpath, 'run', 'build']
  : ['run', 'build']);
run(process.execPath, [join(repository, 'scripts', 'build-widgets.mjs'), '--arch', architecture, '--check']);

const packageMetadata = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8'));
const existing = packageMetadata.build || {};
const existingMac = existing.mac || {};
const existingExtendInfo = existingMac.extendInfo || {};
const existingURLTypes = Array.isArray(existingExtendInfo.CFBundleURLTypes)
  ? existingExtendInfo.CFBundleURLTypes
  : [];
const hasAIWatchScheme = existingURLTypes.some((entry) =>
  Array.isArray(entry?.CFBundleURLSchemes) && entry.CFBundleURLSchemes.includes('aiwatch'));
const artifacts = join(repository, '.local', 'widgets');
const generated = join(artifacts, 'generated');
const packResult = join(artifacts, 'pack-result.json');
rmSync(packResult, { force: true });
const configuration = {
  ...existing,
  forceCodeSigning: true,
  electronDist: electronDistribution,
  afterPack: join(repository, 'scripts', 'widget-after-pack.cjs'),
  mac: {
    ...existingMac,
    identity: signingFingerprint,
    entitlements: join(generated, 'Main.entitlements.plist'),
    entitlementsInherit: join(generated, 'Main.inherit.entitlements.plist'),
    extendInfo: {
      ...existingExtendInfo,
      AIWatchAppGroup: appGroup,
      ElectronTeamID: teamIdentifier,
      CFBundleURLTypes: hasAIWatchScheme
        ? existingURLTypes
        : [
            ...existingURLTypes,
            {
              CFBundleURLName: 'app.aiwatch.panel',
              CFBundleURLSchemes: ['aiwatch'],
            },
          ],
    },
  },
};

const builderArch = architecture === 'x64' ? Arch.x64 : Arch.arm64;
await build({
  projectDir: repository,
  targets: Platform.MAC.createTarget('dir', builderArch),
  config: configuration,
  publish: 'never',
});

if (!existsSync(packResult)) fail('electron-builder completed without an afterPack result');
const packed = JSON.parse(readFileSync(packResult, 'utf8'));
if (packed.architecture !== architecture || typeof packed.appPath !== 'string') {
  fail('afterPack reported a different architecture or invalid app path');
}
const appPath = resolve(packed.appPath);
const outputDirectory = resolve(repository, existing.directories?.output || 'dist');
if (!appPath.startsWith(`${outputDirectory}/`) || !existsSync(appPath)) {
  fail('afterPack reported an app outside the configured output directory');
}
const extensionPath = join(appPath, 'Contents', 'PlugIns', 'AIWatchWidgets.appex');
const addonPath = join(appPath, 'Contents', 'Resources', 'widgets', 'widget-bridge.node');
const libraryPath = join(appPath, 'Contents', 'Resources', 'widgets', 'libAIWatchWidgetBridge.dylib');

for (const signedPath of [extensionPath, addonPath, libraryPath, appPath]) {
  run('codesign', ['--verify', '--strict', signedPath], { capture: true });
  if (signingTeam(signedPath) !== teamIdentifier) {
    fail('a packaged binary was signed by a different Apple team');
  }
}

const mainEntitlements = signedEntitlements(appPath);
const widgetEntitlements = signedEntitlements(extensionPath);
const mainGroups = JSON.parse(plistValue(mainEntitlements, 'com.apple.security.application-groups', 'json'));
const widgetGroups = JSON.parse(plistValue(widgetEntitlements, 'com.apple.security.application-groups', 'json'));
if (!mainGroups.includes(appGroup) || !widgetGroups.includes(appGroup)) {
  fail('the signed app and extension do not share the configured application group');
}
if (plistValue(mainEntitlements, 'com.apple.developer.team-identifier') !== teamIdentifier ||
    plistValue(widgetEntitlements, 'com.apple.developer.team-identifier') !== teamIdentifier) {
  fail('the signed app or extension team entitlement does not match AI_WATCH_APPLE_TEAM_ID');
}
if (plistValue(mainEntitlements, 'com.apple.application-identifier') !== `${teamIdentifier}.app.aiwatch.panel` ||
    plistValue(widgetEntitlements, 'com.apple.application-identifier') !== `${teamIdentifier}.app.aiwatch.panel.widgets`) {
  fail('the signed app or extension application identifier is incorrect');
}

const mainInfo = join(appPath, 'Contents', 'Info.plist');
const mainInfoContents = readFileSync(mainInfo);
if (plistValue(mainInfoContents, 'AIWatchAppGroup') !== appGroup) {
  fail('the packaged app Info.plist is missing AIWatchAppGroup');
}
const urlTypes = JSON.parse(plistValue(mainInfoContents, 'CFBundleURLTypes', 'json'));
if (!urlTypes.some((entry) => Array.isArray(entry?.CFBundleURLSchemes) &&
    entry.CFBundleURLSchemes.includes('aiwatch'))) {
  fail('the packaged app Info.plist is missing the aiwatch URL scheme');
}
run('lipo', [addonPath, '-verify_arch', architecture === 'x64' ? 'x86_64' : architecture], { capture: true });
run('lipo', [libraryPath, '-verify_arch', architecture === 'x64' ? 'x86_64' : architecture], { capture: true });

console.log(`Built and verified signed ${architecture} widget app bundle in ${outputDirectory.slice(repository.length + 1)}.`);
