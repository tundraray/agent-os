import {
  LOCALE_COOKIE,
  THEME_COOKIE,
  type Language,
  type ThemeId,
} from '@agent-os/contracts';
import type { CookieOptions, Request, Response } from 'express';

/** The cookie that carries the session token (KD-2). */
export const SESSION_COOKIE = 'aos_session';

const DEFAULT_FRONTEND_ORIGIN = 'http://localhost:3000';

/** A year, as the web's `chooseTheme` keeps the theme cookie (theming design-engine.md, Contract «Cookie `aos_theme`»). */
const THEME_COOKIE_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * The web's origin: the address the browser opens Agent OS at, the only `Origin` a changing request
 * may carry (DC-3), and the public address when none is saved (KD-3 of web-image).
 */
export function frontendOrigin(env: NodeJS.ProcessEnv = process.env): string {
  return env.FRONTEND_ORIGIN ?? DEFAULT_FRONTEND_ORIGIN;
}

/**
 * `HttpOnly; SameSite=Lax; Path=/` of the API's cookies, plus `Secure` when the web is served over
 * `https`; development on `http://localhost` keeps it off, or the browser would drop the cookie.
 */
export function cookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: frontendOrigin().startsWith('https://'),
  };
}

/** A cookie value from the `Cookie` header, or undefined when it is absent or empty. */
export function readCookie(req: Request, name: string): string | undefined {
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

/** Gives the browser the session token (`cookieOptions`). */
export function setSessionCookie(res: Response, token: string): void {
  res.cookie(SESSION_COOKIE, token, cookieOptions());
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, cookieOptions());
}

/** Gives the browser the chosen language, or removes the cookie when there is no choice (`null`). */
export function setLocaleCookie(
  res: Response,
  language: Language | null,
): void {
  if (language === null) res.clearCookie(LOCALE_COOKIE, cookieOptions());
  else res.cookie(LOCALE_COOKIE, language, cookieOptions());
}

/**
 * The options of the theme cookie: those of every API cookie but without `HttpOnly`, so the web's head script reads
 * it and `chooseTheme` overwrites the same cookie (theming design-preference.md, KD-3).
 */
function themeCookieOptions(): CookieOptions {
  return { ...cookieOptions(), httpOnly: false };
}

/** Gives the browser the employee's effective theme at sign-in, so the first page is painted in it. */
export function setThemeCookie(res: Response, theme: ThemeId): void {
  res.cookie(THEME_COOKIE, theme, {
    ...themeCookieOptions(),
    maxAge: THEME_COOKIE_MAX_AGE_MS,
  });
}

export function clearThemeCookie(res: Response): void {
  res.clearCookie(THEME_COOKIE, themeCookieOptions());
}
