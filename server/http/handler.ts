import { createHash, randomUUID } from 'node:crypto';
import { ZodError, type ZodType } from 'zod';
import type { Ctx } from '../domain/ctx';
import { DomainError } from '../domain/errors';
import { getApp } from '../app';

export type Role = 'viewer' | 'editor' | 'admin';
const RANK: Record<Role, number> = { viewer: 1, editor: 2, admin: 3 };

export function problem(status: number, code: string, title: string, o: { detail?: string; action?: unknown; fields?: { path: string; code: string }[] | null; requestId?: string; retryable?: boolean } = {}) {
  return new Response(JSON.stringify({ type: `https://legacybridge.dev/errors/${code}`, title, status, code, detail: o.detail, action: o.action, retryable: o.retryable ?? false, request_id: o.requestId, fields: o.fields ?? null }), { status, headers: { 'content-type': 'application/problem+json' } });
}

export interface Principal { orgId: string; userId: string; role: Role }

/**
 * Authentication. S1 provides a DEV-ONLY header scheme (LB_DEV_AUTH=1, never in production).
 * Production auth (OIDC through Auth.js) is slice S7; until then production requests are refused.
 */
export async function authenticate(req: Request, db: Ctx['db']): Promise<Principal | Response> {
  if (process.env.NODE_ENV === 'production' || process.env.LB_DEV_AUTH !== '1') return problem(501, 'auth_not_configured', 'Authentication is not configured', { detail: 'Set LB_DEV_AUTH=1 for local development. Production login arrives in slice S7.' });
  const orgId = req.headers.get('x-org-id'), userId = req.headers.get('x-user-id');
  if (!orgId || !userId) return problem(401, 'unauthenticated', 'Authentication required');
  const ok = /^[0-9a-f-]{36}$/;
  if (!ok.test(orgId) || !ok.test(userId)) return problem(401, 'unauthenticated', 'Authentication required');
  const m = await db.query<{ role: Role }>('SELECT role FROM memberships WHERE org_id=$1 AND user_id=$2', [orgId, userId]);
  if (!m[0]) return problem(404, 'not_found', 'Not found'); // never reveal that the org exists
  return { orgId, userId, role: m[0].role };
}

export interface RouteArgs<P, B> { ctx: Ctx; req: Request; params: P; body: B; role: Role; requestId: string; url: URL }
export type RouteResult = Response | { status?: number; body?: unknown; headers?: Record<string, string> };

/** Thin wrapper: auth -> role -> validate -> (idempotency) -> domain -> problem+json errors. */
export function route<P extends Record<string, string> = Record<string, string>, B = unknown>(
  opts: { role: Role; body?: ZodType<B>; idempotent?: boolean },
  fn: (a: RouteArgs<P, B>) => Promise<RouteResult>,
) {
  return async (req: Request, segment?: { params: Promise<Record<string, string | string[]>> | Record<string, string | string[]> }): Promise<Response> => {
    const requestId = `req_${randomUUID()}`;
    try {
      const { db, store } = await getApp();
      const who = await authenticate(req, db);
      if (who instanceof Response) return who;
      if (RANK[who.role] < RANK[opts.role]) return problem(403, 'forbidden', 'Forbidden', { detail: `Requires role ${opts.role}`, requestId });
      const params = ((await segment?.params) ?? {}) as unknown as P;
      let body = undefined as B;
      let raw = '';
      if (opts.body) {
        raw = await req.text();
        let parsed: unknown;
        try { parsed = raw ? JSON.parse(raw) : {}; } catch { return problem(400, 'invalid_json', 'Malformed JSON', { requestId }); }
        const r = opts.body.safeParse(parsed);
        if (!r.success) return problem(422, 'validation_failed', 'Validation failed', { requestId, fields: r.error.issues.map((i) => ({ path: i.path.join('.'), code: i.code })) });
        body = r.data;
      }
      const ctx: Ctx = { db, store, orgId: who.orgId, userId: who.userId };
      let key: string | null = null, reqHash = '';
      if (opts.idempotent) {
        key = req.headers.get('idempotency-key');
        if (!key) return problem(400, 'idempotency_key_required', 'Idempotency-Key header required', { requestId });
        reqHash = createHash('sha256').update(`${req.method} ${new URL(req.url).pathname}\n${raw}`).digest('hex');
        const prev = await db.query<{ request_sha256: string; response_status: number; response_body: unknown }>(`SELECT request_sha256, response_status, response_body FROM idempotency_keys WHERE org_id=$1 AND user_id=$2 AND key=$3 AND created_at > now() - interval '24 hours'`, [who.orgId, who.userId, key]);
        if (prev[0]) {
          if (prev[0].request_sha256 !== reqHash) return problem(409, 'idempotency_key_reused', 'Idempotency key reused with a different request', { requestId });
          return Response.json(prev[0].response_body, { status: prev[0].response_status, headers: { 'idempotent-replay': 'true' } });
        }
      }
      const out = await fn({ ctx, req, params, body, role: who.role, requestId, url: new URL(req.url) });
      if (out instanceof Response) return out;
      const status = out.status ?? 200;
      if (key && status >= 200 && status < 300) {
        await db.query('INSERT INTO idempotency_keys(org_id,user_id,key,request_sha256,response_status,response_body) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING', [who.orgId, who.userId, key, reqHash, status, JSON.stringify(out.body ?? null)]);
      }
      if (status === 204 || status === 304) return new Response(null, { status, headers: out.headers });
      return Response.json(out.body ?? null, { status, headers: out.headers });
    } catch (e) {
      if (e instanceof DomainError) return problem(e.status, e.code, e.code.replace(/_/g, ' '), { detail: e.message === e.code ? undefined : e.message, action: e.action, requestId });
      if (e instanceof ZodError) return problem(422, 'validation_failed', 'Validation failed', { requestId, fields: e.issues.map((i) => ({ path: i.path.join('.'), code: i.code })) });
      console.error(`[lb] ${requestId} unhandled`, (e as Error).name, process.env.LB_DEBUG_ERRORS === '1' ? (e as Error).message : ''); // message only when explicitly debugging: it could contain customer data
      return problem(500, 'internal_error', 'Internal error', { requestId, retryable: true });
    }
  };
}

/** Opaque cursor pagination over (created_at, id). */
export const encodeCursor = (createdAt: string | Date, id: string) => Buffer.from(JSON.stringify([new Date(createdAt).toISOString(), id])).toString('base64url');
export function decodeCursor(c: string | null): [string, string] | null {
  if (!c) return null;
  try { const v = JSON.parse(Buffer.from(c, 'base64url').toString()); return Array.isArray(v) && v.length === 2 ? [String(v[0]), String(v[1])] : null; } catch { return null; }
}
export const pageLimit = (u: URL) => Math.min(Math.max(Number(u.searchParams.get('limit') ?? 50) || 50, 1), 200);
