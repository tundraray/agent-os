import { describe, expect, it } from 'vitest';
import { isRenderableImageSrc, linkPolicy, type LinkPolicy } from './markdown-policy';

describe('linkPolicy', () => {
  it.each<[string | undefined, LinkPolicy]>([
    ['javascript:alert(1)', { kind: 'unsafe' }],
    [' JAVASCRIPT:alert(1)', { kind: 'unsafe' }],
    ['data:text/html,<script>alert(1)</script>', { kind: 'unsafe' }],
    ['vbscript:msgbox(1)', { kind: 'unsafe' }],
    ['', { kind: 'unsafe' }],
    [undefined, { kind: 'unsafe' }],
    ['https://example.com', { kind: 'new-tab', href: 'https://example.com' }],
    ['http://example.com/page', { kind: 'new-tab', href: 'http://example.com/page' }],
    ['/chat/x', { kind: 'new-tab', href: '/chat/x' }],
    ['./a', { kind: 'new-tab', href: './a' }],
    ['?q', { kind: 'new-tab', href: '?q' }],
    ['#user-content-fn-1', { kind: 'fragment', href: '#user-content-fn-1' }],
    ['mailto:a@b.c', { kind: 'mail', href: 'mailto:a@b.c' }],
  ])('maps %j to %j', (url, expected) => {
    expect(linkPolicy(url)).toEqual(expected);
  });
});

describe('isRenderableImageSrc', () => {
  it.each<[string | undefined, boolean]>([
    ['https://img.test/a.png', true],
    ['http://img.test/a.png', false],
    ['data:image/png;base64,iVBORw0KGgo=', false],
    ['/img.png', false],
    [undefined, false],
  ])('%j → %j', (src, expected) => {
    expect(isRenderableImageSrc(src)).toBe(expected);
  });
});
