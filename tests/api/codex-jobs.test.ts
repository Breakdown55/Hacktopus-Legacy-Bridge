import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { analysisStatus, submitAnalysis, workerCommand } from '../../server/api/codex-jobs';
import { setApp } from '../../server/app';
import { claim } from '../../server/jobs/queue';
import { FsBlobStore } from '../../server/storage/fs';
import { testDb } from '../helpers/testdb';

test('private remote worker claims, reads, and completes an analysis under its lease', async () => {
  const db = await testDb();
  const directory = mkdtempSync(join(tmpdir(), 'lb-codex-test-'));
  const org = randomUUID();
  const other = randomUUID();
  const demoKey = randomUUID();
  const workerKey = randomUUID();
  const endpoint = 'https://demo.example.test/api/codex/jobs';
  const headers = (key: string) => ({ authorization: 'Bearer ' + key });
  const worker = (body: object, key = workerKey) => workerCommand(new Request(endpoint, {
    method: 'POST', headers: headers(key), body: JSON.stringify(body),
  }));
  const binary = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3]);
  const submit = (body = binary) => submitAnalysis(new Request(endpoint, { method: 'POST', headers: headers(demoKey), body }));
  const inspect = (id: string) => analysisStatus(new Request(endpoint + '?id=' + id, { headers: headers(demoKey) }));
  try {
    setApp({ db, store: new FsBlobStore(directory) });
    vi.stubEnv('LB_CODEX_ORG_ID', org);
    vi.stubEnv('LB_CODEX_DEMO_KEY', demoKey);
    vi.stubEnv('LB_CODEX_WORKER_KEY', workerKey);
    await db.query("INSERT INTO organizations(id,name,external_model_allowed) VALUES ($1,'Demo',true), ($2,'Other',true)", [org, other]);
    expect((await worker({ action: 'claim' }, demoKey)).status).toBe(401);
    expect((await submit(new Uint8Array([0, 1]))).status).toBe(422);

    const submitted = await submit();
    expect(submitted.status).toBe(202);
    const { id } = await submitted.json();
    expect(await (await submit()).json()).toEqual({ id });
    expect(await (await inspect(id)).json()).toMatchObject({ status: 'queued' });
    expect(await claim(db, 'other-worker', ['codex.inspect'], other)).toBeNull();

    const { lease, format } = await (await worker({ action: 'claim' })).json();
    expect(format).toBe('elf');
    expect(await (await worker({ action: 'claim' })).json()).toBeNull();
    expect((await worker({ action: 'artifact', id, lease: randomUUID() })).status).toBe(409);
    const artifact = await worker({ action: 'artifact', id, lease });
    expect(new Uint8Array(await artifact.arrayBuffer())).toEqual(binary);
    expect(await (await worker({ action: 'heartbeat', id, lease })).json()).toEqual({ cancelRequested: false });

    await db.query("UPDATE jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [id]);
    const result = { summary: 'Static evidence', candidates: [], limitations: ['No runtime evidence'] };
    expect((await worker({ action: 'complete', id, lease, result })).status).toBe(409);
    const retry = await (await worker({ action: 'claim' })).json();
    expect(retry.id).toBe(id);
    expect(retry.lease).not.toBe(lease);
    expect((await worker({ action: 'complete', id, lease: retry.lease, result })).status).toBe(204);
    expect(await (await inspect(id)).json()).toEqual({ status: 'succeeded', result });
  } finally {
    setApp(null);
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  }
}, 20_000);
