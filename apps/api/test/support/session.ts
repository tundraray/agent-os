import { createHash, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { AdminUserSummarySchema, CurrentUserSchema } from '@agent-os/contracts';
import {
  DATABASE_CONNECTION,
  type DatabaseConnection,
  IdentityRolesRepository,
  IdentitySessionsRepository,
  IdentityUsersRepository,
} from '@agent-os/db';
import request, { type Test } from 'supertest';
import type { App } from 'supertest/types.js';
import { AuditLog } from '../../src/audit/audit-log';
import { hashPassword } from '../../src/identity/password';
import {
  SESSION_COOKIE,
  frontendOrigin,
} from '../../src/identity/session-cookie';
import { seedSuperAdmin as seedSuperAdminRow } from '../../src/identity/super-admin';

/**
 * Sign-in for the e2e suites (design-identity.md, Contract «Вход в тестах»): an employee signs in through
 * `POST /api/auth/password` and the test carries the session cookie; the employee id comes from
 * `GET /api/auth/me`. Every request of the helpers sends the web's `Origin` (DC-3).
 */

/** A signed-in employee: the server's id and the `Cookie` header value (`aos_session=<token>`). */
export interface Session {
  readonly id: string;
  readonly cookie: string;
}

export type Method = 'get' | 'post' | 'patch' | 'put' | 'delete';

/** A password every helper account gets unless the test names one. */
const DEFAULT_PASSWORD = 'e2e-password-12';

/** The headers of a request as `session`: the cookie and the web's origin. */
export function sessionHeaders(session: Session): Record<string, string> {
  return { cookie: session.cookie, origin: frontendOrigin() };
}

/** The port the app listens on (`createTestApp` makes it listen). */
export function portOf(app: INestApplication<App>): number {
  const address = (app.getHttpServer() as Server).address();
  if (address === null || typeof address === 'string') {
    throw new Error(
      'The app does not listen on a TCP port: boot it with createTestApp',
    );
  }
  return (address as AddressInfo).port;
}

/**
 * `http://localhost:<port>` of the app: the address a browser uses, so the API derives its public URL
 * (AC-03.4) and the provider redirect URI from `localhost`, not from `127.0.0.1`.
 */
export function apiOrigin(app: INestApplication<App>): string {
  return `http://localhost:${portOf(app)}`;
}

/** A supertest request under `/api` with the session cookie (or none); the body, when given, is sent as JSON. */
export function apiRequest(
  app: INestApplication<App>,
  session: Pick<Session, 'cookie'> | null,
  method: Method,
  path: string,
  body?: object,
): Test {
  const test = request(apiOrigin(app))
    [method](`/api${path}`)
    .set('origin', frontendOrigin());
  if (session !== null) test.set('cookie', session.cookie);
  return body === undefined ? test : test.send(body);
}

/** `aos_session=<token>` from the `Set-Cookie` headers of a sign-in. */
export function sessionCookieOf(
  setCookie: string | string[] | undefined,
): string {
  const headers =
    typeof setCookie === 'string' ? [setCookie] : (setCookie ?? []);
  const found = headers.find((header) =>
    header.startsWith(`${SESSION_COOKIE}=`),
  );
  if (found === undefined)
    throw new Error(`The sign-in set no ${SESSION_COOKIE} cookie`);
  return found.split(';')[0] ?? found;
}

/** Signs in with a login and a password (204 + cookie) and reads the employee id from `GET /api/auth/me`. */
export async function signInWithPassword(
  app: INestApplication<App>,
  login: string,
  password: string,
): Promise<Session> {
  const signedIn = await apiRequest(app, null, 'post', '/auth/password', {
    login,
    password,
  });
  if (signedIn.status !== 204) {
    throw new Error(
      `Sign-in of ${login} answered ${signedIn.status}: ${JSON.stringify(signedIn.body)}`,
    );
  }
  const cookie = sessionCookieOf(signedIn.headers['set-cookie']);
  const me = await apiRequest(app, { cookie }, 'get', '/auth/me');
  if (me.status !== 200)
    throw new Error(
      `GET /auth/me answered ${me.status}: ${JSON.stringify(me.body)}`,
    );
  return { id: CurrentUserSchema.parse(me.body).id, cookie };
}

/**
 * The first administrator: the operator command's function (`seedSuperAdmin` of T2.1) over the app's
 * database, without the process; then signs in as it.
 */
export async function seedSuperAdmin(
  app: INestApplication<App>,
  login: string,
  password = DEFAULT_PASSWORD,
): Promise<Session> {
  const { db } = app.get<DatabaseConnection>(DATABASE_CONNECTION);
  await seedSuperAdminRow(
    db,
    {
      users: app.get(IdentityUsersRepository),
      roles: app.get(IdentityRolesRepository),
      sessions: app.get(IdentitySessionsRepository),
    },
    app.get(AuditLog),
    { login, name: login, email: `${login}@example.test`, password },
  );
  return signInWithPassword(app, login, password);
}

/** How long ago a session was opened and last used. */
export interface SessionAge {
  createdMinutesAgo: number;
  lastSeenMinutesAgo: number;
}

/**
 * Moves the timestamps of the session behind `cookie` into the past (the clock is never faked); the row
 * is found by the SHA-256 of the cookie's token, as the API stores it.
 */
export async function ageSession(
  pool: DatabaseConnection['pool'],
  cookie: string,
  age: SessionAge,
): Promise<void> {
  const token = cookie.slice(`${SESSION_COOKIE}=`.length);
  const moved = await pool.query(
    `UPDATE app.identity_sessions
        SET created_at = now() - make_interval(mins => $2),
            last_seen_at = now() - make_interval(mins => $3)
      WHERE token_hash = $1`,
    [
      createHash('sha256').update(token).digest('hex'),
      age.createdMinutesAgo,
      age.lastSeenMinutesAgo,
    ],
  );
  if (moved.rowCount !== 1)
    throw new Error(
      `No session row for the cookie (${moved.rowCount} rows moved)`,
    );
}

/**
 * A local employee written straight into `identity_users` over `pool`, for a suite that makes its
 * employees before the app boots. Returns the id; the employee signs in with `signInWithPassword` after
 * the boot.
 */
export async function insertEmployee(
  pool: DatabaseConnection['pool'],
  employee: { login: string; name?: string; email?: string; password: string },
): Promise<string> {
  const login = employee.login.toLowerCase();
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO app.identity_users (email, name, login, password_hash)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [
      (employee.email ?? `${login}@example.test`).toLowerCase(),
      employee.name ?? login,
      login,
      await hashPassword(employee.password),
    ],
  );
  const id = inserted.rows[0]?.id;
  if (id === undefined) throw new Error(`No identity_users row for ${login}`);
  return id;
}

export interface NewEmployee {
  login?: string;
  name?: string;
  email?: string;
  password?: string;
}

/**
 * A local employee created by `admin` through `POST /api/admin/users` (test-unique login and email by
 * default), signed in.
 */
export async function createEmployee(
  app: INestApplication<App>,
  admin: Session,
  employee: NewEmployee = {},
): Promise<Session> {
  const login = employee.login ?? `e2e-${randomUUID()}`;
  const password = employee.password ?? DEFAULT_PASSWORD;
  const created = await apiRequest(app, admin, 'post', '/admin/users', {
    login,
    name: employee.name ?? login,
    email: employee.email ?? `${login}@example.test`,
    password,
  });
  if (created.status !== 201) {
    throw new Error(
      `POST /admin/users answered ${created.status}: ${JSON.stringify(created.body)}`,
    );
  }
  AdminUserSummarySchema.parse(created.body);
  return signInWithPassword(app, login, password);
}
