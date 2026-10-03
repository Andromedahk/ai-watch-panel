import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

if (process.platform === 'darwin') {
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const source = resolve(repository, 'electron/native/zcode-process-context.c');
  const target = resolve(repository, 'electron/native/bin/zcode-process-context');
  mkdirSync(dirname(target), { recursive: true });
  execFileSync('clang', ['-O2', '-Wall', '-Wextra', '-Werror', '-arch', 'arm64', '-arch', 'x86_64', source, '-o', target, '-lproc'], {
    stdio: 'inherit',
  });
  chmodSync(target, 0o755);
}
