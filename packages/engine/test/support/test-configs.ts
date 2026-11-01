import { deepResearchProcessV1 } from '@agent-os/engine';

/**
 * Process configurations of the integration file, as data — each passes the same loader as the shipped one (KD-1).
 * They are derived from the shipped deep-research configuration and differ only where a case needs it; the counting
 * source impersonates the fixture, so their `sources` pass the DC-14 check unchanged.
 */

type Fields = Readonly<Record<string, unknown>>;
type Role = 'plan' | 'controller' | 'worker' | 'verifier' | 'synthesis';

/** The fields of the shipped data a test configuration overrides. */
interface ConfigData extends Fields {
  readonly roles: Readonly<Record<Role, Fields>>;
  readonly limits: Fields;
}

const base = deepResearchProcessV1 as ConfigData;

function withRoles(overrides: Partial<Record<Role, Fields>>): ConfigData['roles'] {
  const roles: Record<Role, Fields> = { ...base.roles };
  for (const [name, fields] of Object.entries(overrides) as [Role, Fields][]) {
    roles[name] = { ...base.roles[name], ...fields };
  }
  return roles;
}

/**
 * The second configuration of AC-12.1 (UC-9): another goal, no `verify` and no `analyze`, other prompt text and other
 * windows. Its prompts carry markers a test finds in the packets the model double received.
 */
export const SECOND_CONFIG_MARKER = 'SECOND-CONFIG-PROMPT';
const secondConfig = {
  ...base,
  processId: 'incident-summary',
  version: 1,
  goal: 'Summarise the incident the question names from the logs, without deep analysis.',
  capabilities: ['plan', 'gather', 'synthesize'],
  roles: withRoles({
    plan: {
      prompt: `${SECOND_CONFIG_MARKER} plan. Goal: {{goal}}\nQuestion: {{query}}\nWrite readiness criteria and branches.`,
      windowTokens: 5_000,
      marginTokens: 250,
    },
    controller: {
      prompt: `${SECOND_CONFIG_MARKER} controller. Goal: {{goal}}\nQuestion: {{query}}\nChoose one admissible decision.`,
      windowTokens: 6_000,
      marginTokens: 300,
    },
  }),
};

/** C5 step_limit (AC-03.2): two steps at most. */
const twoStepConfig = { ...base, processId: 'two-steps', limits: { ...base.limits, maxSteps: 2 } };

/**
 * C5 context_overflow (DC-8): a controller window smaller than its mandatory input — the rendered prompt alone is
 * longer than 400 counted tokens of the harness counter (one per character).
 */
const narrowControllerConfig = {
  ...base,
  processId: 'narrow-controller',
  roles: withRoles({ controller: { windowTokens: 400, marginTokens: 20 } }),
};

/** C6 (DC-15): versions of one process that differ only in the controller prompt's marker. */
export const VERSIONED_PROCESS_ID = 'versioned';
export const versionMarker = (version: number) => `VERSION-${version}-PROMPT`;
export function versionedConfig(version: number) {
  return {
    ...base,
    processId: VERSIONED_PROCESS_ID,
    version,
    roles: withRoles({
      plan: { prompt: `${versionMarker(version)} plan. Goal: {{goal}}\nQuestion: {{query}}` },
      controller: { prompt: `${versionMarker(version)} controller. Goal: {{goal}}\nQuestion: {{query}}` },
    }),
  };
}

/** Every configuration a default harness of the file loads. */
export const TEST_PROCESSES: readonly unknown[] = [base, secondConfig, twoStepConfig, narrowControllerConfig];
