import type { Db } from './db';
import { uuidv7 } from './ids';

/**
 * Operator-only: creates (or reuses) an organization by name and an admin membership for an email.
 * Idempotent. The web app has no way to create a first admin; this needs database access.
 * The user signs in later through the IdP; the row is linked by verified email on first login.
 */
export async function bootstrapAdmin(db: Db, o: { email: string; org: string }) {
  const email = o.email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(email) || !o.org.trim()) throw new Error('A valid --email and a non-empty --org are required');
  return db.tx(async (t) => {
    let org = (await t.query<{ id: string }>('SELECT id FROM organizations WHERE name=$1 ORDER BY created_at LIMIT 1', [o.org.trim()]))[0]?.id;
    if (!org) { org = uuidv7(); await t.query('INSERT INTO organizations(id,name) VALUES ($1,$2)', [org, o.org.trim()]); }
    let user = (await t.query<{ id: string }>('SELECT id FROM users WHERE lower(email)=$1', [email]))[0]?.id;
    if (!user) { user = uuidv7(); await t.query('INSERT INTO users(id,email) VALUES ($1,$2)', [user, email]); }
    const had = (await t.query('SELECT 1 FROM memberships WHERE org_id=$1 AND user_id=$2', [org, user])).length > 0;
    if (!had) {
      await t.query("INSERT INTO memberships(org_id,user_id,role) VALUES ($1,$2,'admin')", [org, user]);
      await t.query("INSERT INTO events(org_id,type,subject_type,subject_id,data) VALUES ($1,'member.added','user',$2,$3)", [org, user, JSON.stringify({ role: 'admin', via: 'bootstrap-admin' })]);
    } else await t.query("UPDATE memberships SET role='admin' WHERE org_id=$1 AND user_id=$2 AND role<>'admin'", [org, user]);
    return { org_id: org, user_id: user, created_membership: !had };
  });
}
