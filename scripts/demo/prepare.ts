import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { saveSettings, settingsPath } from './settings';

if (!existsSync(settingsPath)) saveSettings({ target: 'http://127.0.0.1:3000', port: 3200,
  bridgeKey: randomBytes(32).toString('hex'), password: randomBytes(24).toString('base64url'), storageOrigin: 'http://localhost:9090' });
console.log('Demo settings ready: ' + settingsPath);
console.log('Credentials are stored locally with owner-only permissions; nothing was read from .env.');
