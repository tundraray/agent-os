import { HttpException } from '@nestjs/common';
import type { ProviderType } from '@agent-os/contracts';
import {
  isComplete,
  parseProviderType,
  resolveProviderOptions,
  type FetchFn,
  type ProviderOptions,
  type ProviderOptionsInput,
} from './provider-options.js';

const ISSUER = 'https://idp.example.com';
const DISCOVERY = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint: `${ISSUER}/token`,
  jwks_uri: `${ISSUER}/jwks`,
};

/** A fetch double: answers every request with the given outcome and remembers the URLs asked. */
function fakeFetch(
  answer: () => Promise<Response>,
): FetchFn & { urls: string[] } {
  const urls: string[] = [];
  const fetch = (url: string) => {
    urls.push(url);
    return answer();
  };
  return Object.assign(fetch, { urls });
}

const json =
  (body: unknown, status = 200) =>
  () =>
    Promise.resolve(new Response(JSON.stringify(body), { status }));

/** The status and body of the error a call throws, or `null` when it resolves. */
async function failureOf(
  action: () => unknown,
): Promise<{ status: number; body: unknown } | null> {
  try {
    await action();
    return null;
  } catch (error) {
    if (!(error instanceof HttpException)) throw error;
    return { status: error.getStatus(), body: error.getResponse() };
  }
}

// AC-03.5, DC-6: settings by type, the unknown type, and an oidc issuer that fails discovery is never stored.
describe('provider options by type: completeness, unknown_type and the three PROVIDER_CHECK_FAILED reasons', () => {
  it.each([
    {
      type: 'google',
      options: { clientId: 'id', clientSecret: 's' },
      complete: true,
    },
    { type: 'google', options: { clientId: 'id' }, complete: false },
    {
      type: 'oidc',
      options: { clientId: 'id', clientSecret: 's' },
      complete: false,
    },
    {
      type: 'oidc',
      options: { issuer: ISSUER, clientId: 'id', clientSecret: 's' },
      complete: true,
    },
  ] satisfies {
    type: ProviderType;
    options: ProviderOptions;
    complete: boolean;
  }[])(
    '$type with $options -> complete $complete',
    ({ type, options, complete }) => {
      expect(isComplete(type, options)).toBe(complete);
    },
  );

  it.each([
    { type: 'github', expected: { status: 400, reason: 'unknown_type' } },
    { type: 'GOOGLE', expected: { status: 400, reason: 'unknown_type' } },
    { type: 'oidc', expected: null },
  ])('type $type -> $expected', async ({ type, expected }) => {
    const failure = await failureOf(() => parseProviderType(type));

    expect(failure).toEqual(
      expected && {
        status: expected.status,
        body: expect.objectContaining({
          errorCode: 'VALIDATION_FAILED',
          reason: expected.reason,
        }),
      },
    );
  });

  it.each([
    {
      issuer: 'http://idp.example.com',
      answer: json(DISCOVERY),
      reason: 'insecure_url',
      asked: false,
    },
    {
      issuer: 'idp.example.com',
      answer: json(DISCOVERY),
      reason: 'insecure_url',
      asked: false,
    },
    {
      issuer: ISSUER,
      answer: () => Promise.reject(new TypeError('fetch failed')),
      reason: 'unreachable',
      asked: true,
    },
    {
      issuer: ISSUER,
      answer: json({ error: 'down' }, 503),
      reason: 'unreachable',
      asked: true,
    },
    {
      issuer: ISSUER,
      answer: json({ ...DISCOVERY, issuer: 'https://other.example.com' }),
      reason: 'invalid_document',
      asked: true,
    },
    {
      issuer: ISSUER,
      answer: () => Promise.resolve(new Response('<html>login</html>')),
      reason: 'invalid_document',
      asked: true,
    },
    {
      issuer: ISSUER,
      answer: json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
      }),
      reason: 'invalid_document',
      asked: true,
    },
  ])(
    'oidc issuer $issuer -> 422 $reason',
    async ({ issuer, answer, reason, asked }) => {
      const fetch = fakeFetch(answer);

      const failure = await failureOf(() =>
        resolveProviderOptions({
          type: 'oidc',
          stored: {},
          input: { issuer },
          fetch,
        }),
      );

      expect(failure).toEqual({
        status: 422,
        body: expect.objectContaining({
          errorCode: 'PROVIDER_CHECK_FAILED',
          reason,
        }),
      });
      expect(fetch.urls.length > 0).toBe(asked);
    },
  );

  it.each([
    {
      case: 'oidc issuer passes discovery',
      type: 'oidc',
      stored: {},
      input: { issuer: ISSUER, clientId: 'id', clientSecret: 's' },
      expected: { issuer: ISSUER, clientId: 'id', clientSecret: 's' },
      asked: [`${ISSUER}/.well-known/openid-configuration`],
    },
    {
      case: 'secret kept when not sent, unchanged issuer not checked again',
      type: 'oidc',
      stored: { issuer: ISSUER, clientId: 'old', clientSecret: 's' },
      input: { clientId: 'new' },
      expected: { issuer: ISSUER, clientId: 'new', clientSecret: 's' },
      asked: [],
    },
    {
      case: 'google keeps only its own fields',
      type: 'google',
      stored: {},
      input: { issuer: 'http://evil.example.com', clientId: 'id' },
      expected: { clientId: 'id' },
      asked: [],
    },
  ] satisfies {
    case: string;
    type: ProviderType;
    stored: ProviderOptions;
    input: ProviderOptionsInput;
    expected: ProviderOptions;
    asked: string[];
  }[])('$case', async ({ type, stored, input, expected, asked }) => {
    const fetch = fakeFetch(json(DISCOVERY));

    await expect(
      resolveProviderOptions({ type, stored, input, fetch }),
    ).resolves.toEqual(expected);
    expect(fetch.urls).toEqual(asked);
  });
});
