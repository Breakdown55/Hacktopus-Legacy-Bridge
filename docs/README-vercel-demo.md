# Vercel hackathon demo

The Vercel site serves the Next.js interface and proxies the workflow API through a private-key-protected Cloudflare Tunnel gateway. PostgreSQL, S3Mock, the existing local dev server, Docker, and the Codex worker stay on this computer. All demo visitors share the existing demo workspace.

## Open the demo

Open https://hacktopus-legacy-bridge.vercel.app (Vercel project `hacktopus1/hacktopus-legacy-bridge`).

The demo is public and does not require a browser login. The private gateway key is in `.cache/hackathon-demo/settings.json`; do not share that file.

The computer must remain awake and online. Keep Docker, the original local dev server, the generation worker, the gateway, and the tunnel running. Hosting the web interface does not move the local data or compute to Vercel.

## Restart after a computer reboot

1. Start Docker and the existing database/storage services using the normal local setup. Start the existing dev server on port 3000 and worker with their usual settings. No database migration or Codex provider change is required for this bridge.
2. In separate terminals from the repository root, run:

   ```sh
   npm run demo:gateway
   ```

   ```sh
   npm run demo:tunnel
   ```

3. The temporary tunnel address changes on restart. The tunnel command saves the new URL automatically. Update Vercel and redeploy:

   ```sh
   npm run demo:vercel-env
   .cache/hackathon-tools/node_modules/.bin/vercel deploy --prod --yes
   ```

The CLI is installed locally under `.cache/hackathon-tools`; Cloudflare Tunnel is installed with Homebrew. `npm run demo:prepare` creates settings if absent and preserves existing credentials.

## Deploy updates

With the gateway and tunnel already running:

```sh
.cache/hackathon-tools/node_modules/.bin/vercel deploy --prod --yes
```

This deploys the current working directory, including uncommitted source changes. It does not depend on the GitHub connection. If CLI login expires, use `.cache/hackathon-tools/node_modules/.bin/vercel login` first.

Vercel uses three bridge settings: `NEXT_PUBLIC_LB_DEMO_MODE=1`, `LB_DEMO_BACKEND_URL`, and `LB_DEMO_BRIDGE_KEY`. Only the mode flag is public. Do not upload the local database or storage credentials to Vercel.

## Limits

- This is a shared hackathon workspace. Anyone with the website address can use that workspace, including running jobs and deleting its projects.
- The gateway only forwards workflow API paths. It replaces caller-supplied organization and user headers with the existing local demo identity. Codex worker endpoints and database/storage ports are not published.
- The app keeps its existing 16 MiB upload limit; the gateway and Next.js proxy allow 20 MiB. Long compute runs stay on the worker; the website polls for results.
- Green generation states mean generated, not behavior verified. Use Verify for original-versus-replacement results.
- When the laptop, tunnel, or worker stops, the corresponding live backend features stop. A named tunnel can provide a stable backend hostname later.
