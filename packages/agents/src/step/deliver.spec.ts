import type { StepMessage } from '@agent-os/runtime';

import { rootTurnReset } from './deliver.js';

// DC-1: in a root session every employee message — a `user_message` or an `interrupt` with text —
// starts a new turn; nothing else resets the counter here.
const message = (kind: string, payload: Record<string, unknown>): StepMessage =>
  ({ messageId: 'm1', kind, payload }) as StepMessage;

describe('the turn counter after delivery', () => {
  it.each<[string, boolean, StepMessage[], number]>([
    ['a root session resets on a user message', true, [message('user_message', { text: 'hi' })], 0],
    ['a root session resets on an interrupt with text', true, [message('interrupt', { text: 'stop that' })], 0],
    ['a root session keeps the counter on an interrupt without text', true, [message('interrupt', {})], 3],
    ['a child session keeps the counter on a user message', false, [message('user_message', { text: 'hi' })], 3],
    ['a root session keeps the counter without messages', true, [], 3],
  ])('%s', (_name, isRoot, messages, expected) => {
    expect(rootTurnReset({ turns: 3, isRoot, messages })).toBe(expected);
  });
});
