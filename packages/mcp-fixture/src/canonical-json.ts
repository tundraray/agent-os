import { createHash } from 'node:crypto';

/**
 * JSON with a fixed key order: object keys are sorted by UTF-16 code units at every depth (integer-like keys come
 * first in numeric order, as JavaScript objects keep them), array order is kept.
 * The same value always serializes to the same string, whatever order its keys were inserted in (AC-15.1).
 * `indent` only changes whitespace, never the key order.
 */
export function canonicalJson(value: unknown, indent?: number): string {
  const serialized = JSON.stringify(sortKeys(value), null, indent);
  if (serialized === undefined) {
    throw new TypeError('canonicalJson: value has no JSON representation');
  }
  return serialized;
}

/** Hex sha256 of a string (UTF-8). */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Hash of tool arguments for fault rules and the call log: sha256 of the canonical arguments without `cursor`,
 * so every page of one query shares a hash.
 */
export function argsHash(args: Readonly<Record<string, unknown>>): string {
  const { cursor: _cursor, ...rest } = args;
  return sha256Hex(canonicalJson(rest));
}

function sortKeys(value: unknown): unknown {
  const plain = hasToJson(value) ? value.toJSON() : value;
  if (Array.isArray(plain)) {
    return plain.map(sortKeys);
  }
  if (plain === null || typeof plain !== 'object') {
    return plain;
  }
  const source = plain as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    sorted[key] = sortKeys(source[key]);
  }
  return sorted;
}

function hasToJson(value: unknown): value is { toJSON: () => unknown } {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { toJSON?: unknown }).toJSON === 'function'
  );
}
