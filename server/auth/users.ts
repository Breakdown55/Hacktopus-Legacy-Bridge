import type { Db } from '../db/db';
import { uuidv7 } from '../db/ids';

export interface IdpProfile { sub: string; email?: string | null; email_verified?: boolean | null; name?: string | null }

/**
 * Maps an IdP identity to a local user. Logging in never grants access to an organization: that needs a membership
 * (created by the bootstrap CLI or an admin's invitation).
 *  - known idp_subject: that user.
 *  - an invited user row (same email, no idp_subject yet): linked ONLY when the IdP says the email is verified,
 *    otherwise anyone able to register an unverified address at the IdP could take over an invitation.
 *  - otherwise a new user.
 * Returns null when the identity must be refused.
 */
export async function upsertIdpUser(db: Db, p: IdpProfile): Promise<{ id: string; email: string } | null> {
  if (!p.sub) return null;
  const email = (p.email ?? '').trim().toLowerCase();
  const bySub = (await db.query<{ id: string; email: string }>('SELECT id, email FROM users WHERE idp_subject=$1', [p.sub]))[0];
  if (bySub) return bySub;
  if (!email) return null;
  const byEmail = (await db.query<{ id: string; idp_subject: string | null }>('SELECT id, idp_subject FROM users WHERE lower(email)=$1', [email]))[0];
  if (byEmail) {
    if (byEmail.idp_subject || p.email_verified !== true) return null;
    const linked = await db.query<{ id: string }>('UPDATE users SET idp_subject=$2, display_name=COALESCE(display_name,$3) WHERE id=$1 AND idp_subject IS NULL RETURNING id', [byEmail.id, p.sub, p.name ?? null]);
    return linked[0] ? { id: byEmail.id, email } : null;
  }
  const id = uuidv7();
  await db.query('INSERT INTO users(id,email,display_name,idp_subject) VALUES ($1,$2,$3,$4)', [id, email, p.name ?? null, p.sub]);
  return { id, email };
}
