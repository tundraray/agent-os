export interface ModelChoiceInput {
  /** The model the launch named (`start`, `start_agent`). */
  readonly launchModel?: string | null;
  /** The model of the definition. */
  readonly definitionModel?: string | null;
  /** `AGENT_DEFAULT_MODEL`. */
  readonly defaultModel: string;
}

/**
 * The model of a new agent (FR-04, DC-2): the launch's, else the definition's, else the default.
 * Whether the owner may call it is the access gate's answer at the call (KD-4).
 */
export function chooseModel(input: ModelChoiceInput): string {
  return input.launchModel ?? input.definitionModel ?? input.defaultModel;
}
