import type { AuthConfig } from '@auth/core';
import { getApp } from '../app';
import { upsertIdpUser } from './users';

export const AUTH_BASE_PATH = '/api/auth';

/**
 * Auth.js (@auth/core) configuration: one generic OIDC provider, stateless encrypted-JWT sessions in an HttpOnly cookie.
 * No Next imports: the route file only forwards the Request. Required env: AUTH_SECRET, OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET.
 * Behind a proxy set AUTH_URL to the public origin (and AUTH_TRUST_HOST=true only if the proxy is trusted).
 */
export function authConfig(env: Record<string, string | undefined> = process.env): AuthConfig {
  const { AUTH_SECRET, OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET } = env;
  if (!AUTH_SECRET || !OIDC_ISSUER || !OIDC_CLIENT_ID || !OIDC_CLIENT_SECRET) throw new Error('AUTH_SECRET, OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET are required for login');
  return {
    basePath: AUTH_BASE_PATH,
    secret: AUTH_SECRET,
    trustHost: env.AUTH_TRUST_HOST === 'true',
    session: { strategy: 'jwt', maxAge: 8 * 60 * 60 },
    providers: [{ id: 'oidc', name: 'Single sign-on', type: 'oidc', issuer: OIDC_ISSUER, clientId: OIDC_CLIENT_ID, clientSecret: OIDC_CLIENT_SECRET, checks: ['pkce', 'state'] }],
    callbacks: {
      async signIn({ profile }) {
        const { db } = await getApp();
        return !!(profile?.sub && (await upsertIdpUser(db, { sub: String(profile.sub), email: profile.email, email_verified: profile.email_verified as boolean | undefined, name: profile.name })));
      },
      async jwt({ token, profile }) {
        if (profile?.sub) {
          const { db } = await getApp();
          const u = await upsertIdpUser(db, { sub: String(profile.sub), email: profile.email, email_verified: profile.email_verified as boolean | undefined, name: profile.name });
          if (u) token.uid = u.id;
        }
        return { uid: token.uid, sub: token.sub, iat: token.iat, exp: token.exp, jti: token.jti }; // no profile data in the cookie
      },
    },
  };
}
