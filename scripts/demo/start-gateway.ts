import { createDemoGateway } from '../../server/demo/gateway';
import { readSettings } from './settings';

async function main() {
  const settings = readSettings();
  const response = await fetch(new URL('/api/s1/config', settings.target), { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error('Start the existing local dev server with S1 mode enabled before starting the demo gateway.');
  const identity = await response.json() as { orgId: string; userId: string };
  if (![identity.orgId, identity.userId].every(value => /^[0-9a-f-]{36}$/i.test(value ?? ''))) throw new Error('The local demo identity is missing.');
  const server = createDemoGateway({ ...settings, identity });
  server.listen(settings.port, '127.0.0.1', () => console.log(`Demo gateway ready at http://127.0.0.1:${settings.port}`));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { server.close(); });
  server.on('error', () => { console.error('Cannot start the gateway; check whether its port is already in use.'); process.exitCode = 1; });
}
main().catch(error => { console.error((error as Error).message); process.exitCode = 1; });
