import type { CookieOptions, Request, Response } from 'express';

/** The cookie that carries the session token (KD-2). */
export const SESSION_COOKIE = 'aos_session';

const SESSION_COOKIE_OPTIONS: CookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  path: '/',
};

const DEFAULT_FRONTEND_ORIGIN = 'http://localhost:3000';

/** The web's origin: the CORS origin and the only `Origin` a changing request with the cookie may carry (DC-3). */
export function frontendOrigin(env: NodeJS.ProcessEnv = process.env): string {
  return env.FRONTEND_ORIGIN ?? DEFAULT_FRONTEND_ORIGIN;
}

/** A cookie value from the `Cookie` header, or undefined when it is absent or empty. */
function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (header === undefined) return undefined;
  for (const pair of header.split(';')) {
    const separator = pair.indexOf('=');
    if (separator < 0 || pair.slice(0, separator).trim() !== name) continue;
    const value = pair.slice(separator + 1).trim();
    return value === '' ? undefined : value;
  }
  return undefined;
}

/** The session token of the request, if the browser sent one. */
export function readSessionToken(req: Request): string | undefined {
  return readCookie(req, SESSION_COOKIE);
}

/** Gives the browser the session token: `HttpOnly; SameSite=Lax; Path=/`. */
export function setSessionCookie(res: Response, token: string): void {
  res.cookie(SESSION_COOKIE, token, SESSION_COOKIE_OPTIONS);
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, SESSION_COOKIE_OPTIONS);
}
