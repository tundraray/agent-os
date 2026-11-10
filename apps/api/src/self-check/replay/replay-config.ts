import {
  deepResearchProcessV3,
  type ProcessConfigRejection,
  type RunRecord,
} from '@agent-os/engine';
import {
  type AgentModel,
  loadRunnableConfig,
  type RunnableConfig,
  swapModels,
} from '../run/run-command.js';

/** Which configuration a replay runs: the one frozen in the original investigation or the shipped `deep-research`. */
export type ReplayConfigChoice = 'frozen' | 'shipped';

export interface ReplayConfigInput {
  readonly choice: ReplayConfigChoice;
  /** The original's frozen configuration, as `RunRecord.config.processConfig` gives it. */
  readonly frozen: RunRecord['config']['processConfig'];
  /** Other models for agents of the chosen configuration, one per `--agent-model`. */
  readonly agentModels: readonly AgentModel[];
}

export type ReplayConfigResult =
  | {
      readonly ok: true;
      /** Recorded in `RunResult.config.choice` of the replays run. */
      readonly choice: ReplayConfigChoice;
      readonly processConfig: RunnableConfig;
    }
  | ({ readonly ok: false } & ProcessConfigRejection)
  | {
      readonly ok: false;
      readonly code: 'invalid_arguments';
      readonly reason: string;
    };

/**
 * The configuration of a replay (KD-7, UC-6, UC-6a): frozen by default, shipped by choice; the slice is the same either
 * way. A swapped model changes the data of its agent only (`swapModels`, the same as in `run`) and goes through the same
 * load as any configuration (ADR-0009); a model outside the catalog is refused by `createEngine` at the assembly, as in
 * `run`.
 */
export function replayConfig(input: ReplayConfigInput): ReplayConfigResult {
  const base: unknown =
    input.choice === 'frozen' ? input.frozen : deepResearchProcessV3;
  const swapped = swapModels(base, input);
  if (!swapped.ok) return swapped;
  const loaded = loadRunnableConfig(swapped.processConfig);
  if (!loaded.ok) return { ok: false, ...loaded.rejection };
  return { ok: true, choice: input.choice, processConfig: loaded.config };
}
