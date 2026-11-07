import {
  deepResearchProcessV2,
  loadProcessConfig,
  type ProcessConfig,
  type ProcessConfigRejection,
} from '@agent-os/engine';

/** Which configuration a replay runs: the one frozen in the original investigation or the shipped `deep-research`. */
export type ReplayConfigChoice = 'frozen' | 'shipped';

export interface ReplayConfigInput {
  readonly choice: ReplayConfigChoice;
  /** The original's frozen configuration, as `RunRecord.config.processConfig` gives it. */
  readonly frozen: ProcessConfig;
  /** Another model for one role, or null to keep the chosen configuration's models. */
  readonly roleModel: { readonly role: string; readonly model: string } | null;
}

export type ReplayConfigResult =
  | {
      readonly ok: true;
      /** Recorded in `RunResult.config.choice` of the replays run. */
      readonly choice: ReplayConfigChoice;
      readonly processConfig: ProcessConfig;
    }
  | ({ readonly ok: false } & ProcessConfigRejection);

/**
 * The configuration of a replay (KD-7, UC-6, UC-6a): frozen by default, shipped by choice; the slice is the same
 * either way. A swapped model changes the data of its role only and goes through the same schema check as any
 * configuration (ADR-0005); a model outside the catalog is refused by `createEngine` at the assembly, as in `run`.
 */
export function replayConfig(input: ReplayConfigInput): ReplayConfigResult {
  const base = input.choice === 'frozen' ? input.frozen : shippedConfig();
  const loaded = loadProcessConfig(
    input.roleModel === null ? base : withRoleModel(base, input.roleModel),
  );
  if (!loaded.ok) return { ok: false, ...loaded.rejection };
  return { ok: true, choice: input.choice, processConfig: loaded.config };
}

function shippedConfig(): ProcessConfig {
  const shipped = loadProcessConfig(deepResearchProcessV2);
  if (!shipped.ok) {
    throw new Error(
      `the shipped deep-research configuration is rejected at ${shipped.rejection.path.join('.')}`,
    );
  }
  return shipped.config;
}

/** The configuration as data with one role's model replaced; an unknown role stays in the data for the schema to refuse. */
function withRoleModel(
  base: ProcessConfig,
  roleModel: NonNullable<ReplayConfigInput['roleModel']>,
): unknown {
  const roles: Readonly<Record<string, object>> = base.roles;
  const role = Object.hasOwn(roles, roleModel.role)
    ? roles[roleModel.role]
    : {};
  return {
    ...base,
    roles: { ...roles, [roleModel.role]: { ...role, model: roleModel.model } },
  };
}
