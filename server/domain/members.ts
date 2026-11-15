import { uuidv7 } from '../db/ids';
import type { Db } from '../db/db';
import type { Ctx } from './ctx';
import { DomainError } from './errors';

export type MemberRole = 'viewer' | 'editor' | 'admin';

export async function listMembers(c: Ctx) {
  return c.db.query<{ user_id: string; email: string; display_name: string | null; role: MemberRole; created_at: string }>(
    `SELECT m.user_id, u.email, u.display_name, m.role, m.created_at FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.org_id=$1 ORDER BY m.created_at, m.user_id`, [c.orgId]);
}

const event = (t: Db, c: Ctx, type: string, userId: string, data: Record<string, unknown>) =>
  t.query(`INSERT INTO events(org_id,actor_id,type,subject_type,subject_id,data) VALUES ($1,$2,$3,'user',$4,$5)`, [c.orgId, c.userId, type, userId, JSON.stringify(data)]);

/** Locks the org's admin rows so two concurrent demotions or removals cannot both pass the last-admin check. */
async function lockAdmins(t: Db, orgId: string) {
  return (await t.query<{ user_id: string }>("SELECT user_id FROM memberships WHERE org_id=$1 AND role='admin' ORDER BY user_id FOR UPDATE", [orgId])).map((r) => r.user_id);
}

/** Invites by email: links an existing user or creates a placeholder user row that the IdP login later claims by email. */
export async function addMember(c: Ctx, email: string, role: MemberRole) {
  const e = email.trim().toLowerCase();
  return c.db.tx(async (t) => {
    let u = (await t.query<{ id: string }>('SELECT id FROM users WHERE lower(email)=$1', [e]))[0];
    if (!u) {
      u = { id: uuidv7() };
      await t.query('INSERT INTO users(id,email) VALUES ($1,$2)', [u.id, e]);
    }
    const had = await t.query('SELECT 1 FROM memberships WHERE org_id=$1 AND user_id=$2', [c.orgId, u.id]);
    if (had.length) throw new DomainError('already_member', 409);
    await t.query('INSERT INTO memberships(org_id,user_id,role) VALUES ($1,$2,$3)', [c.orgId, u.id, role]);
    await event(t, c, 'member.added', u.id, { role });
    return { user_id: u.id, email: e, role };
  });
}

export async function changeRole(c: Ctx, userId: string, role: MemberRole) {
  if (!/^[0-9a-f-]{36}$/.test(userId)) throw new DomainError('not_found', 404);
  return c.db.tx(async (t) => {
    const admins = await lockAdmins(t, c.orgId);
    const cur = (await t.query<{ role: MemberRole }>('SELECT role FROM memberships WHERE org_id=$1 AND user_id=$2 FOR UPDATE', [c.orgId, userId]))[0];
    if (!cur) throw new DomainError('not_found', 404);
    if (cur.role === role) return { user_id: userId, role };
    if (cur.role === 'admin' && admins.length <= 1) throw new DomainError('last_admin', 409, 'An organization needs at least one admin.');
    await t.query('UPDATE memberships SET role=$3 WHERE org_id=$1 AND user_id=$2', [c.orgId, userId, role]);
    await event(t, c, 'member.role_changed', userId, { from: cur.role, to: role });
    return { user_id: userId, role };
  });
}

export async function removeMember(c: Ctx, userId: string) {
  if (!/^[0-9a-f-]{36}$/.test(userId)) throw new DomainError('not_found', 404);
  await c.db.tx(async (t) => {
    const admins = await lockAdmins(t, c.orgId);
    const cur = (await t.query<{ role: MemberRole }>('SELECT role FROM memberships WHERE org_id=$1 AND user_id=$2 FOR UPDATE', [c.orgId, userId]))[0];
    if (!cur) throw new DomainError('not_found', 404);
    if (cur.role === 'admin' && admins.length <= 1) throw new DomainError('last_admin', 409, 'An organization needs at least one admin.');
    await t.query('DELETE FROM memberships WHERE org_id=$1 AND user_id=$2', [c.orgId, userId]);
    await event(t, c, 'member.removed', userId, { role: cur.role });
  });
}
