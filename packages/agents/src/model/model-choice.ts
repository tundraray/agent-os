export interface ModelChoiceInput {
  /** The model the launch named (`start`, `start_agent`). */
  readonly launchModel?: string | null;
  /** The model of the definition. */
  readonly definitionModel?: string | null;
  /** `AGENT_DEFAULT_MODEL`. */
  readonly defaultModel: string;
  /** Models with a price in the deployment's prices file (`ledger.pricedModels()`). */
  readonly pricedModels: readonly string[];
}

export type ModelChoice =
  | { readonly kind: 'chosen'; readonly model: string }
  | { readonly kind: 'refused'; readonly reason: 'unknown_model' };

/**
 * The model of a new agent (FR-04, DC-2): the launch's, else the definition's, else the default.
 * A model without a price is refused before the agent is created.
 */
export function chooseModel(input: ModelChoiceInput): ModelChoice {
  const model = input.launchModel ?? input.definitionModel ?? input.defaultModel;
  return input.pricedModels.includes(model)
    ? { kind: 'chosen', model }
    : { kind: 'refused', reason: 'unknown_model' };
}
