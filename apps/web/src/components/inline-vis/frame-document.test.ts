import { describe, expect, it } from 'vitest';

import {
  buildFrameDocument,
  FRAME_SANDBOX,
  WEBRTC_DELETE,
} from './frame-document';

const TOKENS = { variables: { '--foreground': 'red' }, colorScheme: 'light' };

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(text),
  );
  return `'sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}'`;
}

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

// AC-10.1, AC-10.2, AC-10.5; invariants 2 and 3 (design-inline-vis.md, KD-3, KD-4, KD-8).
describe('buildFrameDocument', () => {
  it.each<[string, string]>([
    ['a fragment', '<p>chart</p><script>draw()</script>'],
    [
      'a whole document with its own head and policy',
      '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src *"><script>draw()</script></head><body><p>chart</p></body></html>',
    ],
    [
      'a script inside svg and a JSON data block',
      '<svg><script>draw()</script></svg><script type="application/json">{"a":1}</script><script type="module">draw()</script>',
    ],
  ])('%s', async (_case, markup) => {
    const doc = parse(await buildFrameDocument(markup, TOKENS));
    const head = [...doc.head.children];

    expect(head[0]?.getAttribute('http-equiv')).toBe('Content-Security-Policy');
    expect(head[0]?.getAttribute('content')).toBe(
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:",
    );
    const second = head[1]?.getAttribute('content') ?? '';
    expect(head[1]?.getAttribute('http-equiv')).toBe('Content-Security-Policy');
    expect(second).toMatch(/^script-src( 'sha256-[A-Za-z0-9+/=]+')+$/);

    const executable = [...doc.querySelectorAll('script')].filter(
      (script) => script.getAttribute('type') !== 'application/json',
    );
    expect(executable.length).toBeGreaterThan(1);
    for (const script of executable) {
      const text = script.textContent ?? '';
      expect(text.startsWith(WEBRTC_DELETE)).toBe(true);
      expect(second).toContain(await sha256(text));
    }
    // A policy the model wrote lands in the body, where the browser does not read it.
    expect(
      doc.head.querySelectorAll('meta[http-equiv="Content-Security-Policy"]'),
    ).toHaveLength(2);
  });

  it('leaves a data block as the model wrote it', async () => {
    const doc = parse(
      await buildFrameDocument(
        '<script type="application/json">{"a":1}</script>',
        TOKENS,
      ),
    );
    expect(
      doc.querySelector('script[type="application/json"]')?.textContent,
    ).toBe('{"a":1}');
  });

  // Invariant 2: one more sandbox flag would give the page a way out of the frame.
  it('gives the frame only allow-scripts', () => {
    expect(FRAME_SANDBOX).toBe('allow-scripts');
  });
});
