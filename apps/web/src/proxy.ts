import { NextResponse } from 'next/server';

// The root layout is prerendered at build, so the browser learns the runtime DSN from this cookie,
// read synchronously in `instrumentation-client.ts` before hydration (design-web-image.md, KD-4).
export function proxy(): NextResponse {
  const response = NextResponse.next();
  response.cookies.set('aos_sentry_dsn', process.env.SENTRY_DSN ?? '', { path: '/', sameSite: 'lax' });
  return response;
}

export const config = {
  matcher: ['/((?!api/|_next/).*)'],
};
