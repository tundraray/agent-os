/** The only sandbox flag of the frame: scripts run, the origin stays opaque (design-inline-vis.md, KD-3, invariant 2). */
export const FRAME_SANDBOX = 'allow-scripts';

/** The first policy of the frame document: no network, no external resource of any kind (KD-3). */
const BASE_POLICY =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:";

/**
 * Removes WebRTC from the window before any other code of the script runs (KD-8). `try` stays per step: a
 * property the browser made non-configurable refuses one of them, and the script must still go on.
 */
export const WEBRTC_DELETE = `
for (const k of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'RTCSessionDescription', 'RTCIceCandidate', 'RTCRtpSender', 'RTCRtpReceiver']) {
  try { delete window[k]; } catch (e) {}
  try { Object.defineProperty(window, k, { value: undefined, writable: false, configurable: false }); } catch (e) {}
}`;

/**
 * Our script in the frame's `<head>`, before the model's code (KD-6, KD-5): reports the height after `load` and on
 * every resize, an uncaught exception and the address of a clicked link; applies the tokens the host sends.
 */
const FRAME_SCRIPT = `
(() => {
  const post = (message) => parent.postMessage(message, '*');
  const root = document.documentElement;
  let height = -1;
  const sendHeight = () => {
    const next = Math.ceil(root.getBoundingClientRect().height);
    if (next === height) return;
    height = next;
    post({ type: 'height', height: next });
  };
  addEventListener('load', () => {
    sendHeight();
    new ResizeObserver(sendHeight).observe(root);
  });
  addEventListener('error', (event) => post({ type: 'error', message: String(event.message) }));
  document.addEventListener('click', (event) => {
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (link === null) return;
    const href = link.getAttribute('href') || '';
    if (href.startsWith('#')) return;
    event.preventDefault();
    post({ type: 'link', href: new URL(href, document.baseURI).href });
  });
  addEventListener('message', (event) => {
    if (event.source !== parent || event.data === null || typeof event.data !== 'object' || event.data.type !== 'tokens') return;
    for (const [name, value] of Object.entries(event.data.variables)) root.style.setProperty(name, value);
    root.style.colorScheme = event.data.colorScheme;
  });
})();`;

/** The theme tokens the page receives (inline-visualization.md, «Что страница получает от темы»). */
const THEME_TOKENS = [
  '--background',
  '--foreground',
  '--muted-foreground',
  '--border',
  '--muted',
  '--primary',
  '--chart-1',
  '--chart-2',
  '--chart-3',
  '--chart-4',
  '--chart-5',
  '--info',
  '--success',
  '--warning',
  '--destructive',
] as const;

export type ThemeTokens = {
  variables: Record<string, string>;
  colorScheme: string;
};

/** The message the host sends the frame when the theme, mode or contrast changes, and on the frame's `load`. */
export type TokensMessage = { type: 'tokens' } & ThemeTokens;

/** The current values on `<html>` (design-engine.md, Contract Definitions, «Тема на странице»). */
export function readThemeTokens(): ThemeTokens {
  const style = getComputedStyle(document.documentElement);
  return {
    variables: Object.fromEntries(
      THEME_TOKENS.map((name) => [name, style.getPropertyValue(name).trim()]),
    ),
    colorScheme: style.colorScheme,
  };
}

// HTML's JavaScript MIME types; `module` runs too. Any other type is a data block and stays as written.
const JAVASCRIPT_TYPES = new Set([
  '',
  'module',
  'application/ecmascript',
  'application/javascript',
  'application/x-ecmascript',
  'application/x-javascript',
  'text/ecmascript',
  'text/javascript',
  'text/javascript1.0',
  'text/javascript1.1',
  'text/javascript1.2',
  'text/javascript1.3',
  'text/javascript1.4',
  'text/javascript1.5',
  'text/jscript',
  'text/livescript',
  'text/x-ecmascript',
  'text/x-javascript',
]);

function isExecutable(script: Element): boolean {
  const type = script.getAttribute('type');
  return type === null || JAVASCRIPT_TYPES.has(type.trim().toLowerCase());
}

async function scriptHash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(text),
  );
  return `'sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}'`;
}

function themeStyle({ variables, colorScheme }: ThemeTokens): string {
  const declarations = Object.entries(variables)
    .map(([name, value]) => `${name}:${value}`)
    .join(';');
  return `:root{${declarations};color-scheme:${colorScheme}}html,body{background:transparent}body{margin:0;font-family:system-ui,sans-serif}`;
}

/**
 * The frame document (KD-4, KD-8): the two policies first, then our `<head>` with the charset, the tokens and the
 * frame script, then the model's markup. The markup is parsed inertly in a `template`; every executable script in it,
 * SVG ones included, starts with the delete code, and the second policy allows exactly the hashes of the final texts.
 * The model's `doctype`, `<html>`, `<head>` and `<body>` fall away in that parse; their content stays.
 */
export async function buildFrameDocument(
  markup: string,
  tokens: ThemeTokens,
): Promise<string> {
  const template = document.createElement('template');
  template.innerHTML = markup;
  const scripts = [...template.content.querySelectorAll('script')].filter(
    isExecutable,
  );
  for (const script of scripts) {
    script.textContent = WEBRTC_DELETE + (script.textContent ?? '');
  }
  const frameScript = WEBRTC_DELETE + FRAME_SCRIPT;
  const texts = [frameScript, ...scripts.map((s) => s.textContent ?? '')];
  const hashes = [...new Set(await Promise.all(texts.map(scriptHash)))];
  return (
    '<!doctype html><html><head>' +
    `<meta http-equiv="Content-Security-Policy" content="${BASE_POLICY}">` +
    `<meta http-equiv="Content-Security-Policy" content="script-src ${hashes.join(' ')}">` +
    '<meta charset="utf-8">' +
    `<style>${themeStyle(tokens)}</style>` +
    `<script>${frameScript}</script>` +
    `</head><body>${template.innerHTML}</body></html>`
  );
}

/** A message of the frame, read as data only (KD-6): the model's code runs in the same window and can send these. */
export type FrameMessage =
  | { type: 'height'; height: number }
  | { type: 'error'; message: string }
  | { type: 'link'; href: string };

export function readFrameMessage(data: unknown): FrameMessage | null {
  if (typeof data !== 'object' || data === null || !('type' in data))
    return null;
  if (
    data.type === 'height' &&
    'height' in data &&
    typeof data.height === 'number' &&
    Number.isFinite(data.height)
  )
    return { type: 'height', height: data.height };
  if (
    data.type === 'error' &&
    'message' in data &&
    typeof data.message === 'string'
  )
    return { type: 'error', message: data.message };
  if (data.type === 'link' && 'href' in data && typeof data.href === 'string')
    return { type: 'link', href: data.href };
  return null;
}
