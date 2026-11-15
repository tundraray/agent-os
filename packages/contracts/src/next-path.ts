/** A backslash or a control character: browsers read `/\host` and `/<tab>/host` as `//host`. */
function isAmbiguous(character: string): boolean {
  const code = character.charCodeAt(0);
  return character === '\\' || code < 0x20 || code === 0x7f;
}

/**
 * The web path to return to after sign-in (Contract «Вход и сеанс»): a path that starts with exactly
 * one `/`; anything else, a missing value included, becomes `/`, so the redirect never leaves the web.
 * The one definition for the API and the web.
 */
export function nextPath(next: unknown): string {
  if (
    typeof next !== 'string' ||
    !next.startsWith('/') ||
    next.startsWith('//') ||
    Array.from(next).some(isAmbiguous)
  )
    return '/';
  return next;
}
