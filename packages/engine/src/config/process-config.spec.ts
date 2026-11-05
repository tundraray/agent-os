import type { ResolvedSourceTool, SourceRegistry, SourceToolRequest } from '@agent-os/sources';
import shippedDeepResearch from '../processes/deep-research.v1.json' with { type: 'json' };
import { loadProcessConfig, type ProcessConfig } from './load-process-config.js';
import { DEFAULT_MODEL_CATALOG } from './model-catalog.js';
import { checkRoleModels } from './process-config.schema.js';
import { createProcessSet } from './process-set.js';
import { renderPromptTemplate } from './prompt-template.js';
import { checkProcessSources } from './source-check.js';

// AC-12.2, AC-12.3, UC-E8, UC-10, DC-14, DC-15 (version resolution), DC-18 (rule): the loader and the engine-creation
// checks are pure functions; the only double is the `SourceRegistry` port.

const role = (model: string, prompt = 'Investigate {{query}} toward {{goal}}.') => ({
  model,
  effort: 'low',
  maxOutputTokens: 4_000,
  windowTokens: 20_000,
  marginTokens: 1_000,
  prompt,
});

function rawConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    processId: 'test-process',
    version: 1,
    goal: 'Find the cause of the failures',
    capabilities: ['plan', 'gather', 'synthesize'],
    sources: [{ sourceId: 'fixture', toolName: 'search_logs' }],
    roles: {
      plan: role('anthropic/claude-sonnet-5-5'),
      controller: role('anthropic/claude-sonnet-5-5'),
      worker: role('anthropic/claude-haiku-5-5'),
      verifier: role('anthropic/claude-haiku-5-5'),
      synthesis: role('anthropic/claude-sonnet-5-5', 'Answer {{query}}. Mode: {{sourceMode}}.'),
    },
    limits: {
      maxSteps: 4,
      maxPlanRevisions: 1,
      noveltyWindow: 2,
      maxDecisionRetries: 1,
      maxFanOut: 2,
      maxVerifyRounds: 1,
      deadlineMarginMs: 10_000,
      investigationTokens: { default: 100_000, max: 200_000 },
      maxTasks: 10,
      maxToolCalls: 20,
      taskBudgets: {
        'research.controller': { deadlineMs: 600_000 },
        'source.fetch': { maxToolCalls: 5, maxRetries: 1 },
      },
    },
    answer: { sections: ['summary', 'established', 'unknown'] },
    ...overrides,
  };
}

function withRole(name: string, patch: Record<string, unknown>): Record<string, unknown> {
  const base = rawConfig();
  const roles = base['roles'] as Record<string, Record<string, unknown>>;
  return { ...base, roles: { ...roles, [name]: { ...roles[name], ...patch } } };
}

function loaded(raw: unknown): ProcessConfig {
  const result = loadProcessConfig(raw);
  if (!result.ok) {
    throw new Error(`fixture config rejected at ${result.rejection.path.join('.')}: ${result.rejection.message}`);
  }
  return result.config;
}

/** Answers like `source.fetch`'s allowlist with only `fixture`/`search_logs`; records every request it sees. */
function registryDouble(): Pick<SourceRegistry, 'resolveTool'> & { readonly requests: SourceToolRequest[] } {
  const requests: SourceToolRequest[] = [];
  const resolved: ResolvedSourceTool = {
    adapter: {
      descriptor: { sourceId: 'fixture', tools: [] },
      call: () => Promise.reject(new Error('not called by the check')),
      currentSnapshot: () => Promise.reject(new Error('not called by the check')),
      close: () => Promise.resolve(),
    },
    tool: {
      name: 'search_logs',
      paginated: true,
      readOnly: true,
      argsSchema: { safeParse: (data: unknown) => ({ success: true, data }) },
      resultSchema: { safeParse: (data: unknown) => ({ success: true, data }) },
    },
  };
  return {
    requests,
    resolveTool(request) {
      requests.push(request);
      const allowed =
        request.workflowType === 'source.fetch' && request.sourceId === 'fixture' && request.toolName === 'search_logs';
      return allowed ? resolved : null;
    },
  };
}

describe('loadProcessConfig', () => {
  it.each([
    ['a capability outside the registry', rawConfig({ capabilities: ['plan', 'browse'] }), ['capabilities', 1]],
    ['the unknown key `script`', rawConfig({ script: 'process.exit(1)' }), ['script']],
    [
      'an unknown field in a prompt template',
      withRole('synthesis', { prompt: 'Answer {{query}} with {{apiKey}}.' }),
      ['roles', 'synthesis', 'prompt'],
    ],
    [
      'an expression in a prompt template',
      withRole('worker', { prompt: 'Look at {{ goal.toUpperCase() }}.' }),
      ['roles', 'worker', 'prompt'],
    ],
  ])('rejects %s with the path of the field', (_, raw, path) => {
    const result = loadProcessConfig(raw);

    expect(result).toMatchObject({ ok: false, rejection: { code: 'process_config_rejected', path } });
  });

  it('accepts the field `sourceMode` in a prompt template and substitutes it', () => {
    const config = loaded(rawConfig());

    const prompt = renderPromptTemplate(config.roles.synthesis.prompt, {
      goal: config.goal,
      query: 'why do payments fail',
      sourceMode: 'model_knowledge',
      answerSections: 'summary',
    });

    expect(prompt).toBe('Answer why do payments fail. Mode: model_knowledge.');
  });

  it('accepts the shipped deep-research configuration through the same loader', () => {
    const config = loaded(shippedDeepResearch);

    expect(config).toMatchObject({ processId: 'deep-research', version: 1 });
    expect(checkRoleModels(config, DEFAULT_MODEL_CATALOG)).toBeNull();
  });
});

describe('engine-creation checks', () => {
  it('rejects a role model absent from the model catalog with the path of the role', () => {
    const config = loaded(withRole('worker', { model: 'anthropic/claude-haiku-4-0' }));

    expect(checkRoleModels(config, DEFAULT_MODEL_CATALOG)).toMatchObject({
      code: 'process_config_rejected',
      path: ['roles', 'worker', 'model'],
    });
  });

  const ALLOWLISTED = { sourceId: 'fixture', toolName: 'search_logs' };
  const OUTSIDE = { sourceId: 'fixture', toolName: 'delete_logs' };

  it.each([
    {
      name: 'a tool outside the source.fetch allowlist with a connected source is rejected (DC-14)',
      sources: [ALLOWLISTED, OUTSIDE],
      connectedSources: ['fixture'],
      expected: { ok: false, rejection: { code: 'process_config_rejected', path: [0, 'sources', 1] } },
      resolved: ['search_logs', 'delete_logs'],
    },
    {
      name: 'the same configuration without connected sources is accepted in model_knowledge mode with a warning (DC-18)',
      sources: [ALLOWLISTED, OUTSIDE],
      connectedSources: [],
      expected: { ok: true, sourceMode: 'model_knowledge', warnNoSources: true },
      resolved: [],
    },
    {
      name: 'allowlisted sources with a connected source are accepted in sources mode without a warning',
      sources: [ALLOWLISTED],
      connectedSources: ['fixture'],
      expected: { ok: true, sourceMode: 'sources', warnNoSources: false },
      resolved: ['search_logs'],
    },
  ])('$name', ({ sources, connectedSources, expected, resolved }) => {
    const registry = registryDouble();
    const config = loaded(rawConfig({ sources }));

    const result = checkProcessSources({ configs: [config], registry, connectedSources });

    expect(result).toMatchObject(expected);
    expect(registry.requests).toEqual(
      resolved.map((toolName) => ({ workflowType: 'source.fetch', sourceId: 'fixture', toolName })),
    );
  });
});

describe('process versions (DC-15, resolution half)', () => {
  const version = (processId: string, n: number) => loaded(rawConfig({ processId, version: n }));

  it('rejects a repeated processId + version pair with the path of the repeated entry', () => {
    const result = createProcessSet([version('p', 1), version('p', 2), version('p', 1)]);

    expect(result).toMatchObject({ ok: false, rejection: { code: 'process_config_rejected', path: [2] } });
    expect(!result.ok && result.rejection.message).toContain('p version 1');
  });

  it.each([
    { loadedVersions: [1, 2], processId: 'p', requested: undefined, expected: { ok: true, version: 2 } },
    { loadedVersions: [1, 2, 3], processId: 'p', requested: undefined, expected: { ok: true, version: 3 } },
    { loadedVersions: [2, 1], processId: 'p', requested: 1, expected: { ok: true, version: 1 } },
    { loadedVersions: [1, 2], processId: 'p', requested: 3, expected: { ok: false, code: 'process_unknown' } },
    { loadedVersions: [1, 2], processId: 'q', requested: undefined, expected: { ok: false, code: 'process_unknown' } },
  ])(
    'with versions $loadedVersions loaded, $processId version $requested resolves to $expected',
    ({ loadedVersions, processId, requested, expected }) => {
      const created = createProcessSet(loadedVersions.map((n) => version('p', n)));
      if (!created.ok) {
        throw new Error(created.rejection.message);
      }

      const resolution = created.set.resolve(processId, requested);

      expect(resolution.ok ? { ok: true, version: resolution.config.version } : resolution).toEqual(expected);
    },
  );
});
