import { z } from 'zod';
import { controllerMessages, slotMessages, workerSlots } from '../context/role-packets.js';
import type { RoleModel } from '../ports.js';
import {
  type AgentToolCall,
  type AgentToolChoice,
  type AgentToolDefinition,
  type AgentTurnMessage,
  mastraAgentTurnClient,
  mastraRoleModelClient,
} from './role-agent.js';
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

// KD-1 (ход — один запрос к модели, вызовы инструментов исполняет код движка), ADR-0001: a turn of the agent client is
// one `doGenerate` of the model through a plain Mastra agent; the calls of the definition tools come back as data and
// none is run. Asserted on the requests the language model received, counted per turn.
// Defects caught: a second request inside one turn (Mastra running a tool and asking the model again), a tool run by
// Mastra, a call or its arguments lost on the way back, the forced `finish` not reaching the model, the cache marks
// missing from the system block or the last message.

type ModelContent = Extract<Awaited<ReturnType<LanguageModel['doGenerate']>>, { content: unknown }>['content'];

/** The language model of one turn: answers `content` and records every request it gets. */
function countingModel(content: ModelContent): { model: LanguageModel; requests: { generated: GenerateOptions[]; streamed: number } } {
  const requests = { generated: [] as GenerateOptions[], streamed: 0 };
  const model: LanguageModel = {
    specificationVersion: 'v4',
    provider: 'test',
    modelId: 'test-model',
    supportedUrls: {},
    doGenerate: (options) => {
      requests.generated.push(options);
      return Promise.resolve({
        content,
        finishReason: { unified: 'tool-calls', raw: 'tool_use' },
        usage: {
          inputTokens: { total: 120, noCache: 20, cacheRead: 100, cacheWrite: 0 },
          outputTokens: { total: 7, text: 7, reasoning: 0 },
        },
        warnings: [],
      });
    },
    doStream: () => {
      requests.streamed += 1;
      return Promise.reject(new Error('a turn does not stream'));
    },
  };
  return { model, requests };
}

const TOOLS: readonly AgentToolDefinition[] = [
  { name: 'search_logs', description: 'Search the logs.', inputSchema: z.object({ query: z.string() }).strict() },
  { name: 'note', description: 'Write a note.', inputSchema: z.object({ text: z.string() }).strict() },
  { name: 'finish', description: 'Finish the run.', inputSchema: z.object({ result: z.string() }).strict() },
];

const FIRST_TURN: readonly AgentTurnMessage[] = [{ role: 'user', content: 'find the failure' }];
const LATER_TURN: readonly AgentTurnMessage[] = [
  { role: 'user', content: 'find the failure' },
  { role: 'assistant', content: '', toolCalls: [{ toolCallId: 'c0', toolName: 'search_logs', args: { query: 'error' } }] },
  { role: 'tool', results: [{ toolCallId: 'c0', toolName: 'search_logs', output: { hits: 2 } }] },
  { role: 'user', content: 'two turns left' },
];

describe('mastraAgentTurnClient: a turn with tools makes one model request and returns the calls without running them', () => {
  it.each<
    [string, readonly AgentTurnMessage[], AgentToolChoice, ModelContent, readonly AgentToolCall[], string, unknown]
  >([
    [
      'an answer of two calls',
      FIRST_TURN,
      'auto',
      [
        { type: 'tool-call', toolCallId: 'c1', toolName: 'search_logs', input: '{"query":"timeout"}' },
        { type: 'tool-call', toolCallId: 'c2', toolName: 'note', input: '{"text":"look at the gateway"}' },
      ],
      [
        { toolCallId: 'c1', toolName: 'search_logs', args: { query: 'timeout' } },
        { toolCallId: 'c2', toolName: 'note', args: { text: 'look at the gateway' } },
      ],
      '',
      { type: 'auto' },
    ],
    ['an answer of text without a call', FIRST_TURN, 'auto', [{ type: 'text', text: 'still thinking' }], [], 'still thinking', { type: 'auto' }],
    [
      'the last turn: only `finish`',
      LATER_TURN,
      { toolName: 'finish' },
      [{ type: 'tool-call', toolCallId: 'c3', toolName: 'finish', input: '{"result":"the gateway timed out"}' }],
      [{ toolCallId: 'c3', toolName: 'finish', args: { result: 'the gateway timed out' } }],
      '',
      { type: 'tool', toolName: 'finish' },
    ],
  ])('%s', async (_, messages, toolChoice, content, calls, text, receivedChoice) => {
    const { model, requests } = countingModel(content);

    const turn = await mastraAgentTurnClient.generateTurn(
      {
        agentName: 'helper',
        model,
        instructions: 'the helper prompt',
        messages,
        tools: TOOLS,
        toolChoice,
        effort: 'low',
        maxOutputTokens: 200,
      },
      new AbortController().signal,
    );

    // KD-1: one request per turn, no stream, nothing run — the calls come back as data.
    expect(requests.generated).toHaveLength(1);
    expect(requests.streamed).toBe(0);
    expect(turn.toolCalls).toEqual(calls);
    expect(turn.text).toBe(text);
    expect(turn.usage).toEqual({ inputTokens: 120, outputTokens: 7, cachedInputTokens: 100, cacheCreationInputTokens: 0 });

    const request = requests.generated[0]!;
    expect(request.tools?.map((tool) => tool.name)).toEqual(['search_logs', 'note', 'finish']);
    expect(request.toolChoice).toEqual(receivedChoice);
    // The cache marks: on the system block and on the last message, nowhere else; the request carries only the effort.
    expect(request.prompt.map((message) => message.role)).toEqual(['system', ...messages.map((message) => message.role)]);
    expect(request.prompt.map((message) => message.providerOptions)).toEqual([
      MARK,
      ...messages.map((__, index) => (index === messages.length - 1 ? MARK : undefined)),
    ]);
    expect(request.providerOptions).toEqual({ anthropic: { effort: 'low' } });
  });

  // AC-21.1: most views end with the results of the turn before. Mastra drops the message-level options of a `tool`
  // message, so a mark set there would never reach the provider; it goes on the last result part instead, and Mastra
  // copies it onto the call that result answers. Defect caught: every turn after the first sent without the session mark.
  it('marks a view that ends with tool results on its last result part and the call it answers, nothing older', async () => {
    const { model, requests } = countingModel([{ type: 'tool-call', toolCallId: 'c3', toolName: 'finish', input: '{"result":"done"}' }]);
    const endsWithResults: readonly AgentTurnMessage[] = [
      { role: 'user', content: 'find the failure' },
      { role: 'assistant', content: '', toolCalls: [{ toolCallId: 'c0', toolName: 'search_logs', args: { query: 'error' } }] },
      { role: 'tool', results: [{ toolCallId: 'c0', toolName: 'search_logs', output: { hits: 2 } }] },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { toolCallId: 'c1', toolName: 'search_logs', args: { query: 'timeout' } },
          { toolCallId: 'c2', toolName: 'note', args: { text: 'look' } },
        ],
      },
      {
        role: 'tool',
        results: [
          { toolCallId: 'c1', toolName: 'search_logs', output: { hits: 0 } },
          { toolCallId: 'c2', toolName: 'note', output: { seq: 1 } },
        ],
      },
    ];

    await mastraAgentTurnClient.generateTurn(
      {
        agentName: 'helper',
        model,
        instructions: 'the helper prompt',
        messages: endsWithResults,
        tools: TOOLS,
        toolChoice: 'auto',
        effort: 'low',
        maxOutputTokens: 200,
      },
      new AbortController().signal,
    );

    const marked = (options: unknown) => JSON.stringify(options ?? {}).includes('cacheControl');
    const prompt = requests.generated[0]!.prompt;
    expect(prompt.map((message) => marked(message.providerOptions))).toEqual([true, false, false, false, false, false]);
    expect(prompt.map((message) => (Array.isArray(message.content) ? message.content.map((part) => marked(part.providerOptions)) : []))).toEqual([
      [],
      [false],
      [false],
      [false],
      [false, true],
      [false, true],
    ]);
  });
});
