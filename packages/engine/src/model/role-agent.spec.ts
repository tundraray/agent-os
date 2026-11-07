import { z } from 'zod';
import { controllerMessages, slotMessages, workerSlots } from '../context/role-packets.js';
import type { RoleModel } from '../ports.js';
import { mastraRoleModelClient } from './role-agent.js';
import type { RoleMessage } from './token-counter.js';

// DC-15, KD-6 (Contract «Клиент модели ролей»): at a controller call the client puts the `ephemeral` cache mark on the
// last part of the stable block of the input, never on the whole request; the requests of the other roles do not
// change. Asserted on the request that reaches the language model through the real Mastra agent.
// Defects caught: the mark on the request (it would cache each step's own end), on the changing block, or on a packet
// of another role; the mark dropped on its way through the agent.

/** A language model of the current specification; ADR-0004 keeps the AI SDK and its test doubles out of src. */
type LanguageModel = Extract<RoleModel, { specificationVersion: 'v4' }>;
type GenerateOptions = Parameters<LanguageModel['doGenerate']>[0];

const MARK = { anthropic: { cacheControl: { type: 'ephemeral' } } };

/** The request the model received for one `generate` of the client. */
async function requestOf(role: string, messages: readonly RoleMessage[]): Promise<GenerateOptions> {
  const received: GenerateOptions[] = [];
  const model: LanguageModel = {
    specificationVersion: 'v4',
    provider: 'test',
    modelId: 'test-model',
    supportedUrls: {},
    doGenerate: (options) => {
      received.push(options);
      return Promise.resolve({
        content: [{ type: 'text', text: '{"done":true}' }],
        finishReason: { unified: 'stop', raw: 'end_turn' },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 2, text: 2, reasoning: 0 },
        },
        warnings: [],
      });
    },
    doStream: () => Promise.reject(new Error('a role call does not stream')),
  };
  await mastraRoleModelClient.generate(
    {
      role,
      model,
      instructions: `the ${role} prompt`,
      messages,
      outputSchema: z.object({ done: z.boolean() }).strict(),
      effort: 'low',
      maxOutputTokens: 100,
    },
    new AbortController().signal,
  );
  expect(received).toHaveLength(1);
  return received[0]!;
}

const CONTROLLER = controllerMessages(
  {
    stable: { tools: [{ sourceId: 'fixture', toolName: 'search_logs', argsSchema: {} }], planRevision: { revision: 1 } },
    changing: { budget: { stepsLeft: 3 }, admissible: ['wait'] },
    rejectedAttempts: [{ kind: 'wait', reason: 'nothing_to_wait_for' }],
    taskCounts: [],
    claims: [],
  },
  [],
);
const WORKER = slotMessages(workerSlots({ subquestion: 'what failed?', pages: [{ evidenceId: 'p1', records: [{ a: 1 }] }] }));
const ASSIGNMENT = slotMessages({ assignment: 'write the plan', evidence: [] });

describe('mastraRoleModelClient: the cache mark of the controller input', () => {
  it.each<[string, string, readonly RoleMessage[], (typeof MARK | undefined)[]]>([
    ['controller', 'on the stable block, not on the changing one', CONTROLLER, [MARK, undefined]],
    ['worker', 'nowhere', WORKER, [undefined]],
    ['plan', 'nowhere', ASSIGNMENT, [undefined]],
  ])('%s: the mark is %s', async (role, _, messages, marks) => {
    const request = await requestOf(role, messages);

    const users = request.prompt.filter((message) => message.role === 'user');
    expect(users.map((message) => message.providerOptions)).toEqual(marks);
    // The mark ends the block: its last (here only) part is the text of the stable block, unchanged.
    expect(users.map((message) => (message.content as { text?: string }[]).map((part) => part.text))).toEqual(
      messages.map((message) => [message.content]),
    );
    // The request carries only the effort: no mark on the whole request.
    expect(request.providerOptions).toEqual({ anthropic: { effort: 'low' } });
  });
});
