import type { INestApplication } from '@nestjs/common';
import type { Response } from 'supertest';
import type { App } from 'supertest/types.js';
import { apiRequest, type Session } from './session.js';

/**
 * The browser's half of an MCP connection over HTTP (design-mcp-connect.md, Contract «Подключения
 * сотрудника»): redirects are read, never followed, so the session cookie goes only to the API.
 */

/** What the authorization server put on its redirect back to the platform. */
export interface OAuthReturn {
  readonly state?: string;
  readonly code?: string;
  readonly iss?: string;
  readonly error?: string;
}

/** The `Location` of a 302, or a failure naming the status and the body. */
function locationOf(response: Response): string {
  const location = response.headers.location;
  if (response.status !== 302 || typeof location !== 'string') {
    throw new Error(
      `Expected a 302 redirect, got ${response.status}: ${response.text}`,
    );
  }
  return location;
}

/**
 * `GET /api<path>` (an employee's or an admin's connect route) as `session`: the `Location` of its 302 —
 * the authorization address, or the web page of a refused start.
 */
export async function beginConnect(
  app: INestApplication<App>,
  session: Session,
  path: string,
): Promise<string> {
  return locationOf(await apiRequest(app, session, 'get', path));
}

/**
 * Opens the authorization address on the fixture's authorization server as `account` (it signs the
 * account in without a consent screen); returns the parameters of its redirect back.
 */
export async function authorize(
  url: string,
  options: { readonly account?: string } = {},
): Promise<OAuthReturn> {
  const target = new URL(url);
  if (options.account !== undefined)
    target.searchParams.set('fixture_account', options.account);
  const answer = await fetch(target, { redirect: 'manual' });
  const location = answer.headers.get('location');
  if (answer.status !== 302 || location === null) {
    throw new Error(
      `The authorization address answered ${answer.status}: ${await answer.text()}`,
    );
  }
  const back = new URL(location).searchParams;
  const param = (name: keyof OAuthReturn) => back.get(name) ?? undefined;
  return {
    state: param('state'),
    code: param('code'),
    iss: param('iss'),
    error: param('error'),
  };
}

/** `GET /api/mcp/oauth/callback` with `params`, as `session` or without a cookie (`null`). */
export function returnTo(
  app: INestApplication<App>,
  session: Session | null,
  params: OAuthReturn,
): Promise<Response> {
  const query = new URLSearchParams(
    Object.entries(params).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  return apiRequest(app, session, 'get', `/mcp/oauth/callback?${query}`);
}
