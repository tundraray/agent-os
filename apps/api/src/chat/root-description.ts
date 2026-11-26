const ROOT_DESCRIPTION_LENGTH = 80;

/** The root's description: the first characters of the first message (code points, never half a pair). */
export function rootDescription(text: string): string {
  return Array.from(text).slice(0, ROOT_DESCRIPTION_LENGTH).join('');
}
