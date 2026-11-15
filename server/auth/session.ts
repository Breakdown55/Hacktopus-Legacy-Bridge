import { getToken } from '@auth/core/jwt';
import type { Db } from '../db/db';

const UUID = /^[0-9a-f-]{36}$/;

/**
 * Resolves the signed-in user from the Auth.js session cookie. Only the cookie is read: an Authorization header is ignored
 * (getToken would otherwise accept a bearer token). Returns null for a missing, forged, expired or unknown-user session.
 */
export async function sessionUserId(req: Request, db: Db, env: Record<string, string | undefined> = process.env): Promise<string | null> {
  const secret = env.AUTH_SECRET;
  if (!secret) return null;
  const cookie = req.headers.get('cookie');
  if (!cookie) return null;
  const secure = new URL(req.url).protocol === 'https:' || env.AUTH_URL?.startsWith('https://') === true;
  let token;
  try { token = await getToken({ req: { headers: new Headers({ cookie }) }, secret, secureCookie: secure }); } catch { return null; }
  const uid = typeof token?.uid === 'string' ? token.uid : null;
  if (!uid || !UUID.test(uid)) return null;
  return (await db.query('SELECT 1 FROM users WHERE id=$1', [uid])).length ? uid : null;
}
