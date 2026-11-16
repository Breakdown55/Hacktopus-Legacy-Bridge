import { NextResponse, type NextRequest } from 'next/server';
import { demoPath } from './server/demo/access';

/** Demo deployment only. The local development server keeps its existing auth and API behavior. */
export function proxy(request: NextRequest) {
  if (process.env.NEXT_PUBLIC_LB_DEMO_MODE !== '1') return NextResponse.next();
  const bridgeKey = process.env.LB_DEMO_BRIDGE_KEY;
  const origin = process.env.LB_DEMO_BACKEND_URL;
  const noStore = { 'cache-control': 'private, no-store' };
  if (!bridgeKey || bridgeKey.length < 32 || !origin) {
    return new NextResponse('The demo connection is not configured.', { status: 503, headers: noStore });
  }
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
    const refererOrigin = request.headers.get('origin');
    if (request.headers.get('sec-fetch-site') === 'cross-site' || (refererOrigin && refererOrigin !== request.nextUrl.origin)) {
      return new NextResponse('Cross-site request rejected.', { status: 403, headers: noStore });
    }
  }
  if (request.nextUrl.pathname.startsWith('/api/')) {
    if (!demoPath(request.nextUrl.pathname)) return new NextResponse('Not found', { status: 404, headers: noStore });
    let backend: URL;
    try {
      backend = new URL(origin);
      if (backend.protocol !== 'https:' || backend.username || backend.password || backend.pathname !== '/' || backend.search || backend.hash) throw new Error();
    } catch { return new NextResponse('The demo backend URL must be an HTTPS origin.', { status: 503, headers: noStore }); }
    const headers = new Headers(request.headers);
    headers.delete('authorization');
    headers.delete('cookie');
    headers.delete('x-org-id');
    headers.delete('x-user-id');
    headers.set('x-lb-demo-bridge-key', bridgeKey);
    backend.pathname = request.nextUrl.pathname;
    backend.search = request.nextUrl.search;
    return NextResponse.rewrite(backend, { request: { headers }, headers: noStore });
  }
  return NextResponse.next({ headers: noStore });
}

export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] };
