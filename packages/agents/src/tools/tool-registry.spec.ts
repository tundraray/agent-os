import { z } from 'zod';

import type { AgentTool } from './tool';
import { loggedArgsOf } from './tool-registry';

function stubTool(name: string): AgentTool {
  return {
    name,
    description: `${name} stub`,
    argsSchema: z.object({}),
    mode: 'outside',
    execute: async () => ({ kind: 'done', outcome: 'success', text: '' }),
  };
}

// Security review: a call to a tool the session was not offered must not put its raw arguments in the log.
describe('the logged arguments of a tool the session was not offered', () => {
  const createRecord: AgentTool = {
    ...stubTool('create_record'),
    loggedArgs: () => ({ kind: 'agent' }),
  };
  const toolOf = (name: string) =>
    name === 'create_record' ? createRecord : undefined;
  const args = { kind: 'agent', prompt: 'the whole record' };

  it.each<[string, string, unknown]>([
    [
      'a registered tool keeps its own rule',
      'create_record',
      { kind: 'agent' },
    ],
    [
      'a name nobody registered gives the keys only',
      'unknown_tool',
      { keys: ['kind', 'prompt'] },
    ],
  ])('%s', (_, name, expected) => {
    expect(loggedArgsOf([], toolOf, { name, args })).toStrictEqual(expected);
  });
});
