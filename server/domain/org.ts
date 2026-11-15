import type { Ctx } from './ctx';
import { DomainError } from './errors';
import { effectiveQuota } from './quotas';

export const ORG_SETTINGS = ['execution_enabled', 'external_model_allowed'] as const;
export type OrgSetting = (typeof ORG_SETTINGS)[number];

export async function getOrg(c: Ctx) {
  const o = (await c.db.query<{ id: string; name: string; execution_enabled: boolean; external_model_allowed: boolean; retention_days: number }>('SELECT id, name, execution_enabled, external_model_allowed, retention_days FROM organizations WHERE id=$1', [c.orgId]))[0];
  if (!o) throw new DomainError('not_found', 404);
  return { ...o, quota: await effectiveQuota(c) };
}

/** Admin-only. Each flipped setting writes one org.setting_changed event with the old and new value. */
export async function patchOrg(c: Ctx, patch: Partial<Record<OrgSetting, boolean>>) {
  await c.db.tx(async (t) => {
    const cur = (await t.query<Record<OrgSetting, boolean>>('SELECT execution_enabled, external_model_allowed FROM organizations WHERE id=$1 FOR UPDATE', [c.orgId]))[0];
    if (!cur) throw new DomainError('not_found', 404);
    for (const k of ORG_SETTINGS) {
      const next = patch[k];
      if (next === undefined || next === cur[k]) continue;
      await t.query(`UPDATE organizations SET ${k}=$2 WHERE id=$1`, [c.orgId, next]);
      await t.query(`INSERT INTO events(org_id,actor_id,type,subject_type,subject_id,data) VALUES ($1,$2,'org.setting_changed','organization',$1::uuid::text,$3)`, [c.orgId, c.userId, JSON.stringify({ setting: k, old: cur[k], new: next })]);
    }
  });
  return getOrg(c);
}

const SAFE_KEYS = ['setting', 'old', 'new', 'role', 'from', 'to', 'decision', 'number', 'count'];
const safe = (v: unknown) => typeof v === 'boolean' || typeof v === 'number' || (typeof v === 'string' && v.length <= 64 && /^[\w.:-]+$/.test(v));

/** Org audit trail: ids, types and an allow-list of scalar fields. Never program output, filenames or free text. */
export async function listAuditEvents(c: Ctx, o: { type?: string | null; projectId?: string | null; before?: string | null; limit: number }) {
  const before = o.before && /^\d{1,18}$/.test(o.before) ? o.before : null;
  const rows = await c.db.query<{ id: string; project_id: string | null; actor_id: string | null; type: string; subject_type: string | null; subject_id: string | null; data: Record<string, unknown>; created_at: string }>(
    `SELECT events.id::text AS id, project_id, actor_id, type, subject_type, subject_id, data, created_at FROM events
     WHERE org_id=$1 AND ($2::text IS NULL OR type=$2) AND ($3::uuid IS NULL OR project_id=$3::uuid) AND ($4::bigint IS NULL OR events.id < $4::bigint)
     ORDER BY events.id DESC LIMIT $5`, [c.orgId, o.type ?? null, o.projectId ?? null, before, o.limit + 1]);
  const page = rows.slice(0, o.limit);
  return {
    items: page.map((r) => ({ id: r.id, type: r.type, actor_id: r.actor_id, project_id: r.project_id, subject_type: r.subject_type, subject_id: r.subject_id, created_at: r.created_at,
      data: Object.fromEntries(SAFE_KEYS.flatMap((k) => (r.data && safe(r.data[k]) ? [[k, r.data[k]]] : []))) })),
    next_cursor: rows.length > o.limit ? page[page.length - 1].id : null,
  };
}
