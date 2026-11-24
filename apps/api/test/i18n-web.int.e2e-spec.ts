// i18n / web - integration (real AppModule + real Postgres; the API half of the part's language choice)
// Design Doc: docs/features/i18n/design-web.md, Test Strategy UC-2; PRD: docs/features/i18n/prd.md AC-02.1, AC-02.2 (API half), DC-5 (server half).
// Generated: 2026-11-21 | Budget Used: 1/3 integration, 0/2 E2E (no browser suite exists and CI never starts the web: the journeys are the part's
//   manual L1 scenarios, design-web.md "L1-сценарии в браузере").
// Test Type: Integration. Written alongside the language route, the column and the cookie (work order step 3); first run in the feature's full run.
//
// Harness (follows apps/api/test/support/*, vitest.config.e2e.ts and enterprise-access-identity.int.e2e-spec.ts): one `createTestApp()` per file
//   against the docker-compose Postgres, real AppModule with the real global SessionGuard and Origin check; employees through `createEmployee`
//   (own login per case), sessions through `apiRequest`; responses parsed with `CurrentUserSchema` from `@agent-os/contracts`. The `aos_locale`
//   name comes from `src/identity/session-cookie.ts` (the same helper that writes `aos_session`). Nothing is mocked: this test exists to see the
//   guard, the column and the cookie together. The rows of the employees it made are deleted in `afterAll`, as the sibling file does.
//
// NOT here on purpose (lower level or not automated - see the notes handed to the planner):
//   - the language choice rule (cookie -> Accept-Language -> en): `provenAt: unit`, UC-1, one table-driven test of the pure function
//   - the copy-name suffix per language: `provenAt: unit`, UC-3, rows in `apps/api/src/library/copy-rules.spec.ts`
//   - formats, plural forms, refusal text: `provenAt: unit`, UC-4 and UC-5
//   - that zod rejects `de`: the schema is library behaviour; the row below proves the route is wired to it, once

import { randomUUID } from 'node:crypto';
import { CurrentUserSchema, LOCALE_COOKIE } from '@agent-os/contracts';
import type { INestApplication } from '@nestjs/common';
import type { Response } from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../src/identity/session-cookie';
import { expectBody, expectError } from './support/api';
import { createTestApp, type TestApp } from './support/createTestApp';
import {
  apiRequest,
  createEmployee,
  seedSuperAdmin,
  sessionCookieOf,
  type Session,
} from './support/session';

const TEST_TIMEOUT_MS = 120_000;
const PASSWORD = 'i18n-e2e-password-12';

/** `aos_locale=ru` as the API sets it: the session cookie's attributes, no expiry (development origin, so no `Secure`). */
const SET_RU = {
  value: 'ru',
  attributes: ['httponly', 'path=/', 'samesite=lax'],
};
/** A cookie removed by the API: empty value, expired in 1970, the same attributes. */
const CLEARED = {
  value: '',
  attributes: [
    'expires=thu, 01 jan 1970 00:00:00 gmt',
    'httponly',
    'path=/',
    'samesite=lax',
  ],
};

/** The cookie `name` of the response's `Set-Cookie` headers: its value and its attributes, lower case and sorted. */
function setCookieOf(response: Response, name: string) {
  const raw = response.headers['set-cookie'] as string[] | string | undefined;
  const headers = typeof raw === 'string' ? [raw] : (raw ?? []);
  const header = headers.find((candidate) => candidate.startsWith(`${name}=`));
  if (header === undefined) return undefined;
  const [pair = '', ...attributes] = header.split(';');
  return {
    value: pair.slice(name.length + 1),
    attributes: attributes
      .map((attribute) => attribute.trim().toLowerCase())
      .sort(),
  };
}

let harness: TestApp;
/** The employees this file created; `afterAll` deletes exactly these rows (their sessions go by cascade). */
const createdUserIds = new Set<string>();

function signIn(app: INestApplication<App>, login: string): Promise<Response> {
  return apiRequest(app, null, 'post', '/auth/password', {
    login,
    password: PASSWORD,
  });
}

describe('i18n / web - integration (real AppModule + real Postgres)', () => {
  beforeAll(async () => {
    harness = await createTestApp();
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    await harness?.pool.query(
      'DELETE FROM app.identity_users WHERE id = ANY($1::uuid[])',
      [[...createdUserIds]],
    );
    await harness?.close();
  }, TEST_TIMEOUT_MS);

  // ---------------------------------------------------------------------------------------------------------------
  // INT-1: an employee changes only their own language, and the cookie follows the profile (table-driven)
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-02.1 (API half) "Given сотрудник на странице профиля, when он выбирает русский, then интерфейс сразу переходит на русский, без
  //   повторного входа" - the API must answer 204 with the new `aos_locale` so the refreshed document renders in the new language;
  //   AC-02.2 "Given сотрудник выбрал русский на одном компьютере, when он входит с другого устройства, then интерфейс на русском" - a fresh
  //   sign-in carries the stored choice back as the cookie; DC-5 (server half) "После «Выйти» страница входа на языке браузера, даже если
  //   сотрудник выбрал другой" - sign-out removes the cookie. Design: KD-2, KD-4, Contract Definitions; UC-2.
  // Behavior: PUT /api/auth/me/language / sign-in / sign-out / GET /api/auth/me -> SessionGuard + profile column -> status, `language` in the
  //   profile and the `aos_locale` Set-Cookie on the response.
  // Rows (one request each, literal expected status, error code and cookie value; two employees A and B, both created with no language):
  //   1. A `PUT /api/auth/me/language` `{ language: 'ru' }` -> 204 with `Set-Cookie: aos_locale=ru` carrying the session cookie's attributes
  //      (HttpOnly, SameSite=Lax, Path=/, no expiry); A's `GET /api/auth/me` -> `language: 'ru'` and the same cookie again
  //   2. B's `GET /api/auth/me` -> `language: null` and `aos_locale` removed, not set (A's change did not reach B); B's own `PUT` `en` then
  //      leaves A at `ru`
  //   3. anonymous `PUT /api/auth/me/language` `{ language: 'ru' }` -> 401 AUTH_REQUIRED, no `Set-Cookie`, and no row changed
  //   4. A `PUT` `{ language: 'de' }` -> 400 VALIDATION_FAILED, `GET /api/auth/me` still `ru`, no `Set-Cookie`
  //   5. A signs in again by password with a new client (no cookies) -> `Set-Cookie` holds both `aos_session` and `aos_locale=ru`; B's sign-in
  //      brings back his own `en`; the administrator, who never chose, signs in with `aos_session` and `aos_locale` removed
  //   6. A `POST /api/auth/sign-out` -> 204 and `Set-Cookie` clears both `aos_session` and `aos_locale`
  // Catches: the language route taking an employee id or writing another employee's row (B changed by A), the route open without a session,
  //   a choice that is saved but never comes back on a new sign-in (AC-02.2), a stale `aos_locale` that survives sign-out and shows the next
  //   person on a shared computer the previous employee's language, a cookie that disagrees with the profile after `GET /api/auth/me`.
  // @category: core-functionality
  // @dependency: SessionGuard, Origin check, identity controller, the language column of identity_users, session-cookie helper, Postgres
  // @complexity: medium
  it(
    'INT-1: a language change reaches only the signed-in employee, comes back on a new sign-in, and the aos_locale cookie is set by the choice and cleared by sign-out',
    async () => {
      const { app } = harness;
      const adminLogin = `e2e-i18n-admin-${randomUUID()}`;
      const loginA = `e2e-i18n-a-${randomUUID()}`;
      const loginB = `e2e-i18n-b-${randomUUID()}`;
      const admin = await seedSuperAdmin(app, adminLogin, PASSWORD);
      createdUserIds.add(admin.id);
      const a = await createEmployee(app, admin, {
        login: loginA,
        password: PASSWORD,
      });
      createdUserIds.add(a.id);
      const b = await createEmployee(app, admin, {
        login: loginB,
        password: PASSWORD,
      });
      createdUserIds.add(b.id);
      const languageOf = async (session: Session) => {
        const response = await apiRequest(app, session, 'get', '/auth/me');
        const me = await expectBody(response, 200, CurrentUserSchema);
        return {
          language: me.language,
          cookie: setCookieOf(response, LOCALE_COOKIE),
        };
      };

      // Row 1 - A saves `ru`: 204 with the cookie, and the profile and its cookie agree
      const saved = await apiRequest(app, a, 'put', '/auth/me/language', {
        language: 'ru',
      });
      expect(saved.status).toBe(204);
      expect(setCookieOf(saved, LOCALE_COOKIE)).toEqual(SET_RU);
      expect(await languageOf(a)).toEqual({ language: 'ru', cookie: SET_RU });

      // Row 2 - B is untouched by A's change; B's own change leaves A at `ru`
      expect(await languageOf(b)).toEqual({ language: null, cookie: CLEARED });
      expect(
        (
          await apiRequest(app, b, 'put', '/auth/me/language', {
            language: 'en',
          })
        ).status,
      ).toBe(204);
      expect((await languageOf(a)).language).toBe('ru');

      // Row 3 - no session: 401 AUTH_REQUIRED, no cookie, no row changed
      const anonymous = await apiRequest(
        app,
        null,
        'put',
        '/auth/me/language',
        { language: 'ru' },
      );
      expect((await expectError(anonymous, 401)).errorCode).toBe(
        'AUTH_REQUIRED',
      );
      expect(anonymous.headers['set-cookie']).toBeUndefined();
      const rows = await harness.pool.query<{
        id: string;
        language: string | null;
      }>(
        'SELECT id, language FROM app.identity_users WHERE id = ANY($1::uuid[])',
        [[a.id, b.id, admin.id]],
      );
      expect(
        Object.fromEntries(rows.rows.map((row) => [row.id, row.language])),
      ).toEqual({
        [a.id]: 'ru',
        [b.id]: 'en',
        [admin.id]: null,
      });

      // Row 4 - a language outside the set: 400 VALIDATION_FAILED, no cookie, the choice stays
      const refused = await apiRequest(app, a, 'put', '/auth/me/language', {
        language: 'de',
      });
      expect((await expectError(refused, 400)).errorCode).toBe(
        'VALIDATION_FAILED',
      );
      expect(refused.headers['set-cookie']).toBeUndefined();
      expect((await languageOf(a)).language).toBe('ru');

      // Row 5 - a new sign-in from a clean client brings each employee's own choice back as the cookie
      const againA = await signIn(app, loginA);
      expect(againA.status).toBe(204);
      expect(setCookieOf(againA, SESSION_COOKIE)?.value).not.toBe('');
      expect(setCookieOf(againA, LOCALE_COOKIE)).toEqual(SET_RU);
      const againB = await signIn(app, loginB);
      expect(againB.status).toBe(204);
      expect(setCookieOf(againB, LOCALE_COOKIE)).toEqual({
        ...SET_RU,
        value: 'en',
      });
      const againAdmin = await signIn(app, adminLogin);
      expect(againAdmin.status).toBe(204);
      expect(setCookieOf(againAdmin, SESSION_COOKIE)?.value).not.toBe('');
      expect(setCookieOf(againAdmin, LOCALE_COOKIE)).toEqual(CLEARED);

      // Row 6 - sign-out removes both cookies
      const newA = { cookie: sessionCookieOf(againA.headers['set-cookie']) };
      const signedOut = await apiRequest(app, newA, 'post', '/auth/sign-out');
      expect(signedOut.status).toBe(204);
      expect(setCookieOf(signedOut, SESSION_COOKIE)).toEqual(CLEARED);
      expect(setCookieOf(signedOut, LOCALE_COOKIE)).toEqual(CLEARED);
    },
    TEST_TIMEOUT_MS,
  );
});
