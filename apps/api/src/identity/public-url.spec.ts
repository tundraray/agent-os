import { choosePublicUrl } from './public-url.js';

// AC-03.4: redirectUri is built from the public address; a path or `/api` in it would break the callback.
describe('public URL from the request: scheme and host only, saved value wins', () => {
  it.each([
    {
      saved: null,
      request: {
        protocol: 'http',
        headers: { host: 'localhost:5173' },
        originalUrl: '/api/admin/providers',
      },
      expected: 'http://localhost:5173',
    },
    {
      saved: null,
      request: {
        protocol: 'https',
        headers: { host: 'aos.example.com' },
        originalUrl: '/api/admin/providers/1',
      },
      expected: 'https://aos.example.com',
    },
    {
      saved: 'https://aos.example.com',
      request: {
        protocol: 'http',
        headers: { host: 'localhost:3000' },
        originalUrl: '/api/admin/providers',
      },
      expected: 'https://aos.example.com',
    },
  ])(
    'saved $saved, request $request.protocol://$request.headers.host -> $expected',
    ({ saved, request, expected }) => {
      expect(choosePublicUrl(saved, request)).toBe(expected);
    },
  );

  it('fails without a Host header instead of building an address from nothing', () => {
    expect(() =>
      choosePublicUrl(null, { protocol: 'http', headers: {} }),
    ).toThrow('request has no Host header');
  });
});
