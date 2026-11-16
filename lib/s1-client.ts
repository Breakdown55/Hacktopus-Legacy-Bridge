import type { Project } from './types';

export const s1Enabled = process.env.NEXT_PUBLIC_LB_DEMO_MODE === '1'
  || (process.env.NODE_ENV === 'development' && process.env.NEXT_PUBLIC_LB_S1_UI === '1');

type Identity = { orgId: string; userId: string };
type Options = { method?: string; data?: unknown; body?: BodyInit; headers?: HeadersInit; signal?: AbortSignal };
export type S1Project = {
  id: string;
  name: string;
  description: string;
  target_language: string;
  created_at: string;
  last_activity_at?: string;
  progress: { completed_steps: number; needs_input: { step: string; code: string }[] };
  heads: {
    current_source_revision_id: string | null;
    approved_scope_revision_id: string | null;
    current_module_revision_id: string | null;
    current_case_set_revision_id: string | null;
    current_policy_id: string | null;
  };
};

export function pickerProject(value: S1Project): Project {
  return {
    id: value.id, name: value.name, description: value.description, edited: Date.parse(value.last_activity_at ?? value.created_at),
    complete: value.progress.completed_steps, needs: value.progress.needs_input.length > 0,
    selected: [], features: [],
  };
}

let identity: Promise<Identity> | undefined;
async function check(response: Response) {
  if (response.ok) return response;
  const error = await response.json().catch(() => null);
  const fields = error?.fields?.map((field: { path: string }) => field.path).join(', ');
  throw new Error((error?.detail || error?.title || 'Request failed (' + response.status + ')') + (fields ? ': ' + fields : ''));
}

async function request(path: string, options: Options = {}) {
  identity ??= fetch('/api/s1/config', { cache: 'no-store' }).then(check).then(res => res.json()).catch(error => {
    identity = undefined;
    throw error;
  });
  const { orgId, userId } = await identity;
  const headers = new Headers(options.headers);
  headers.set('x-org-id', orgId);
  headers.set('x-user-id', userId);
  if (options.method === 'POST') headers.set('idempotency-key', crypto.randomUUID());
  if (options.data !== undefined) headers.set('content-type', 'application/json');
  return check(await fetch(path, {
    method: options.method, headers, cache: 'no-store', signal: options.signal,
    body: options.data === undefined ? options.body : JSON.stringify(options.data),
  }));
}

export function s1Blob(path: string) { return request('/api/s1' + path).then(res => res.blob()); }
export function s1ApiBlob(path: string) { return request('/api/v1' + path).then(res => res.blob()); }

export async function s1<T = void>(path: string, options?: Options): Promise<T> {
  const res = await request('/api/v1' + path, options);
  return res.status === 204 ? undefined as T : await res.json();
}

export async function s1Local<T = void>(path: string, options?: Options): Promise<T> {
  const res = await request('/api/s1' + path, options);
  return res.status === 204 ? undefined as T : await res.json();
}

export function post<T>(path: string, data?: unknown) { return s1<T>(path, { method: 'POST', data }); }

export async function waitJob<T = unknown>(id: string, signal: AbortSignal) {
  while (!signal.aborted) {
    const job = await s1<{ status: string; progress: T; error?: { code: string; reason?: string } | null }>(`/jobs/${id}`, { signal });
    if (job.status === 'succeeded') return job.progress;
    if (job.status === 'failed' || job.status === 'cancelled') {
      throw new Error('Job ' + job.status + (job.error?.code ? ' (' + job.error.code + ')' : '') + (job.error?.reason ? ': ' + job.error.reason : ''));
    }
    await new Promise(resolve => setTimeout(resolve, 1300));
  }
  throw signal.reason;
}

/** Waits for a job whose failure should not stop the caller. Leaving the page still stops it: an aborted wait always throws. */
export async function settleJob(id: string, signal: AbortSignal): Promise<boolean> {
  try { await waitJob(id, signal); return true; }
  catch (error) { signal.throwIfAborted(); void error; return false; }
}

export async function sendArtifact(project: string, file: File, artifactPath: string, role: string) {
  if (file.size > 16 * 1024 * 1024) throw new Error('Choose a file up to 16 MiB.');
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()));
  const sha256 = Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('');
  const upload = await post<{ upload_id: string }>(project + '/uploads', { filename: file.name, size: file.size, sha256 });
  await s1Local('/uploads/' + upload.upload_id, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: file });
  const complete = await post<{ status: string }>('/uploads/' + upload.upload_id + '/complete');
  if (complete.status !== 'received') throw new Error('Upload was not received.');
  return { upload_id: upload.upload_id, path: artifactPath, role };
}
