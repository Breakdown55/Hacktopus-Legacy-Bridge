import { beforeAll, describe, expect, it } from 'vitest';
import { testDb } from '../helpers/testdb';
import type { Db } from '../../server/db/db';
import { uuidv7 } from '../../server/db/ids';
import { cancel, claim, enqueue, finish, heartbeat, reap, retryOrFail } from '../../server/jobs/queue';

let db: Db;
const org = uuidv7();
beforeAll(async () => {
  db = await testDb();
  await db.query("INSERT INTO organizations(id,name) VALUES ($1,'a')", [org]);
});
const status = async (id: string) => (await db.query<{ status: string; attempt: number }>('SELECT status, attempt FROM jobs WHERE id=$1', [id]))[0];

describe('job queue', () => {
  it('dedupes active jobs by key, allows again once finished', async () => {
    const a = await enqueue(db, { orgId: org, kind: 'verify', dedupeKey: 'verify:x' });
    const b = await enqueue(db, { orgId: org, kind: 'verify', dedupeKey: 'verify:x' });
    expect(b).toEqual({ id: a.id, deduped: true });
    const j = await claim(db, 'w1', ['verify']);
    await finish(db, j!.id, 'w1', { status: 'succeeded' });
    expect((await enqueue(db, { orgId: org, kind: 'verify', dedupeKey: 'verify:x' })).deduped).toBe(false);
    const k = await claim(db, 'w1'); await finish(db, k!.id, 'w1', { status: 'succeeded' });
  });
  it('two claimers never get the same job; a non-owner finalize is a no-op', async () => {
    const { id } = await enqueue(db, { orgId: org, kind: 'inspect' });
    const [c1, c2] = await Promise.all([claim(db, 'w1'), claim(db, 'w2')]);
    expect([c1, c2].filter(Boolean)).toHaveLength(1);
    const owner = c1 ? 'w1' : 'w2', other = c1 ? 'w2' : 'w1';
    expect(await finish(db, id, other, { status: 'succeeded' })).toBe(false);
    expect(await heartbeat(db, id, other)).toBeNull();
    expect(await heartbeat(db, id, owner)).toEqual({ cancelRequested: false });
    expect(await finish(db, id, owner, { status: 'succeeded' })).toBe(true);
    expect(await finish(db, id, owner, { status: 'succeeded' })).toBe(false);
  });
  it('kind filter and run_after are respected', async () => {
    await enqueue(db, { orgId: org, kind: 'build', runAfter: new Date(Date.now() + 60_000) });
    expect(await claim(db, 'w1', ['build'])).toBeNull();
  });
  it('expired lease is reaped and requeued with attempt+1, then failed as worker_lost', async () => {
    const { id } = await enqueue(db, { orgId: org, kind: 'capture', maxAttempts: 2 });
    await claim(db, 'w1', ['capture']);
    await db.query("UPDATE jobs SET lease_expires_at = now() - interval '1 second' WHERE id=$1", [id]);
    expect(await reap(db)).toBe(1);
    expect(await status(id)).toEqual({ status: 'queued', attempt: 1 });
    await claim(db, 'w2', ['capture']);
    expect((await status(id)).attempt).toBe(2);
    await db.query("UPDATE jobs SET lease_expires_at = now() - interval '1 second' WHERE id=$1", [id]);
    await reap(db);
    expect(await status(id)).toEqual({ status: 'failed', attempt: 2 });
    // the crashed worker's late finalize is a no-op
    expect(await finish(db, id, 'w2', { status: 'succeeded' })).toBe(false);
  });
  it('retry with backoff then fail after max_attempts', async () => {
    const { id } = await enqueue(db, { orgId: org, kind: 'generate', maxAttempts: 2 });
    await claim(db, 'w1', ['generate']);
    expect(await retryOrFail(db, id, 'w1', { code: 'model_429' })).toBe('requeued');
    expect(await claim(db, 'w1', ['generate'])).toBeNull(); // backoff in the future
    await db.query("UPDATE jobs SET run_after = now() WHERE id=$1", [id]);
    await claim(db, 'w1', ['generate']);
    expect(await retryOrFail(db, id, 'w1', { code: 'model_429' })).toBe('failed');
  });
  it('cancel: queued immediately, running via heartbeat', async () => {
    const q = await enqueue(db, { orgId: org, kind: 'export' });
    expect(await cancel(db, org, q.id)).toBe('cancelled');
    const r = await enqueue(db, { orgId: org, kind: 'export' });
    await claim(db, 'w1', ['export']);
    expect(await cancel(db, org, r.id)).toBe('cancel_requested');
    expect(await heartbeat(db, r.id, 'w1')).toEqual({ cancelRequested: true });
    expect(await finish(db, r.id, 'w1', { status: 'cancelled' })).toBe(true);
    expect(await cancel(db, uuidv7(), r.id)).toBe('noop'); // other org cannot touch it
  });
});
