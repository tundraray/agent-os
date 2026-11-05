/**
 * The value with object keys sorted at every depth (array order kept), so equal values serialize to the same
 * string whatever order their keys were inserted in. `toJSON` is applied first, as `JSON.stringify` would.
 */
function canonicalize(value: unknown): unknown {
  const plain = hasToJson(value) ? value.toJSON() : value;
  if (Array.isArray(plain)) {
    return plain.map(canonicalize);
  }
  if (plain === null || typeof plain !== 'object') {
    return plain;
  }
  const source = plain as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    sorted[key] = canonicalize(source[key]);
  }
  return sorted;
}

/**
 * JSON with a fixed key order (design-mcp-source.md, Evidence страницы): the content and the normalized arguments
 * of a page depend only on their values, so a repeated page has the same `sha256`.
 */
export function canonicalJson(value: unknown): string {
  const serialized = JSON.stringify(canonicalize(value));
  if (serialized === undefined) {
    throw new TypeError('canonicalJson: value has no JSON representation');
  }
  return serialized;
}

function hasToJson(value: unknown): value is { toJSON: () => unknown } {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { toJSON?: unknown }).toJSON === 'function'
  );
}
