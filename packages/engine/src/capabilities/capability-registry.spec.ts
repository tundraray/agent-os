import { systemClock, type TaskContext } from '@agent-os/runtime';
import type { ResolvedSourceTool, SourceRegistry, SourceSchema } from '@agent-os/sources';
import { loadProcessConfig } from '../config/load-process-config.js';
import shippedDeepResearch from '../processes/deep-research.v1.json' with { type: 'json' };
import { type GateState, judgeControllerOutput, type RejectionReason } from '../controller/decision-gate.js';
import { z } from 'zod';
import { createCapabilityRegistry } from './capability-registry.js';

// Security Considerations, Decision (`requestEvidence`): the source requests of a decision are checked against the tools
// the investigation may fetch from — the configuration's `sources` and the `source.fetch` allowlist of `SourceRegistry`
// — and their arguments against the descriptor schema from `SourceRegistry.resolveTool`.
// Defect caught: a decision whose tool is outside the configuration or the allowlist, or whose arguments the tool's
// descriptor refuses, is accepted and becomes a `source.fetch` task (also through a sub-question of `requestAnalysis`).

const loaded = loadProcessConfig(shippedDeepResearch);
if (!loaded.ok) throw new Error('the shipped configuration does not load');
const config = loaded.config;

/** `search_logs` takes `{ query: string }` only; the other tools take anything. */
const searchLogsArgs: SourceSchema = z.strictObject({ query: z.string() });
const anyArgs: SourceSchema = z.record(z.string(), z.unknown());

/** The allowlist holds `fixture` `search_logs` and `get_trace`, not `aggregate_logs`. */
const sources: Pick<SourceRegistry, 'resolveTool' | 'currentSnapshot'> = {
  resolveTool: ({ sourceId, toolName }) =>
    sourceId === 'fixture' && (toolName === 'search_logs' || toolName === 'get_trace')
      ? ({ adapter: {}, tool: { argsSchema: toolName === 'search_logs' ? searchLogsArgs : anyArgs } } as ResolvedSourceTool)
      : null,
  currentSnapshot: () => Promise.reject(new Error('not called by the gate')),
};

const registry = createCapabilityRegistry({
  sources,
  scheduler: { propose: () => Promise.reject(new Error('not called by the gate')) },
  clock: systemClock,
  logger: { log: () => undefined, warn: () => undefined, error: () => undefined },
});

const open: GateState = {
  capabilities: config.capabilities,
  limits: config.limits,
  replans: 0,
  verifyRounds: 0,
  stepsWithoutNovelty: 0,
  msUntilNotAfter: 60_000,
  openTasks: 0,
};

const evidence = (sourceId: string, toolName: string, args: Record<string, unknown>) => ({
  kind: 'requestEvidence',
  rationale: 'r',
  sourceId,
  toolName,
  args: JSON.stringify(args),
  completeness: 'all',
});

// DecisionInput `tools` and the verifier's assignment (T7.3: with no tools in its input the real controller guessed the
// source id and argument names). Defect caught: a pair outside the configuration or the allowlist is offered to the
// model, an admitted pair is missing, or its argument schema is not the descriptor's.
describe('the tool catalog a role reads', () => {
  it('lists every pair the configuration and the allowlist admit, by sourceId and toolName, with its argument schema', () => {
    expect(registry.fetchToolCatalog(config)).toEqual([
      {
        sourceId: 'fixture',
        toolName: 'get_trace',
        argsSchema: { type: 'object', propertyNames: { type: 'string' }, additionalProperties: {} },
      },
      {
        sourceId: 'fixture',
        toolName: 'search_logs',
        argsSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
      },
    ]);
  });
});

describe('DecisionGate with the gather capability: source requests are checked against the descriptor', () => {
  it.each<[string, unknown, RejectionReason | 'accepted']>([
    ['a listed, allowlisted tool with arguments its schema takes', evidence('fixture', 'search_logs', { query: 'error' }), 'accepted'],
    ['arguments the descriptor schema refuses', evidence('fixture', 'search_logs', { query: 'error', limit: 5 }), 'invalid_args'],
    ['a source the configuration does not list', evidence('other', 'search_logs', { query: 'error' }), 'source_not_allowed'],
    ['a listed tool outside the source.fetch allowlist', evidence('fixture', 'aggregate_logs', {}), 'source_not_allowed'],
    [
      'a requestAnalysis sub-question with arguments the descriptor schema refuses',
      {
        kind: 'requestAnalysis',
        rationale: 'r',
        subquestions: [
          { text: 'a', sourceId: 'fixture', toolName: 'search_logs', args: '{"query":"error"}', completeness: 'all' },
          { text: 'b', sourceId: 'fixture', toolName: 'search_logs', args: '{"q":"error"}', completeness: 'sample' },
        ],
      },
      'invalid_args',
    ],
  ])('%s', (_, output, expected) => {
    const verdict = judgeControllerOutput(output, open, registry.fetchTools(config));

    if (expected === 'accepted') {
      expect(verdict).toMatchObject({ verdict: 'accepted', decision: { kind: 'requestEvidence' } });
    } else {
      expect(verdict).toMatchObject({ verdict: 'rejected', reason: expected });
    }
  });
});

// KD-10, DC-20 (design-engine.md v1.12): a request whose source snapshot cannot be read is a failed collection without a
// task. Defect caught: the `currentSnapshot` exception escapes and fails the controller task as `internal`, or a task is
// proposed without a pinned snapshot, or the warning carries the request.
describe('the gather capability over a source whose snapshot cannot be read', () => {
  it('proposes no task, returns the request as source_unavailable and logs one warning without the request', async () => {
    const warnings: unknown[][] = [];
    const proposals: unknown[] = [];
    const unreadable = createCapabilityRegistry({
      sources: { ...sources, currentSnapshot: () => Promise.reject(new TypeError('fetch failed')) },
      scheduler: {
        propose: (spec) => {
          proposals.push(spec);
          return Promise.reject(new Error('no task may be proposed'));
        },
      },
      clock: systemClock,
      logger: { log: () => undefined, warn: (...line) => warnings.push(line), error: () => undefined },
    });
    const frame = {
      ctx: { taskId: '00000000-0000-4000-8000-000000000001', signal: new AbortController().signal } as TaskContext,
      investigationId: '00000000-0000-4000-8000-000000000002',
      config,
      notAfter: new Date(Date.now() + 60_000),
    };
    const args = { query: 'secret-request-text' };

    const proposed = await unreadable.proposeTasks(frame, {
      kind: 'requestEvidence',
      rationale: 'r',
      evidenceIds: [],
      await: true,
      sourceId: 'fixture',
      toolName: 'search_logs',
      args,
      completeness: 'all',
    });

    expect(proposed).toEqual({
      outcome: 'proposed',
      taskIds: [],
      unavailable: [{ sourceId: 'fixture', toolName: 'search_logs', args, failureCode: 'source_unavailable' }],
    });
    expect(proposals).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]![1]).toMatchObject({ sourceId: 'fixture', errorClass: 'TypeError', outcome: 'source_unavailable' });
    expect(JSON.stringify(warnings)).not.toContain('secret-request-text');
  });
});
