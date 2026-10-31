/** Uniform float in [0, 1). */
export type Random = () => number;

/** Seed of one block: a 32-bit mix of the dataset seed and the block index, so blocks are independent. */
export function blockSeed(seed: number, blockIndex: number): number {
  return fmix32((seed ^ Math.imul(blockIndex + 1, 0x9e3779b1)) >>> 0);
}

/** mulberry32: small, fast, and identical on every platform (32-bit integer math only). */
export function mulberry32(seed: number): Random {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Integer in [min, max]. */
export function randomInt(random: Random, min: number, max: number): number {
  return min + Math.floor(random() * (max - min + 1));
}

/** Lowercase hex of `bytes` random bytes. */
export function randomHex(random: Random, bytes: number): string {
  let hex = '';
  for (let index = 0; index < bytes; index += 1) {
    hex += Math.floor(random() * 256)
      .toString(16)
      .padStart(2, '0');
  }
  return hex;
}

function fmix32(value: number): number {
  let h = value;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}
