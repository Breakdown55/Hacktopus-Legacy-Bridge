import { spawn } from 'node:child_process';
import { readSettings, saveSettings } from './settings';

const settings = readSettings();
const tunnel = spawn(process.env.LB_CLOUDFLARED_BIN || 'cloudflared', ['tunnel', '--url', `http://127.0.0.1:${settings.port}`], { stdio: ['ignore', 'pipe', 'pipe'] });
let saved = false;
let buffer = '';
function output(chunk: Buffer) {
  buffer = (buffer + chunk.toString()).slice(-16_000);
  const url = buffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/)?.[0];
  if (url && !saved) { saved = true; saveSettings({ ...readSettings(), tunnelUrl: url }); console.log('Demo tunnel ready: ' + url); console.log('The URL was saved for the Vercel setup command.'); }
}
tunnel.stdout.on('data', output); tunnel.stderr.on('data', output);
tunnel.on('error', () => { console.error('cloudflared is missing. Install it with: brew install cloudflared'); process.exitCode = 1; });
tunnel.on('exit', code => { if (!saved) console.error('The tunnel did not start. Run cloudflared manually to inspect its diagnostics.'); process.exitCode = code ?? 0; });
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { tunnel.kill(signal); });
