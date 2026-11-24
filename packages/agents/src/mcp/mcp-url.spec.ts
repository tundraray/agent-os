import { checkServerUrl } from './mcp-url';

// Security Considerations (`https` outside development): a server or authorization-server address must be https;
// http passes only where development allows it, any other scheme never.

describe('a server or authorization-server address must be https unless http is allowed', () => {
  it.each([
    ['https in production', 'https://mcp.sentry.dev/mcp', false, 'ok'],
    ['https in development', 'https://mcp.sentry.dev/mcp', true, 'ok'],
    ['http in development', 'http://localhost:4100/logs', true, 'ok'],
    ['http in production', 'http://localhost:4100/logs', false, 'insecure_url'],
    [
      'ftp even in development',
      'ftp://files.example.com/mcp',
      true,
      'insecure_url',
    ],
    ['a string that is not an address', 'not a url', true, 'insecure_url'],
  ] as const)('%s', (_case, url, allowHttp, expected) => {
    expect(checkServerUrl(url, { allowHttp })).toBe(expected);
  });
});
