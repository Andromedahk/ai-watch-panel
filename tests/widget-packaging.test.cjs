const test = require('node:test');
const assert = require('node:assert/strict');
const { plistValue } = require('../scripts/widget-plist.cjs');

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>com.apple.security.application-groups</key><array><string>EXAMPLE.app.aiwatch.panel</string></array>
  <key>com.apple.developer.team-identifier</key><string>EXAMPLE</string>
  <key>com</key><dict><key>apple</key><dict><key>developer</key><dict>
    <key>team-identifier</key><string>WRONG-NESTED-VALUE</string>
  </dict></dict></dict>
  <key>AIWatchAppGroup</key><string>EXAMPLE.app.aiwatch.panel</string>
</dict></plist>`;

test('signed widget verification reads literal dotted entitlement keys with real plutil', { skip: process.platform !== 'darwin' }, () => {
  assert.deepEqual(JSON.parse(plistValue(plist, 'com.apple.security.application-groups', 'json')), ['EXAMPLE.app.aiwatch.panel']);
  assert.equal(plistValue(plist, 'com.apple.developer.team-identifier'), 'EXAMPLE');
  assert.equal(plistValue(plist, 'AIWatchAppGroup'), 'EXAMPLE.app.aiwatch.panel');
});

test('signed widget verification fails when a required entitlement is absent', { skip: process.platform !== 'darwin' }, () => {
  assert.throws(() => plistValue(plist, 'com.apple.application-identifier'));
});
