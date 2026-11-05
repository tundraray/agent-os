import { z } from 'zod';
import { createSignalRegistry, type SignalCheck, type SignalKind } from './signal-registry.js';

// AC-04.2, DC-5: the kinds of external signals come from the `createEngine` options, each with its payload schema and
// the 4 KiB limit of the stored JSON. Defects caught: a payload larger than the limit accepted (it would then fail the
// table's check instead of being refused); a payload checked against another kind's schema; a kind outside the options
// accepted. A kind added later reaching the decision input in the same form is INT-1 C4.

const note: SignalKind = { kind: 'test.note', payloadSchema: z.object({ note: z.string() }) };
const alert: SignalKind = { kind: 'test.alert', payloadSchema: z.object({ severity: z.enum(['low', 'high']) }) };

/** A note whose stored JSON text `{"note": "…"}` is exactly `bytes` long. */
const noteOfBytes = (bytes: number) => ({ note: 'x'.repeat(bytes - '{"note": ""}'.length) });

describe('signal registry (AC-04.2, DC-5)', () => {
  const before = createSignalRegistry([note]);
  const after = createSignalRegistry([note, alert]);

  it.each<[string, ReturnType<typeof createSignalRegistry>, string, unknown, SignalCheck]>([
    ['a registered kind with its payload', before, 'test.note', { note: 'deploy at 12:00' }, { outcome: 'accepted', payload: { note: 'deploy at 12:00' } }],
    ['a kind outside the options', before, 'test.unknown', { note: 'x' }, { outcome: 'rejected', code: 'signal_kind_unknown' }],
    ['a payload off its kind schema', before, 'test.note', { severity: 'high' }, { outcome: 'rejected', code: 'signal_payload_invalid' }],
    ['another kind schema is not used', after, 'test.alert', { note: 'x' }, { outcome: 'rejected', code: 'signal_payload_invalid' }],
    ['a payload of exactly 4 KiB', before, 'test.note', noteOfBytes(4096), { outcome: 'accepted', payload: noteOfBytes(4096) }],
    ['a payload one byte over 4 KiB', before, 'test.note', noteOfBytes(4097), { outcome: 'rejected', code: 'signal_payload_invalid' }],
    ['multibyte text counted in bytes', before, 'test.note', { note: 'я'.repeat(2043) }, { outcome: 'rejected', code: 'signal_payload_invalid' }],
    ['a kind unknown before it is registered', before, 'test.alert', { severity: 'high' }, { outcome: 'rejected', code: 'signal_kind_unknown' }],
    ['the same kind once registered later', after, 'test.alert', { severity: 'high' }, { outcome: 'accepted', payload: { severity: 'high' } }],
  ])('%s', (_, registry, kind, payload, expected) => {
    expect(registry.check(kind, payload)).toEqual(expected);
  });

  it('refuses a kind registered twice', () => {
    expect(() => createSignalRegistry([note, note])).toThrow('signal kind test.note is registered twice');
  });
});
