import { NextResponse } from 'next/server';

import { SENTRY_DSN_COOKIE } from '@/sentry-dsn-cookie';

// The root layout is prerendered at build, so the browser learns the runtime DSN from this cookie,
// read synchronously in `instrumentation-client.ts` before hydration (design-web-image.md, KD-4).
export function proxy(): NextResponse {
  const response = NextResponse.next();
  response.cookies.set(SENTRY_DSN_COOKIE, process.env.SENTRY_DSN ?? '', {
    path: '/',
    sameSite: 'lax',
  });
  return response;
}

export const config = {
  matcher: ['/((?!api/|_next/).*)'],
};
