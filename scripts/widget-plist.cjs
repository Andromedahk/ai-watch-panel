const { execFileSync } = require('node:child_process');

// Entitlement names are literal root keys. plutil treats unescaped dots as
// nested key-path separators, even when the argument is passed without a shell.
function plistValue(plist, key, format = 'raw') {
  const keyPath = key.replaceAll('\\', '\\\\').replaceAll('.', '\\.');
  return execFileSync('plutil', ['-extract', keyPath, format, '-o', '-', '-'], {
    input: plist,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

module.exports = { plistValue };
