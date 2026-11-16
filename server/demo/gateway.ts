import { createServer, type Server } from 'node:http';
import { Readable } from 'node:stream';
import { demoPath, sameSecret } from './access';

type Options = { target: string; bridgeKey: string; identity: { orgId: string; userId: string }; storageOrigin?: string };
const headersToForward = ['content-type', 'idempotency-key', 'if-match', 'if-none-match', 'accept'];
const responseHeaders = ['content-type', 'content-disposition', 'etag', 'idempotent-replay'];
const MAX_BODY = 20 * 1024 * 1024;

/** Exposes only the workflow API, using a fixed demo identity. Never forwards the browser's dev-auth headers. */
export function createDemoGateway(options: Options): Server {
  const target = new URL(options.target);
  if (target.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)
    || target.pathname !== '/' || target.search || target.hash || target.username || target.password) throw new Error('Gateway target must be a loopback HTTP origin.');
  if (options.bridgeKey.length < 32) throw new Error('Bridge key must be at least 32 characters.');
  return createServer(async (req, res) => {
    const abort = new AbortController();
    res.on('close', () => { if (!res.writableEnded) abort.abort(); });
    res.setHeader('cache-control', 'private, no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    try {
      const key = req.headers['x-lb-demo-bridge-key'];
      if (typeof key !== 'string' || !sameSecret(key, options.bridgeKey)) { res.writeHead(401); res.end('Unauthorized'); return; }
      const path = req.url ?? '/';
      if (!path.startsWith('/api/') || path.includes('\\')) { res.writeHead(404); res.end('Not found'); return; }
      const url = new URL(path, target);
      if (url.origin !== target.origin || !demoPath(url.pathname) || /%2f|%5c|%2e/i.test(url.pathname)) { res.writeHead(404); res.end('Not found'); return; }
      if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(req.method ?? '')) { res.writeHead(405); res.end(); return; }
      if (url.pathname === '/api/s1/config') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(options.identity)); return; }
      if (Number(req.headers['content-length'] ?? 0) > MAX_BODY) { res.writeHead(413); res.end('Upload exceeds 20 MiB.'); return; }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY) { res.writeHead(413); res.end('Upload exceeds 20 MiB.'); return; }
        chunks.push(Buffer.from(chunk));
      }
      const headers = new Headers();
      for (const name of headersToForward) {
        const value = req.headers[name]; if (typeof value === 'string') headers.set(name, value);
      }
      headers.set('x-org-id', options.identity.orgId);
      headers.set('x-user-id', options.identity.userId);
      headers.set('origin', target.origin);
      headers.set('sec-fetch-site', 'same-origin');
      let upstream = await fetch(url, { method: req.method, headers, body: size ? Buffer.concat(chunks) : undefined,
        redirect: 'manual', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(100_000)]) });
      // A presigned storage redirect must never send the browser to a laptop-only URL.
      if ([301, 302, 303, 307, 308].includes(upstream.status)) {
        const location = new URL(upstream.headers.get('location') ?? '', target);
        const storage = options.storageOrigin ? new URL(options.storageOrigin) : null;
        if (!storage || location.origin !== storage.origin) { res.writeHead(502); res.end('Storage download origin is not configured.'); return; }
        upstream = await fetch(location, { redirect: 'error', signal: abort.signal });
      }
      for (const name of responseHeaders) { const value = upstream.headers.get(name); if (value) res.setHeader(name, value); }
      res.writeHead(upstream.status);
      if (req.method === 'HEAD' || !upstream.body) { res.end(); return; }
      Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream).on('error', () => res.destroy()).pipe(res);
    } catch {
      if (!res.headersSent) { res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ title: 'The local backend is unavailable. Check that the dev server is running.' })); }
      else res.destroy();
    }
  });
}
