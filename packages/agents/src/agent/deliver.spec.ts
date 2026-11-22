import type { StepMessage } from '@agent-os/runtime';

import { chatTurns } from './deliver';

// DC-1: in a chat every `user_message` of the employee starts a new turn; nothing else resets the counter
// here. Only `ChatAgent` counts so: every other agent keeps its counter.
const message = (kind: string, payload: Record<string, unknown>): StepMessage =>
  ({ messageId: 'm1', kind, payload }) as StepMessage;

describe('the turn counter after delivery', () => {
  it.each<[string, StepMessage[], number]>([
    [
      'a chat resets on a user message',
      [message('user_message', { text: 'hi' })],
      0,
    ],
    ['a chat keeps the counter on an interrupt', [message('interrupt', {})], 3],
    ['a chat keeps the counter without messages', [], 3],
  ])('%s', (_name, messages, expected) => {
    expect(chatTurns(3, messages)).toBe(expected);
  });
});
