import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { readSettings } from './settings';

const settings = readSettings();
if (!settings.tunnelUrl) throw new Error('Start npm run demo:tunnel first.');
const binary = existsSync(resolve('.cache/hackathon-tools/node_modules/.bin/vercel')) ? resolve('.cache/hackathon-tools/node_modules/.bin/vercel') : 'vercel';
const values = { NEXT_PUBLIC_LB_DEMO_MODE: '1', LB_DEMO_BACKEND_URL: settings.tunnelUrl, LB_DEMO_BRIDGE_KEY: settings.bridgeKey };
for (const [name, value] of Object.entries(values)) {
  if (process.argv.includes('--dry-run')) { console.log('Would set ' + name + ' in Preview and Production.'); continue; }
  for (const environment of ['preview', 'production']) {
    const result = spawnSync(binary, ['env', 'add', name, environment, '--force'], { input: value + '\n', encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`Could not set ${name} for ${environment}. Run vercel login and vercel link first.`);
    console.log(`Set ${name} for ${environment}.`);
  }
}
