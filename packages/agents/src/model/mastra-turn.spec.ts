// KD-3 (design-chat.md): the model is called as a stream — text parts reach `onText` in order, the tool
// call and the usage are collected from the stream, a provider error rejects the call. KD-6
// (design-agents.md, Risks «MCP-схемы в JSON Schema…»): the argument schema of a tool reaches the provider
// request as the model must see it. Only the provider network is replaced; Mastra and the AI SDK are real.
import { createAnthropic } from '@ai-sdk/anthropic';
import { z } from 'zod';
import { type AgentToolDefinition, type AgentTurnGeneration, createMastraTurnClient } from './mastra-turn.js';

/** An MCP tool schema in the shape the fixture servers list: description, enum, array, nested object. */
const MCP_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'Full-text query over the log lines' },
    level: { type: 'string', enum: ['debug', 'info', 'warn', 'error'] },
    services: { type: 'array', items: { type: 'string' } },
    window: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'ISO-8601 start' },
        to: { type: 'string', description: 'ISO-8601 end' },
      },
      required: ['from', 'to'],
      additionalProperties: false,
    },
  },
  required: ['query'],
  additionalProperties: false,
} as const;

const SEARCH_LOGS: AgentToolDefinition = {
  name: 'mcp__logs__search_logs',
  description: 'Search log lines',
  inputSchema: MCP_INPUT_SCHEMA,
};

/**
 * A Messages API event stream: two text parts, one `tool_use` call of `search_logs` with its arguments
 * in two JSON pieces (unless `withToolCall` is false), and the usage — input tokens in `message_start`,
 * output tokens in `message_delta`.
 */
function streamedAnswer(withToolCall = true): Response {
  const events: [string, unknown][] = [
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id: 'msg_probe',
          type: 'message',
          role: 'assistant',
          model: 'claude-probe',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 12, output_tokens: 1 },
        },
      },
    ],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Looking ' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'at the logs.' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ];
  const toolUse: [string, unknown][] = [
    [
      'content_block_start',
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'toolu_probe', name: 'mcp__logs__search_logs', input: {} },
      },
    ],
    [
      'content_block_delta',
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"query":' } },
    ],
    [
      'content_block_delta',
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"errors"}' } },
    ],
    ['content_block_stop', { type: 'content_block_stop', index: 1 }],
  ];
  const end: [string, unknown][] = [
    [
      'message_delta',
      {
        type: 'message_delta',
        delta: { stop_reason: withToolCall ? 'tool_use' : 'end_turn', stop_sequence: null },
        usage: { output_tokens: 9 },
      },
    ],
    ['message_stop', { type: 'message_stop' }],
  ];
  const body = [...events, ...(withToolCall ? toolUse : []), ...end]
    .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

/** The provider is overloaded: the status a retryable provider error carries. */
function overloaded(): Response {
  return Response.json(
    { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
    { status: 503 },
  );
}

interface ProbeRun {
  /** Request bodies the provider double received, parsed. */
  readonly bodies: { stream?: boolean; tools: { name: string; input_schema: unknown }[] }[];
  /** Raw request bodies, for the wire flag. */
  readonly rawBodies: string[];
  readonly parts: string[];
  readonly result: Promise<AgentTurnGeneration>;
}

/** Runs one streamed turn with the given tools against a provider double answering with `answer`. */
function runTurn(tools: readonly AgentToolDefinition[], answer: () => Response = () => streamedAnswer()): ProbeRun {
  const rawBodies: string[] = [];
  const parts: string[] = [];
  const anthropic = createAnthropic({
    baseURL: 'http://provider.invalid/v1',
    apiKey: 'probe',
    fetch: async (_input, init) => {
      rawBodies.push(String(init?.body as string));
      return answer();
    },
  });
  const client = createMastraTurnClient((modelId) => anthropic(modelId.replace(/^anthropic\//, '')));
  const result = client.streamTurn(
    {
      purpose: 'agent_turn',
      agentName: 'probe',
      model: 'anthropic/claude-probe',
      instructions: 'You are a probe.',
      messages: [{ role: 'user', content: 'Find the errors.' }],
      tools,
      maxOutputTokens: 100,
    },
    { signal: new AbortController().signal, onText: (text) => parts.push(text) },
  );
  return {
    get bodies() {
      return rawBodies.map((body) => JSON.parse(body) as ProbeRun['bodies'][number]);
    },
    rawBodies,
    parts,
    result,
  };
}

describe('createMastraTurnClient streams a turn (KD-3)', () => {
  it('hands the text parts to onText in order and collects the tool call and the usage from the stream', async () => {
    const run = runTurn([SEARCH_LOGS]);
    const generation = await run.result;

    expect(run.rawBodies).toHaveLength(1);
    expect(run.rawBodies[0]).toContain('"stream":true');
    expect(run.parts).toEqual(['Looking ', 'at the logs.']);
    expect(generation.text).toBe('Looking at the logs.');
    expect(generation.toolCalls).toEqual([
      { toolCallId: 'toolu_probe', toolName: 'mcp__logs__search_logs', args: { query: 'errors' } },
    ]);
    expect(generation.usage).toMatchObject({ inputTokens: 12, outputTokens: 9 });
  });

  it('rejects with the provider error, so ModelClient can retry it', async () => {
    const run = runTurn([SEARCH_LOGS], overloaded);

    await expect(run.result).rejects.toMatchObject({ name: 'AI_APICallError', statusCode: 503 });
    expect(run.rawBodies).toHaveLength(1);
    expect(run.parts).toEqual([]);
  });
});

describe('createMastraTurnClient tool schemas on the wire (KD-6)', () => {
  it('an MCP JSON Schema reaches the provider request unchanged', async () => {
    const run = runTurn([SEARCH_LOGS]);
    await run.result;

    // Mastra passes a JSON Schema through as a clone and only adds the draft-07 `$schema` marker it puts
    // on every tool schema, zod ones too; every keyword of the server's schema arrives as listed.
    const request = run.bodies[0];
    expect(request?.tools[0]?.name).toBe('mcp__logs__search_logs');
    expect(request?.tools[0]?.input_schema).toEqual({
      $schema: 'http://json-schema.org/draft-07/schema#',
      ...MCP_INPUT_SCHEMA,
    });
  });

  it('a zod schema of a built-in tool reaches the provider as a JSON Schema object', async () => {
    const run = runTurn(
      [{ name: 'stop_agent', description: 'Stop a child agent', inputSchema: z.object({ agentId: z.string() }) }],
      () => streamedAnswer(false),
    );
    await run.result;

    const request = run.bodies[0];
    expect(request?.tools[0]?.name).toBe('stop_agent');
    expect(request?.tools[0]?.input_schema).toMatchObject({
      type: 'object',
      properties: { agentId: { type: 'string' } },
      required: ['agentId'],
    });
  });
});
