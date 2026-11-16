import { publicUrlOf } from './public-url.js';

// AC-03.4: redirectUri is built from the public address; a path or `/api` in it would break the callback,
// and an address that is not `https` (or `http://localhost`) must never be saved from a request.
describe('public URL from the request: scheme and host only, and only a valid public address', () => {
  it.each([
    {
      request: {
        protocol: 'http',
        headers: { host: 'localhost:5173' },
        originalUrl: '/api/admin/providers',
      },
      expected: 'http://localhost:5173',
    },
    {
      request: {
        protocol: 'https',
        headers: { host: 'aos.example.com' },
        originalUrl: '/api/admin/providers/1',
      },
      expected: 'https://aos.example.com',
    },
    {
      // `http` behind a TLS proxy that does not pass the scheme on
      request: { protocol: 'http', headers: { host: 'aos.example.com' } },
      expected: undefined,
    },
    {
      request: { protocol: 'https', headers: { host: 'user@aos.example.com' } },
      expected: undefined,
    },
    { request: { protocol: 'http', headers: {} }, expected: undefined },
  ])(
    '$request.protocol://$request.headers.host -> $expected',
    ({ request, expected }) => {
      expect(publicUrlOf(request)).toBe(expected);
    },
  );
});
