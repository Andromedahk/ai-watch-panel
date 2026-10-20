import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') throw new Error('SwiftUI widget previews require macOS');
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(repository, 'native', 'macos');
const build = join(repository, '.local', 'widget-preview-build');
const output = join(repository, '.local', 'widget-previews');
const xcode = '/Applications/Xcode.app/Contents/Developer';
const env = { ...process.env, ...(!process.env.DEVELOPER_DIR && existsSync(xcode) ? { DEVELOPER_DIR: xcode } : {}) };
mkdirSync(build, { recursive: true });
const sdk = execFileSync('xcrun', ['--sdk', 'macosx', '--show-sdk-path'], { env, encoding: 'utf8' }).trim();
const executable = join(build, 'WidgetPreview');
execFileSync('xcrun', ['swiftc', '-sdk', sdk, '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos14.0`,
  '-module-cache-path', join(build, 'module-cache'), '-D', 'WIDGET_PREVIEW', '-parse-as-library',
  join(source, 'WidgetModels.swift'), join(source, 'Widgets.swift'), join(source, 'Preview.swift'), '-o', executable],
{ env, cwd: repository, stdio: 'inherit' });
execFileSync(executable, [output], { env, cwd: repository, stdio: ['ignore', 'ignore', 'inherit'] });
console.log('Rendered synthetic SwiftUI previews in .local/widget-previews (not system-hosted widgets).');
