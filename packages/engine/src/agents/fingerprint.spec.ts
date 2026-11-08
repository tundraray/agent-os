import { z } from 'zod';
import {
  type AgentFingerprintInput,
  agentFingerprint,
  definitionMemoryFingerprint,
  type SnapshotEntry,
} from './fingerprint.js';

// design-agent-core.md, Операции движка (`agentFingerprint`, `definitionMemoryFingerprint`), FR-16 key, ADR-0010
// (`version`): each fingerprint is 12 hex digits of SHA-256 and changes with each of its inputs, but not with the order
// of tools or entries, nor with `user` entries. Pure functions, no doubles.

const BASE: AgentFingerprintInput = {
  definition: {
    model: 'anthropic/claude-haiku-5-5',
    effort: 'low',
    prompt: 'Assess {{query}}.',
    limits: { maxOutputTokens: 2_000 },
  },
  tools: [
    { name: 'memory_read', description: 'Reads notes', inputSchema: z.object({ after: z.number() }) },
    { name: 'finish', description: 'Returns the result', inputSchema: z.object({ verdict: z.string() }) },
  ],
  form: { name: 'text', version: 2 },
};

const ENTRIES: readonly SnapshotEntry[] = [
  { id: 'a1', scope: 'deployment', text: 'Cite records.' },
  { id: 'b2', scope: 'deployment', text: 'Prefer primary sources.' },
  { id: 'c3', scope: 'user', text: 'Short answers.' },
];

const HEX12 = /^[0-9a-f]{12}$/;

describe('agentFingerprint', () => {
  it('is 12 hex digits of SHA-256', () => {
    expect(agentFingerprint(BASE)).toMatch(HEX12);
  });

  it.each<[string, AgentFingerprintInput]>([
    ['the model', { ...BASE, definition: { ...BASE.definition, model: 'anthropic/claude-sonnet-5-5' } }],
    ['the effort', { ...BASE, definition: { ...BASE.definition, effort: 'high' } }],
    ['the prompt', { ...BASE, definition: { ...BASE.definition, prompt: 'Assess {{query}} strictly.' } }],
    [
      'a tool schema',
      {
        ...BASE,
        tools: [
          { name: 'memory_read', description: 'Reads notes', inputSchema: z.object({ after: z.string() }) },
          ...BASE.tools.slice(1),
        ],
      },
    ],
    ['the form name', { ...BASE, form: { name: 'claim_assessment', version: 2 } }],
    ['the form version', { ...BASE, form: { name: 'text', version: 3 } }],
    ['the output cap', { ...BASE, definition: { ...BASE.definition, limits: { maxOutputTokens: 4_000 } } }],
  ])('changes when %s changes', (_case, changed) => {
    expect(agentFingerprint(changed)).not.toBe(agentFingerprint(BASE));
  });

  it('does not change with the order of the tools', () => {
    expect(agentFingerprint({ ...BASE, tools: [...BASE.tools].reverse() })).toBe(agentFingerprint(BASE));
  });
});

describe('definitionMemoryFingerprint', () => {
  it('is 12 hex digits of SHA-256, an empty snapshot included', () => {
    expect(definitionMemoryFingerprint(ENTRIES)).toMatch(HEX12);
    expect(definitionMemoryFingerprint([])).toMatch(HEX12);
  });

  it.each<[string, readonly SnapshotEntry[]]>([
    ['a deployment text', [{ id: 'a1', scope: 'deployment', text: 'Cite every record.' }, ...ENTRIES.slice(1)]],
    ['a deployment entry is added', [...ENTRIES, { id: 'd4', scope: 'deployment', text: 'Name the source.' }]],
    ['a deployment entry is removed', ENTRIES.slice(1)],
  ])('changes when %s changes', (_case, changed) => {
    expect(definitionMemoryFingerprint(changed)).not.toBe(definitionMemoryFingerprint(ENTRIES));
  });

  it.each<[string, readonly SnapshotEntry[]]>([
    ['the order of the entries', [...ENTRIES].reverse()],
    ['a user entry is added', [...ENTRIES, { id: 'e5', scope: 'user', text: 'Use bullet points.' }]],
    ['a user entry is removed', ENTRIES.slice(0, 2)],
  ])('does not change with %s', (_case, changed) => {
    expect(definitionMemoryFingerprint(changed)).toBe(definitionMemoryFingerprint(ENTRIES));
  });
});
