import { chooseModel, type ModelChoice, type ModelChoiceInput } from './model-choice.js';

// FR-04, DC-2 (AC-04.1–AC-04.3): the rule of the agent's model.
const HAIKU = 'anthropic/claude-haiku-5-5';
const SONNET = 'anthropic/claude-sonnet-5-5';
const OPUS = 'anthropic/claude-opus-5-5';
const PRICED = [HAIKU, SONNET, OPUS];

describe("the agent's model is the launch's, else the definition's, else the default, and an unpriced one is refused", () => {
  it.each<[string, ModelChoiceInput, ModelChoice]>([
    [
      'the launch model wins over the definition and the default',
      { launchModel: OPUS, definitionModel: SONNET, defaultModel: HAIKU, pricedModels: PRICED },
      { kind: 'chosen', model: OPUS },
    ],
    [
      'the definition model applies without a launch model',
      { definitionModel: SONNET, defaultModel: HAIKU, pricedModels: PRICED },
      { kind: 'chosen', model: SONNET },
    ],
    [
      'the default applies when nothing names a model',
      { launchModel: null, definitionModel: undefined, defaultModel: HAIKU, pricedModels: PRICED },
      { kind: 'chosen', model: HAIKU },
    ],
    [
      'a model without a price is refused',
      { launchModel: 'anthropic/claude-unpriced', defaultModel: HAIKU, pricedModels: PRICED },
      { kind: 'refused', reason: 'unknown_model' },
    ],
  ])('%s', (_, input, expected) => {
    expect(chooseModel(input)).toEqual(expected);
  });
});
