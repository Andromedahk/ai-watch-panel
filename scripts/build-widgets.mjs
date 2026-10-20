import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { arch as hostArch } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceDirectory = join(repository, 'native', 'macos');
const outputDirectory = join(repository, '.local', 'widgets');
const generatedDirectory = join(outputDirectory, 'generated');
const moduleCache = join(outputDirectory, 'module-cache');
const extensionPath = join(outputDirectory, 'AIWatchWidgets.appex');
const extensionExecutable = join(extensionPath, 'Contents', 'MacOS', 'AIWatchWidgets');
const bridgeLibrary = join(outputDirectory, 'libAIWatchWidgetBridge.dylib');
const addon = join(outputDirectory, 'widget-bridge.node');
const modelTest = join(outputDirectory, 'WidgetModelTests');
const bridgeTest = join(outputDirectory, 'WidgetBridgeTests');

function fail(message) {
  throw new Error(`Widget build: ${message}`);
}

function parseArguments(argv) {
  let requestedArch;
  let check = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--check') {
      check = true;
    } else if (argument === '--arch') {
      requestedArch = argv[++index];
      if (!requestedArch) fail('--arch requires arm64 or x64');
    } else if (argument.startsWith('--arch=')) {
      requestedArch = argument.slice('--arch='.length);
    } else {
      fail(`unknown argument ${argument}`);
    }
  }
  const architecture = requestedArch
    ?? process.env.AI_WATCH_WIDGET_ARCH
    ?? process.env.npm_config_arch
    ?? hostArch();
  if (!['arm64', 'x64'].includes(architecture)) fail(`unsupported architecture ${architecture}`);
  return { architecture, check };
}

function run(program, args, options = {}) {
  execFileSync(program, args, {
    cwd: repository,
    env: buildEnvironment,
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    ...options,
  });
}

function capture(program, args) {
  return execFileSync(program, args, {
    cwd: repository,
    env: buildEnvironment,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function renderTemplate(name, replacements) {
  let contents = readFileSync(join(sourceDirectory, name), 'utf8');
  for (const [token, value] of Object.entries(replacements)) {
    contents = contents.replaceAll(token, value);
  }
  if (/__[A-Z0-9_]+__/.test(contents)) fail(`${name} contains an unresolved placeholder`);
  const target = join(generatedDirectory, name);
  writeFileSync(target, contents, { mode: 0o600 });
  return target;
}

function resolveNodeHeaders() {
  const override = process.env.AI_WATCH_NODE_HEADERS;
  const candidate = override
    ? resolve(override)
    : resolve(dirname(process.execPath), '..', 'include', 'node');
  const directory = existsSync(join(candidate, 'node_api.h'))
    ? candidate
    : join(candidate, 'include', 'node');
  if (!existsSync(join(directory, 'node_api.h'))) {
    fail('node_api.h was not found; set AI_WATCH_NODE_HEADERS to a Node include directory');
  }
  return directory;
}

if (process.platform !== 'darwin') fail('native widgets can only be compiled on macOS');

const { architecture, check } = parseArguments(process.argv.slice(2));
const clangArchitecture = architecture === 'x64' ? 'x86_64' : architecture;
const developerDirectory = process.env.DEVELOPER_DIR
  || (existsSync('/Applications/Xcode.app/Contents/Developer')
    ? '/Applications/Xcode.app/Contents/Developer'
    : undefined);
const buildEnvironment = {
  ...process.env,
  ...(developerDirectory ? { DEVELOPER_DIR: developerDirectory } : {}),
};
const teamIdentifier = process.env.AI_WATCH_APPLE_TEAM_ID || 'LOCALBUILD';
if (!/^[A-Z0-9]{10}$/.test(teamIdentifier)) {
  fail('AI_WATCH_APPLE_TEAM_ID must be exactly 10 uppercase letters or digits');
}
const appGroup = process.env.AI_WATCH_APP_GROUP || `${teamIdentifier}.app.aiwatch.panel`;
if (appGroup !== `${teamIdentifier}.app.aiwatch.panel`) {
  fail('AI_WATCH_APP_GROUP must match <AI_WATCH_APPLE_TEAM_ID>.app.aiwatch.panel');
}

const sdk = capture('xcrun', ['--sdk', 'macosx', '--show-sdk-path']);
const target = `${clangArchitecture}-apple-macos14.0`;
const packageMetadata = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8'));
const version = String(packageMetadata.version || '0.0.0');
const buildNumber = process.env.AI_WATCH_BUILD_NUMBER
  || version.replaceAll('.', '').replace(/^0+/, '')
  || '1';
if (!/^\d+(?:\.\d+)*$/.test(version) || !/^\d+$/.test(buildNumber)) {
  fail('package version and AI_WATCH_BUILD_NUMBER must be numeric');
}

rmSync(outputDirectory, { recursive: true, force: true });
mkdirSync(join(extensionPath, 'Contents', 'MacOS'), { recursive: true });
mkdirSync(generatedDirectory, { recursive: true });
mkdirSync(moduleCache, { recursive: true });

const replacements = {
  __AI_WATCH_APP_GROUP__: appGroup,
  __AI_WATCH_TEAM_ID__: teamIdentifier,
  __AI_WATCH_VERSION__: version,
  __AI_WATCH_BUILD_NUMBER__: buildNumber,
};
const widgetInfo = renderTemplate('WidgetInfo.plist', replacements);
renderTemplate('Main.entitlements.plist', replacements);
renderTemplate('Main.inherit.entitlements.plist', replacements);
renderTemplate('Widget.entitlements.plist', replacements);
cpSync(widgetInfo, join(extensionPath, 'Contents', 'Info.plist'));

const swiftCommon = [
  '-sdk', sdk,
  '-target', target,
  '-module-cache-path', moduleCache,
  '-O',
  '-whole-module-optimization',
];

run('xcrun', [
  '--sdk', 'macosx', 'swiftc',
  ...swiftCommon,
  '-parse-as-library',
  '-application-extension',
  '-module-name', 'AIWatchWidgets',
  join(sourceDirectory, 'WidgetModels.swift'),
  join(sourceDirectory, 'Widgets.swift'),
  '-o', extensionExecutable,
]);
chmodSync(extensionExecutable, 0o755);

run('xcrun', [
  '--sdk', 'macosx', 'swiftc',
  ...swiftCommon,
  '-emit-library',
  '-module-name', 'AIWatchWidgetBridge',
  join(sourceDirectory, 'WidgetModels.swift'),
  join(sourceDirectory, 'WidgetBridge.swift'),
  '-Xlinker', '-install_name',
  '-Xlinker', '@loader_path/libAIWatchWidgetBridge.dylib',
  '-o', bridgeLibrary,
]);
chmodSync(bridgeLibrary, 0o755);

run('xcrun', [
  '--sdk', 'macosx', 'clang',
  '-arch', clangArchitecture,
  '-mmacosx-version-min=14.0',
  '-O2',
  '-Wall', '-Wextra', '-Werror',
  '-DNODE_GYP_MODULE_NAME=aiwatch_widget_bridge',
  '-I', resolveNodeHeaders(),
  '-bundle',
  '-undefined', 'dynamic_lookup',
  join(sourceDirectory, 'widget-bridge.c'),
  '-L', outputDirectory,
  '-lAIWatchWidgetBridge',
  '-Wl,-rpath,@loader_path',
  '-o', addon,
]);
chmodSync(addon, 0o755);

if (check) {
  const modelTestSource = join(sourceDirectory, 'WidgetModelTests.swift');
  if (!existsSync(modelTestSource)) fail('WidgetModelTests.swift is required by --check');
  run('xcrun', [
    '--sdk', 'macosx', 'swiftc',
    ...swiftCommon,
    '-parse-as-library',
    join(sourceDirectory, 'WidgetModels.swift'),
    modelTestSource,
    '-o', modelTest,
  ]);
  const isHostArchitecture = (architecture === 'arm64' && hostArch() === 'arm64') ||
    (architecture === 'x64' && hostArch() === 'x64');
  if (isHostArchitecture) run(modelTest, []);
  run('xcrun', [
    '--sdk', 'macosx', 'swiftc',
    ...swiftCommon,
    '-parse-as-library',
    '-D', 'WIDGET_BRIDGE_TESTING',
    join(sourceDirectory, 'WidgetModels.swift'),
    join(sourceDirectory, 'WidgetBridge.swift'),
    join(sourceDirectory, 'WidgetBridgeTests.swift'),
    '-o', bridgeTest,
  ]);
  if (isHostArchitecture) run(bridgeTest, []);
  run('plutil', ['-lint', join(extensionPath, 'Contents', 'Info.plist')]);
  run('plutil', ['-lint', join(generatedDirectory, 'Main.entitlements.plist')]);
  run('plutil', ['-lint', join(generatedDirectory, 'Main.inherit.entitlements.plist')]);
  run('plutil', ['-lint', join(generatedDirectory, 'Widget.entitlements.plist')]);
  const packagedInfo = join(extensionPath, 'Contents', 'Info.plist');
  const requiredInfoValues = [
    ['CFBundleIdentifier', 'app.aiwatch.panel.widgets'],
    ['LSMinimumSystemVersion', '14.0'],
    ['NSExtension.NSExtensionPointIdentifier', 'com.apple.widgetkit-extension'],
    ['AIWatchAppGroup', appGroup],
  ];
  for (const [key, expected] of requiredInfoValues) {
    if (capture('plutil', ['-extract', key, 'raw', '-o', '-', packagedInfo]) !== expected) {
      fail(`the extension Info.plist has an invalid ${key}`);
    }
  }
  run('lipo', [extensionExecutable, '-verify_arch', clangArchitecture]);
  run('lipo', [bridgeLibrary, '-verify_arch', clangArchitecture]);
  run('lipo', [addon, '-verify_arch', clangArchitecture]);
  const linkedLibraries = capture('otool', ['-L', addon]);
  if (!linkedLibraries.includes('@loader_path/libAIWatchWidgetBridge.dylib')) {
    fail('the Node addon does not use an @loader_path bridge dependency');
  }
  if (isHostArchitecture && process.arch === architecture) {
    run(process.execPath, [
      '--input-type=module',
      '--eval',
      `import { createRequire } from 'node:module';
       const bridge = createRequire(import.meta.url)(${JSON.stringify(addon)});
       if (typeof bridge.available !== 'function' || typeof bridge.publish !== 'function' || typeof bridge.clear !== 'function') process.exit(2);
       if (bridge.available() !== false) process.exit(3);
       if (bridge.publish('{}', false) !== false) process.exit(4);
       if (bridge.clear() !== false) process.exit(5);`,
    ]);
  }
}

console.log(`Built unsigned ${architecture} widget artifacts in .local/widgets (${appGroup}).`);
