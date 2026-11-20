/** UTF-8 bytes per token of the usage estimate of a call whose provider reported no token count (DC-11). */
const BYTES_PER_TOKEN = 4;

/** The UTF-8 bytes of a text: characters would undercount any text outside ASCII, such as Cyrillic. */
export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

export function tokensOfBytes(bytes: number): number {
  return Math.ceil(bytes / BYTES_PER_TOKEN);
}
