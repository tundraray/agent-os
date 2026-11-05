import { RequestContext } from '@mastra/core/request-context';
import { researchTurnContext } from '../../research-chat/research-turn.js';
import { createAssistantAgent } from './assistant.agent.js';

/** The model the chat agent resolves for a turn with `requestContext`, as `<provider>/<model>`. */
async function turnModel(requestContext: RequestContext): Promise<string> {
  const agent = createAssistantAgent('openai/gpt-5-5', 'medium', {});
  const model = await agent.getModel({ requestContext });
  return `${model.provider.split('.')[0]}/${model.modelId}`;
}

// KD-9: research mode and decision turns run on Haiku 5.5 whatever the chat model is; ordinary turns on the chat model.
describe('createAssistantAgent model', () => {
  it.each([
    [
      'a research mode turn runs on Haiku 5.5',
      researchTurnContext({ kind: 'mode', userMessageId: 'm-1' }),
      'anthropic/claude-haiku-5-5',
    ],
    [
      'a card decision turn runs on Haiku 5.5',
      researchTurnContext({
        kind: 'decision',
        decision: { action: 'confirm', launchKey: 'call-1' },
        userMessageId: 'm-1',
      }),
      'anthropic/claude-haiku-5-5',
    ],
    [
      'an ordinary turn runs on the chat model',
      new RequestContext(),
      'openai/gpt-5-5',
    ],
  ])('%s', async (_, requestContext, expected) => {
    expect(await turnModel(requestContext)).toBe(expected);
  });
});
