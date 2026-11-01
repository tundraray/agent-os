/**
 * Kinds of external signals (design-engine.md, FR-04, DecisionInput): each kind is an entry of the `createEngine`
 * options with the schema of its payload. A new kind is a new entry; the form a signal takes in the decision input is
 * the same for every kind (AC-04.2).
 */

/** The schema of a kind's payload; a zod schema fits it. */
export interface SignalPayloadSchema {
  safeParse(value: unknown): { readonly success: true; readonly data: unknown } | { readonly success: false };
}

export interface SignalKind {
  /** The kind's name, unique among the engine's kinds. */
  readonly kind: string;
  readonly payloadSchema: SignalPayloadSchema;
}

/** The largest payload, in bytes of its stored JSON text (the `research_signals` check). */
const SIGNAL_PAYLOAD_MAX_BYTES = 4096;

export type SignalCheck =
  | { readonly outcome: 'accepted'; readonly payload: unknown }
  | { readonly outcome: 'rejected'; readonly code: 'signal_kind_unknown' | 'signal_payload_invalid' };

export interface SignalRegistry {
  /** The payload as its kind's schema returns it, or the refusal of DC-5. */
  check(kind: string, payload: unknown): SignalCheck;
}

/** A signal as the controller reads it in `DecisionInput.signals`, whatever its kind. */
export interface InputSignal {
  readonly signalId: string;
  readonly kind: string;
  readonly recordedAt: Date;
  readonly payload: unknown;
}

/**
 * The JSON text Postgres stores for a `jsonb` value: a space after every `:` and `,` of an object or an array. The
 * size limit is measured on it, so a payload the registry accepts always passes the table's check. `undefined` for a
 * value that is not JSON.
 */
function jsonbText(value: unknown): string | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? JSON.stringify(value) : undefined;
  }
  if (Array.isArray(value)) {
    const items = value.map(jsonbText);
    return items.every((item) => item !== undefined) ? `[${items.join(', ')}]` : undefined;
  }
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const entries = Object.entries(value as Record<string, unknown>).map(([key, item]) => {
      const text = jsonbText(item);
      return text === undefined ? undefined : `${JSON.stringify(key)}: ${text}`;
    });
    return entries.every((entry) => entry !== undefined) ? `{${entries.join(', ')}}` : undefined;
  }
  return undefined;
}

/** Throws when a kind repeats: two schemas for one kind would make the check depend on the order of the options. */
export function createSignalRegistry(kinds: readonly SignalKind[]): SignalRegistry {
  const schemas = new Map<string, SignalPayloadSchema>();
  for (const { kind, payloadSchema } of kinds) {
    if (schemas.has(kind)) {
      throw new Error(`signal kind ${kind} is registered twice`);
    }
    schemas.set(kind, payloadSchema);
  }
  return {
    check(kind, payload) {
      const schema = schemas.get(kind);
      if (schema === undefined) {
        return { outcome: 'rejected', code: 'signal_kind_unknown' };
      }
      const parsed = schema.safeParse(payload);
      if (!parsed.success) {
        return { outcome: 'rejected', code: 'signal_payload_invalid' };
      }
      const text = jsonbText(parsed.data);
      if (text === undefined || Buffer.byteLength(text, 'utf8') > SIGNAL_PAYLOAD_MAX_BYTES) {
        return { outcome: 'rejected', code: 'signal_payload_invalid' };
      }
      return { outcome: 'accepted', payload: parsed.data };
    },
  };
}

/** The decision-input form of a stored signal: the same four fields for every kind (AC-04.2). */
export function toInputSignal(row: InputSignal): InputSignal {
  return { signalId: row.signalId, kind: row.kind, recordedAt: row.recordedAt, payload: row.payload };
}
