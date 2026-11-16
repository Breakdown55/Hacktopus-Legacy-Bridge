import { createHash, timingSafeEqual } from 'node:crypto';

export function sameSecret(actual: string | null | undefined, expected: string) {
  if (!actual || !expected) return false;
  return timingSafeEqual(createHash('sha256').update(actual).digest(), createHash('sha256').update(expected).digest());
}

export function demoPath(pathname: string) {
  return pathname.startsWith('/api/v1/') || ['/api/s1/config', '/api/s1/workspace'].includes(pathname)
    || /^\/api\/s1\/(?:uploads|exports)\/[a-zA-Z0-9-]+$/.test(pathname);
}
