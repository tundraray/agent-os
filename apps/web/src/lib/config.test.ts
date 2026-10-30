import { afterEach, describe, expect, it, vi } from 'vitest';

const importConfig = async () => {
  vi.resetModules();
  return import('./config');
};

describe('lib/config: NEXT_PUBLIC_API_URL', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    { name: 'unset', value: undefined },
    { name: 'not an absolute URL', value: 'localhost:4000' },
    { name: 'not http(s)', value: 'ftp://x' },
  ])('throws on import when the value is $name', async ({ value }) => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', value);

    await expect(importConfig()).rejects.toThrow('NEXT_PUBLIC_API_URL must be an absolute http(s) URL');
  });

  it.each([
    { value: 'http://api.test/', expected: 'http://api.test' },
    { value: 'https://api.example.com//', expected: 'https://api.example.com' },
  ])('exposes $value as apiBaseUrl $expected without the trailing slash', async ({ value, expected }) => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', value);

    const { apiBaseUrl } = await importConfig();

    expect(apiBaseUrl).toBe(expected);
  });

  it('throws on import in production when the value is plain http to a remote host', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'http://api.example.com');

    await expect(importConfig()).rejects.toThrow(
      'NEXT_PUBLIC_API_URL must use https in production (http is allowed only for localhost)',
    );
  });

  it.each([
    { nodeEnv: 'production', value: 'http://localhost:4000', expected: 'http://localhost:4000' },
    { nodeEnv: 'production', value: 'http://127.0.0.1:4000', expected: 'http://127.0.0.1:4000' },
    { nodeEnv: 'production', value: 'http://[::1]:4000', expected: 'http://[::1]:4000' },
    { nodeEnv: 'production', value: 'https://api.example.com', expected: 'https://api.example.com' },
    { nodeEnv: 'development', value: 'http://api.example.com', expected: 'http://api.example.com' },
  ])('accepts $value when NODE_ENV is $nodeEnv', async ({ nodeEnv, value, expected }) => {
    vi.stubEnv('NODE_ENV', nodeEnv);
    vi.stubEnv('NEXT_PUBLIC_API_URL', value);

    const { apiBaseUrl } = await importConfig();

    expect(apiBaseUrl).toBe(expected);
  });
});
