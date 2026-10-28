'use strict';
// Run explicitly during deployment. Never prints credentials into logs.
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const target = path.join(__dirname, '.env');
try {
  fs.writeFileSync(target, `AI_WATCH_DESKTOP_TOKEN=${randomBytes(32).toString('base64url')}\n# Bootstrap/admin credential; never use directly for mobile state/actions.\nAI_WATCH_MOBILE_TOKEN=${randomBytes(32).toString('base64url')}\nAI_WATCH_LOW_QUOTA_PERCENT=20\n# Push credentials are optional for local API testing. Configure before deployment.\n# GOOGLE_APPLICATION_CREDENTIALS=secrets/firebase-service-account.json\n# APNS_KEY_FILE=secrets/apns-auth-key.p8\n# APNS_KEY_ID=\n# APNS_TEAM_ID=\n# APNS_TOPIC=app.aiwatch.mobile\n`, { mode: 0o600, flag: 'wx' });
  process.stdout.write('Created cloud/.env with separate desktop and pairing/admin credentials. Keep this file private.\n');
} catch (e) { process.stderr.write(e.code === 'EEXIST' ? 'cloud/.env already exists; no credentials changed.\n' : 'Could not create configuration.\n'); process.exitCode = 1; }
