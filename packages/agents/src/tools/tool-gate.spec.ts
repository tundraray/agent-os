import { RUN_CODE_TOOL, RunCodeArgsSchema } from '@agent-os/contracts';
import type { Database } from '@agent-os/db';
import { z } from 'zod';
import { createCatalog } from '../definitions/catalog.js';
import type { AgentDefinition } from '../definitions/definition.js';
import type { AgentTool, ToolCaller } from './tool.js';
import { gateStart, type StartGateInput } from './tool-gate.js';
import { createToolRegistry, type SessionTool } from './tool-registry.js';
import { createToolRunner } from './tool-runner.js';

// AC-03.1, AC-11.3, DC-6 (a refused call never reaches the server and carries its reason), AC-10.2,
// DC-4 (the caller's list and count), AC-10.3 (depth), DC-2 (unpriced model).
const HAIKU = 'anthropic/claude-haiku-5-5';

const OWNER = 'employee-1';
const CALLER: ToolCaller = { agentId: 'agent-1', ownerId: OWNER, rootId: 'agent-1', parentId: null, depth: 0 };

const MCP_TOOL: SessionTool = {
  kind: 'mcp',
  name: 'mcp__logs__search',
  description: 'Search log lines',
  inputSchema: { type: 'object' },
  mcp: {
    name: 'mcp__logs__search',
    server: 'logs',
    tool: 'search',
    description: 'Search log lines',
    inputSchema: { type: 'object' },
    readOnly: true,
    display: {},
  },
};

const START_AGENT_ARGS = z.object({ description: z.string(), agent: z.string(), prompt: z.string() });
const START_AGENT_TOOL: SessionTool = {
  kind: 'agent',
  name: 'start_agent',
  description: 'Start an agent',
  inputSchema: START_AGENT_ARGS,
  tool: {
    name: 'start_agent',
    description: 'Start an agent',
    argsSchema: START_AGENT_ARGS,
    mode: 'outside',
    execute: async () => ({ kind: 'done', outcome: 'success', text: '' }),
  },
};

interface CallCheckInput {
  readonly toolName: string;
  readonly sessionTools: readonly SessionTool[];
  /** Servers of the owner's row of the access table. */
  readonly ownerServers: readonly string[];
  readonly args: unknown;
}

const MCP_CALL: CallCheckInput = {
  toolName: 'mcp__logs__search',
  sessionTools: [START_AGENT_TOOL, MCP_TOOL],
  ownerServers: ['logs'],
  args: { query: 'error' },
};

const START_AGENT_CALL: CallCheckInput = {
  toolName: 'start_agent',
  sessionTools: [START_AGENT_TOOL],
  ownerServers: [],
  args: { description: 'gather', agent: 'general-purpose', prompt: 'look' },
};

const NO_SERVER_CALLS = async (): Promise<never> => {
  throw new Error('a check calls no server');
};

/** `ToolRunner.check` of a runner with the given access table; a check calls no server. */
function checkCall(input: CallCheckInput) {
  const runner = createToolRunner({
    client: { callTool: NO_SERVER_CALLS },
    accounts: { credentialsFor: NO_SERVER_CALLS },
    serverAllowed: (ownerId, server) => ownerId === OWNER && input.ownerServers.includes(server),
    callTimeoutMs: 1000,
    toolResultMaxBytes: 1024,
    startChildFor: () => async () => ({ agentId: 'child-1' }),
    ownerGate: { check: async () => {} },
  });
  return runner.check(
    { callId: 'call-1', toolName: input.toolName, args: input.args },
    { sessionTools: input.sessionTools, caller: CALLER },
  );
}

// code-execution AC-01.2, UC-3: `run_code` is in the set of a definition that names no tool.
const NO_TOOLS: AgentDefinition = {
  name: 'no-tools',
  description: 'Names no tool.',
  prompt: 'Answer.',
  tools: [],
  mcpServers: [],
  agents: [],
  maxTurns: 10,
};

const RUN_CODE_STUB: AgentTool = {
  name: RUN_CODE_TOOL,
  description: 'Runs a script',
  argsSchema: RunCodeArgsSchema,
  mode: 'outside',
  execute: async () => ({ kind: 'done', outcome: 'success', text: '' }),
};

/** `check` of a `run_code` call against the set the registry builds for `NO_TOOLS`. */
async function checkRunCode(runClass: 'read' | 'write', script: string): Promise<Gate> {
  const registry = createToolRegistry({
    builtins: [],
    runCode: RUN_CODE_STUB,
    catalog: createCatalog(),
    // A definition that names no server reads nothing of the registry.
    database: {} as Database,
    serverAllowed: () => false,
  });
  const sessionTools = await registry.sessionTools({ definition: NO_TOOLS, limits: null, ownerId: OWNER });
  return kindOf(
    checkCall({
      toolName: RUN_CODE_TOOL,
      sessionTools,
      ownerServers: [],
      args: { description: 'Count errors', class: runClass, script },
    }),
  );
}

// code-execution AC-01.5, KD-9: direction-override and zero-width characters hide what a script does.
const HIDDEN_CODE_POINTS = [0x202e, 0x2067, 0x200b, 0x2060, 0xfeff];
// KD-9 (security review): a line terminator the card draws inside a line lets code after a `//` comment run unseen.
const INLINE_LINE_BREAKS = [
  ['a lone CR', String.fromCodePoint(0x0d)],
  ['U+2028', String.fromCodePoint(0x2028)],
  ['U+2029', String.fromCodePoint(0x2029)],
] as const;
const RUN_CLASSES = ['read', 'write'] as const;

const START: StartGateInput = {
  agent: 'general-purpose',
  definitionAgents: ['general-purpose'],
  limits: null,
  startedCount: 0,
  depth: 1,
  maxDepth: 3,
  model: { kind: 'chosen', model: HAIKU },
};

const LIMITED: StartGateInput = {
  ...START,
  agent: 'gather',
  definitionAgents: [],
  limits: { agents: { gather: 2 }, finalAgent: 'answer' },
};

type Gate = { kind: 'allowed' } | { kind: 'refused'; reason: string };

function kindOf(gate: { kind: string; reason?: string }): Gate {
  return gate.kind === 'allowed' ? { kind: 'allowed' } : { kind: 'refused', reason: gate.reason ?? '' };
}

describe('a tool call is refused with its reason or allowed', () => {
  it.each<[string, () => Gate | Promise<Gate>, Gate]>([
    [
      'a tool outside the session set',
      () => kindOf(checkCall({ ...MCP_CALL, toolName: 'mcp__backoffice__create_incident_note' })),
      { kind: 'refused', reason: 'tool_not_in_definition' },
    ],
    [
      'start_agent without the tool in the definition',
      () => kindOf(checkCall({ ...START_AGENT_CALL, sessionTools: [MCP_TOOL] })),
      { kind: 'refused', reason: 'tool_not_in_definition' },
    ],
    [
      'a server outside the access table',
      () => kindOf(checkCall({ ...MCP_CALL, ownerServers: [] })),
      { kind: 'refused', reason: 'no_access' },
    ],
    [
      'arguments that fail the schema',
      () => kindOf(checkCall({ ...START_AGENT_CALL, args: { agent: 'general-purpose' } })),
      { kind: 'refused', reason: 'invalid_arguments' },
    ],
    ['an allowed MCP call', () => kindOf(checkCall(MCP_CALL)), { kind: 'allowed' }],
    ['an allowed built-in call', () => kindOf(checkCall(START_AGENT_CALL)), { kind: 'allowed' }],
    [
      'run_code in a session of a definition with tools: []',
      () => checkRunCode('read', 'return 1;'),
      { kind: 'allowed' },
    ],
    ...RUN_CLASSES.flatMap((runClass) =>
      HIDDEN_CODE_POINTS.map((codePoint): [string, () => Gate | Promise<Gate>, Gate] => [
        `run_code ${runClass} with U+${codePoint.toString(16).toUpperCase()} inside a string literal`,
        () => checkRunCode(runClass, `return "a${String.fromCodePoint(codePoint)}b";`),
        { kind: 'refused', reason: 'invalid_arguments' },
      ]),
    ),
    ...RUN_CLASSES.map((runClass): [string, () => Gate | Promise<Gate>, Gate] => [
      `run_code ${runClass} with the character written as an escape`,
      () => checkRunCode(runClass, 'return "a\\u202Eb";'),
      { kind: 'allowed' },
    ]),
    ...RUN_CLASSES.flatMap((runClass) =>
      INLINE_LINE_BREAKS.map(([name, lineBreak]): [string, () => Gate | Promise<Gate>, Gate] => [
        `run_code ${runClass} with ${name} after a // comment`,
        () => checkRunCode(runClass, `// count only${lineBreak}return 1;`),
        { kind: 'refused', reason: 'invalid_arguments' },
      ]),
    ),
    ...RUN_CLASSES.map((runClass): [string, () => Gate | Promise<Gate>, Gate] => [
      `run_code ${runClass} with CRLF line ends`,
      () => checkRunCode(runClass, '// count only\r\nreturn 1;'),
      { kind: 'allowed' },
    ]),
    [
      "an agent outside the definition's agents",
      () => kindOf(gateStart({ ...START, agent: 'answer' })),
      { kind: 'refused', reason: 'not_allowed' },
    ],
    [
      "an agent outside the caller's limits",
      () => kindOf(gateStart({ ...LIMITED, agent: 'general-purpose', definitionAgents: ['general-purpose'] })),
      { kind: 'refused', reason: 'not_allowed' },
    ],
    [
      'a start beyond the count',
      () => kindOf(gateStart({ ...LIMITED, startedCount: 2 })),
      { kind: 'refused', reason: 'not_allowed' },
    ],
    ['a start within the count', () => kindOf(gateStart({ ...LIMITED, startedCount: 1 })), { kind: 'allowed' }],
    [
      'fork in a session started with limits',
      () => kindOf(gateStart({ ...LIMITED, agent: 'fork' })),
      { kind: 'refused', reason: 'not_allowed' },
    ],
    ['fork in a session without limits', () => kindOf(gateStart({ ...START, agent: 'fork' })), { kind: 'allowed' }],
    [
      'a depth over the limit',
      () => kindOf(gateStart({ ...START, depth: 3 })),
      { kind: 'refused', reason: 'depth_limit' },
    ],
    ['a child exactly at the depth limit', () => kindOf(gateStart({ ...START, depth: 2 })), { kind: 'allowed' }],
    [
      'a model without a price',
      () => kindOf(gateStart({ ...START, model: { kind: 'refused', reason: 'unknown_model' } })),
      { kind: 'refused', reason: 'unknown_model' },
    ],
  ])('%s', async (_, gate, expected) => {
    expect(await gate()).toEqual(expected);
  });
});
