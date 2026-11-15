import { http, HttpResponse } from 'msw';
import { z } from 'zod';
import { afterEach, describe, expect, it } from 'vitest';
import { server } from '@/test/msw-server';
import { apiRequest, setUnauthorizedHandler } from './api-request';

const API = 'http://api.test';

type Case = {
  name: string;
  registerHandler: boolean;
  status: number;
  body: Record<string, unknown>;
  expected: {
    events: string[];
    error: { kind: string; status: number; code?: string; reason?: string; message: string };
  };
};

const cases: Case[] = [
  {
    name: '401 AUTH_REQUIRED reaches the registered handler with its code, then the caller',
    registerHandler: true,
    status: 401,
    body: { statusCode: 401, message: 'Sign in required', errorCode: 'AUTH_REQUIRED' },
    expected: {
      events: ['handler:AUTH_REQUIRED', 'caller'],
      error: { kind: 'http', status: 401, code: 'AUTH_REQUIRED', message: 'Sign in required' },
    },
  },
  {
    name: '401 without a registered handler still reaches the caller',
    registerHandler: false,
    status: 401,
    body: { statusCode: 401, message: 'Account disabled', errorCode: 'ACCOUNT_DISABLED' },
    expected: {
      events: ['caller'],
      error: { kind: 'http', status: 401, code: 'ACCOUNT_DISABLED', message: 'Account disabled' },
    },
  },
  {
    name: '400 carries reason and message from the body and skips the 401 handler',
    registerHandler: true,
    status: 400,
    body: {
      statusCode: 400,
      message: 'Password too weak',
      errorCode: 'VALIDATION_FAILED',
      reason: 'weak_password',
    },
    expected: {
      events: ['caller'],
      error: {
        kind: 'http',
        status: 400,
        code: 'VALIDATION_FAILED',
        reason: 'weak_password',
        message: 'Password too weak',
      },
    },
  },
];

afterEach(() => {
  setUnauthorizedHandler(null);
});

// DC-13 (core share): 401 goes to the registered handler with its code before the caller gets the error
describe('apiRequest: error answers', () => {
  it.each(cases)('$name', async ({ registerHandler, status, body, expected }) => {
    const events: string[] = [];
    if (registerHandler) setUnauthorizedHandler((code) => events.push(`handler:${code}`));
    server.use(http.post(`${API}/api/thing`, () => HttpResponse.json(body, { status })));

    const error = await apiRequest({
      path: '/api/thing',
      method: 'POST',
      body: {},
      schema: z.object({}),
    }).then(
      () => undefined,
      (reason: unknown) => {
        events.push('caller');
        return reason;
      },
    );

    expect(events).toEqual(expected.events);
    expect(error).toMatchObject({ name: 'ApiRequestError', ...expected.error });
  });
});
