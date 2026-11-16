import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
export const demoDirectory = resolve('.cache/hackathon-demo');
export const settingsPath = resolve(demoDirectory, 'settings.json');
export type DemoSettings = { target: string; port: number; bridgeKey: string; password: string; tunnelUrl?: string; storageOrigin: string };
export function readSettings(): DemoSettings { return JSON.parse(readFileSync(settingsPath, 'utf8')); }
export function saveSettings(settings: DemoSettings) {
  mkdirSync(demoDirectory, { recursive: true, mode: 0o700 });
  chmodSync(demoDirectory, 0o700);
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
  chmodSync(settingsPath, 0o600);
}
