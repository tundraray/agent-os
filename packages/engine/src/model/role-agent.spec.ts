import { z } from 'zod';
import { agentToolsOf, BASE_TOOLS, createToolRegistry } from '../agents/tool-registry.js';
import type { RoleModel } from '../ports.js';
import { RESEARCH_CLOSE_FORM } from '../research-flow/forms/research-close.js';
import { RESEARCH_TOOLS } from '../research-flow/research-tools.js';
import {
  type AgentToolCall,
  type AgentToolChoice,
  type AgentToolDefinition,
  type AgentTurnMessage,
  countedTurnTools,
  mastraAgentTurnClient,
} from './role-agent.js';

/** A language model of the current specification; ADR-0004 keeps the AI SDK and its test doubles out of src. */
type LanguageModel = Extract<RoleModel, { specificationVersion: 'v4' }>;
type GenerateOptions = Parameters<LanguageModel['doGenerate']>[0];

const MARK = { anthropic: { cacheControl: { type: 'ephemeral' } } };

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

// DC-30: a turn is counted with the tool schemas its request sends. Mastra converts each schema for the model (on a
// Claude model it flattens a union and moves the checks into descriptions), so a count of the schemas as zod writes them
// counts other bytes and, for a union at the root, is refused by the provider. Asserted on every tool of the research
// process against the request the language model received.
// Defect caught: the counted schemas drifting from the sent ones.
describe('countedTurnTools: a turn counts the tool schemas its request sends', () => {
  it('gives every engine tool, finish with its form among them, in the form a Claude model receives it', async () => {
    const { model: counting, requests } = countingModel([{ type: 'text', text: 'done' }]);
    const model: LanguageModel = { ...counting, modelId: 'claude-haiku-5-5', provider: 'anthropic.messages' };
    const registry = createToolRegistry([...BASE_TOOLS, ...RESEARCH_TOOLS]);
    const tools = agentToolsOf(
      [...registry.keys()].filter((name) => name !== 'finish'),
      { registry, resultSchema: RESEARCH_CLOSE_FORM.resultSchema },
    );
    const call = { agentName: 'lead', model, instructions: 'the lead prompt', messages: FIRST_TURN, tools };

    await mastraAgentTurnClient.generateTurn(
      { ...call, toolChoice: 'auto', effort: 'low', maxOutputTokens: 200 },
      new AbortController().signal,
    );
    const sent = requests.generated[0]?.tools?.map((tool) => ({
      name: tool.name,
      description: 'description' in tool ? tool.description : undefined,
      inputSchema: 'inputSchema' in tool ? tool.inputSchema : undefined,
    }));

    expect(await countedTurnTools(model, tools)).toEqual(sent);
    expect(sent).toHaveLength(registry.size);
  });
});
