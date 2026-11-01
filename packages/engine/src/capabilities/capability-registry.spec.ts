import { systemClock } from '@agent-os/runtime';
import type { ResolvedSourceTool, SourceRegistry, SourceSchema } from '@agent-os/sources';
import { loadProcessConfig } from '../config/load-process-config.js';
import shippedDeepResearch from '../processes/deep-research.v1.json' with { type: 'json' };
import { type GateState, judgeControllerOutput, type RejectionReason } from '../controller/decision-gate.js';
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
const searchLogsArgs: SourceSchema = {
  safeParse: (value) =>
    typeof value === 'object' && value !== null && Object.keys(value).join() === 'query' && typeof (value as { query?: unknown }).query === 'string'
      ? { success: true, data: value }
      : { success: false, error: new Error('off schema') },
};
const anyArgs: SourceSchema = { safeParse: (value) => ({ success: true, data: value }) };

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
  args,
  completeness: 'all',
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
          { text: 'a', sourceId: 'fixture', toolName: 'search_logs', args: { query: 'error' }, completeness: 'all' },
          { text: 'b', sourceId: 'fixture', toolName: 'search_logs', args: { q: 'error' }, completeness: 'sample' },
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
