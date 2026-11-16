import { chooseModel, type ModelChoiceInput } from './model-choice.js';

// FR-04, DC-2 (AC-04.1–AC-04.3): the rule of the agent's model; access to it is checked at the call (KD-4).
const HAIKU = 'anthropic/claude-haiku-5-5';
const SONNET = 'anthropic/claude-sonnet-5-5';
const OPUS = 'anthropic/claude-opus-5-5';

describe("the agent's model is the launch's, else the definition's, else the default", () => {
  it.each<[string, ModelChoiceInput, string]>([
    [
      'the launch model wins over the definition and the default',
      { launchModel: OPUS, definitionModel: SONNET, defaultModel: HAIKU },
      OPUS,
    ],
    [
      "without a launch model the definition's model wins over the default",
      { launchModel: null, definitionModel: SONNET, defaultModel: HAIKU },
      SONNET,
    ],
    ['without both the default is chosen', { defaultModel: HAIKU }, HAIKU],
  ])('%s', (_, input, expected) => {
    expect(chooseModel(input)).toBe(expected);
  });
});
