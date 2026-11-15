/**
 * S7 login pieces WITHOUT a real identity provider. What is covered: the session cookie round trip (encrypted Auth.js JWT minted with the
 * same secret and read by sessionUserId), forged/expired/header-only tokens, IdP-identity-to-user mapping, and the bootstrap-admin CLI logic.
 * NOT covered: the OIDC redirect/callback handshake with a live IdP (no IdP available here; the provider config is only constructed).
 * Substitute: PGlite.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { encode } from '@auth/core/jwt';
import { testDb } from '../helpers/testdb';
import type { Db } from '../../server/db/db';
import { uuidv7 } from '../../server/db/ids';
import { authConfig } from '../../server/auth/config';
import { sessionUserId } from '../../server/auth/session';
import { upsertIdpUser } from '../../server/auth/users';
import { bootstrapAdmin } from '../../server/db/bootstrap-admin';
import { setApp } from '../../server/app';
import { api } from '../../server/api/handlers';
import { FsBlobStore } from '../../server/storage/fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SECRET = 'test-secret-test-secret-test-secret-0123';
const env = { AUTH_SECRET: SECRET };
const COOKIE = 'authjs.session-token';
let db: Db;
const req = (headers: Record<string, string>) => new Request('http://localhost/api/v1/projects', { headers });
const mint = (claims: Record<string, unknown>, secret = SECRET, maxAge = 3600) => encode({ token: claims, secret, salt: COOKIE, maxAge });

beforeAll(async () => { db = await testDb(); });

describe('session cookie', () => {
  it('resolves the user from a valid cookie', async () => {
    const id = uuidv7();
    await db.query("INSERT INTO users(id,email,idp_subject) VALUES ($1,'a@x','sub-a')", [id]);
    expect(await sessionUserId(req({ cookie: `${COOKIE}=${await mint({ uid: id })}` }), db, env)).toBe(id);
  });
  it('rejects missing, forged, expired, wrong-secret, unknown-user and header-only tokens', async () => {
    const id = uuidv7();
    await db.query("INSERT INTO users(id,email) VALUES ($1,'b@x')", [id]);
    const good = await mint({ uid: id });
    expect(await sessionUserId(req({}), db, env)).toBeNull();
    expect(await sessionUserId(req({ cookie: `${COOKIE}=${good}x` }), db, env)).toBeNull();
    expect(await sessionUserId(req({ cookie: `${COOKIE}=${await mint({ uid: id }, 'another-secret-another-secret-another-0123')}` }), db, env)).toBeNull();
    expect(await sessionUserId(req({ cookie: `${COOKIE}=${await mint({ uid: id }, SECRET, -3600)}` }), db, env)).toBeNull();
    expect(await sessionUserId(req({ cookie: `${COOKIE}=${await mint({ uid: uuidv7() })}` }), db, env)).toBeNull();
    expect(await sessionUserId(req({ cookie: `${COOKIE}=${await mint({ uid: 'not-a-uuid' })}` }), db, env)).toBeNull();
    expect(await sessionUserId(req({ authorization: `Bearer ${good}` }), db, env)).toBeNull(); // cookie only
    expect(await sessionUserId(req({ cookie: `${COOKIE}=${good}` }), db, {})).toBeNull(); // no secret configured
  });
  it('provider config demands its environment', () => {
    expect(() => authConfig({})).toThrow(/required/);
    const cfg = authConfig({ AUTH_SECRET: SECRET, OIDC_ISSUER: 'https://idp.example', OIDC_CLIENT_ID: 'c', OIDC_CLIENT_SECRET: 's' });
    expect(cfg.session).toMatchObject({ strategy: 'jwt' });
    expect(cfg.trustHost).toBe(false);
  });
});

describe('IdP identity mapping', () => {
  it('creates, reuses, and links invited users only on a verified email', async () => {
    const a = await upsertIdpUser(db, { sub: 'sub-1', email: 'New@X.com', email_verified: true, name: 'N' });
    expect(a?.email).toBe('new@x.com');
    expect((await upsertIdpUser(db, { sub: 'sub-1' }))?.id).toBe(a!.id); // by subject, no email needed
    const invited = uuidv7();
    await db.query("INSERT INTO users(id,email) VALUES ($1,'invited@x.com')", [invited]);
    expect(await upsertIdpUser(db, { sub: 'sub-2', email: 'invited@x.com', email_verified: false })).toBeNull(); // takeover attempt
    expect(await upsertIdpUser(db, { sub: 'sub-2', email: 'invited@x.com' })).toBeNull();
    expect((await upsertIdpUser(db, { sub: 'sub-2', email: 'invited@x.com', email_verified: true }))?.id).toBe(invited);
    expect(await upsertIdpUser(db, { sub: 'sub-3', email: 'invited@x.com', email_verified: true })).toBeNull(); // already linked to another subject
    expect(await upsertIdpUser(db, { sub: '', email: 'z@x' })).toBeNull();
    expect(await upsertIdpUser(db, { sub: 'sub-4' })).toBeNull(); // unknown subject without an email
  });
});

describe('bootstrap-admin', () => {
  it('is idempotent and grants only admin membership in the named org', async () => {
    const r1 = await bootstrapAdmin(db, { email: 'Root@X.com', org: 'Acme' });
    expect(r1.created_membership).toBe(true);
    const r2 = await bootstrapAdmin(db, { email: 'root@x.com', org: 'Acme' });
    expect(r2).toMatchObject({ org_id: r1.org_id, user_id: r1.user_id, created_membership: false });
    expect(await db.query('SELECT role FROM memberships WHERE org_id=$1', [r1.org_id])).toEqual([{ role: 'admin' }]);
    expect(await db.query("SELECT 1 FROM events WHERE org_id=$1 AND type='member.added'", [r1.org_id])).toHaveLength(1);
    await expect(bootstrapAdmin(db, { email: 'bad', org: 'Acme' })).rejects.toThrow();
    // the bootstrapped user can later sign in through the IdP: linked by verified email
    expect((await upsertIdpUser(db, { sub: 'sub-root', email: 'root@x.com', email_verified: true }))?.id).toBe(r1.user_id);
  });
});

describe('session auth through the real route wrapper', () => {
  const saved = { ...process.env };
  const get = async (headers: Record<string, string>) => api.orgGet(new Request('http://localhost/api/v1/org', { headers }), { params: Promise.resolve({}) });
  const restore = () => { vi.unstubAllEnvs(); for (const k of ['LB_DEV_AUTH', 'AUTH_SECRET']) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } };
  it('accepts a member, 404s a non-member, refuses dev headers in production, and needs configuration', async () => {
    setApp({ db, store: new FsBlobStore(mkdtempSync(join(tmpdir(), 'auth-blobs-'))) });
    const { org_id, user_id } = await bootstrapAdmin(db, { email: 'session@x.com', org: 'SessionOrg' });
    const stranger = uuidv7();
    await db.query("INSERT INTO users(id,email) VALUES ($1,'stranger@x.com')", [stranger]);
    const other = (await bootstrapAdmin(db, { email: 'other@x.com', org: 'OtherOrg' })).org_id;
    const cookie = async (uid: string) => `${COOKIE}=${await mint({ uid })}`;
    try {
      process.env.AUTH_SECRET = SECRET; delete process.env.LB_DEV_AUTH; vi.stubEnv('NODE_ENV', 'test');
      expect((await get({ cookie: await cookie(user_id), 'x-org-id': org_id })).status).toBe(200);
      expect((await get({ cookie: await cookie(user_id), 'x-org-id': other })).status).toBe(404); // member of another org only
      expect((await get({ cookie: await cookie(stranger), 'x-org-id': org_id })).status).toBe(404); // signed in, no membership
      expect((await get({ cookie: await cookie(user_id) })).status).toBe(401); // no org named
      expect((await get({ 'x-org-id': org_id })).status).toBe(401); // no session
      expect((await get({ cookie: `${COOKIE}=forged`, 'x-org-id': org_id })).status).toBe(401);
      // dev headers are only honored outside production and only when enabled
      process.env.LB_DEV_AUTH = '1';
      expect((await get({ 'x-org-id': org_id, 'x-user-id': user_id })).status).toBe(200);
      vi.stubEnv('NODE_ENV', 'production');
      expect((await get({ 'x-org-id': org_id, 'x-user-id': user_id })).status).toBe(401);
      expect((await get({ cookie: await cookie(user_id), 'x-org-id': org_id })).status).toBe(200); // the session still works
      delete process.env.AUTH_SECRET;
      expect((await get({ cookie: await cookie(user_id), 'x-org-id': org_id })).status).toBe(501);
    } finally { restore(); setApp(null); }
  });
});
