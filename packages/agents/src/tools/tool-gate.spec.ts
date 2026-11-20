import { createLogger } from '@agent-os/common';
import { type RecordHeader, RUN_CODE_TOOL, RunCodeArgsSchema } from '@agent-os/contracts';
import type { Database } from '@agent-os/db';
import type { StepContext } from '@agent-os/runtime';
import { z } from 'zod';
import { type AccessDeniedEntry, type AccessGate, OwnerDisabledError } from '../access-gate.js';
import type { AgentSnapshot } from '../start/snapshot.js';
import type { CallState } from '../history/call-state.js';
import { createToolStep } from '../step/tool-step.js';
import type { Session, SessionInput } from '../store/sessions.repository.js';
import { createLibraryDouble } from '../testing.js';
import type { AgentTool, ToolCaller } from './tool.js';
import { gateStart, type LaunchSet, type StartGateInput } from './tool-gate.js';
import { createToolRegistry, type SessionTool } from './tool-registry.js';
import { createToolRunner, type ToolRunner, type ToolRunnerOptions } from './tool-runner.js';

// AC-03.1, AC-11.3, DC-6 (a refused call never reaches the server and carries its reason), AC-10.3
// (depth); custom-agents UC-E4, AC-16.6, AC-15.2 (the launch set: the root's, an agent's `agents`, the
// coordinator's team and its `maxRuns`); design-access.md DC-1, DC-4, AC-16.1, AC-17.1, AC-18.1 (the
// server–tool pair, one audit record per refusal).
const OWNER = 'employee-1';

/** A uuid whose last group is `n`. */
function id(n: number): string {
  return `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
}

/** An agent's snapshot that names no tool and no server (code-execution AC-01.2, UC-3). */
const NO_TOOLS: AgentSnapshot = {
  kind: 'agent',
  name: 'no-tools',
  origin: {
    recordId: id(1),
    kind: 'agent',
    version: 1,
    name: 'no-tools',
    author: { id: id(900), name: 'Аня' },
    builtinKey: null,
    executor: null,
  },
  content: {
    prompt: 'Answer.',
    servers: [],
    model: 'anthropic/claude-haiku-5-5',
    maxTurns: 10,
    agents: [],
    tools: [],
  },
  agents: [],
};

const CALLER: ToolCaller = {
  agentId: 'agent-1',
  ownerId: OWNER,
  rootId: 'agent-1',
  parentId: null,
  depth: 0,
  snapshot: NO_TOOLS,
};

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
  /** `<server>/<tool>` pairs the gate allows the owner. */
  readonly ownerPairs: readonly string[];
  readonly args: unknown;
}

const MCP_CALL: CallCheckInput = {
  toolName: 'mcp__logs__search',
  sessionTools: [START_AGENT_TOOL, MCP_TOOL],
  ownerPairs: ['logs/search'],
  args: { query: 'error' },
};

const START_AGENT_CALL: CallCheckInput = {
  toolName: 'start_agent',
  sessionTools: [START_AGENT_TOOL],
  ownerPairs: [],
  args: { description: 'gather', agent: id(2), prompt: 'look' },
};

const NO_SERVER_CALLS = async (): Promise<never> => {
  throw new Error('a check calls no server');
};

const SILENT = createLogger({ sinks: [], secrets: [], minLevel: 'error' });

/** The gate double: the owner is on and has `pairs`, or is disabled. */
function gateOf(pairs: readonly string[] | 'owner_disabled'): Pick<AccessGate, 'tools'> {
  return {
    tools: async () =>
      pairs === 'owner_disabled'
        ? { kind: 'owner_disabled' }
        : { kind: 'allowed', allows: (server, tool) => pairs.includes(`${server}/${tool}`) },
  };
}

/** The pairs `check` refuses with, as a step gets them from the gate. */
function allowsOf(pairs: readonly string[]) {
  return (server: string, tool: string) => pairs.includes(`${server}/${tool}`);
}

interface RunnerDoubles {
  readonly pairs?: readonly string[] | 'owner_disabled';
  readonly credentialsFor?: ToolRunnerOptions['accounts']['credentialsFor'];
  readonly audits?: AccessDeniedEntry[];
}

/** A runner over the gate double whose client sends nothing: a call that reaches a server throws. */
function runnerOf(doubles: RunnerDoubles = {}): ToolRunner {
  return createToolRunner({
    client: { callTool: NO_SERVER_CALLS },
    accounts: { credentialsFor: doubles.credentialsFor ?? NO_SERVER_CALLS },
    access: gateOf(doubles.pairs ?? []),
    audit: async (entry) => {
      doubles.audits?.push(entry);
    },
    callTimeoutMs: 1000,
    toolResultMaxBytes: 1024,
    startChildFor: () => async () => ({ agentId: 'child-1' }),
  });
}

/** `ToolRunner.check` with the given pairs; a check calls no server. */
function checkCall(input: CallCheckInput, runner = runnerOf({ pairs: input.ownerPairs })) {
  return runner.check(
    { callId: 'call-1', toolName: input.toolName, args: input.args },
    { sessionTools: input.sessionTools, caller: CALLER, allows: allowsOf(input.ownerPairs) },
  );
}

/** DC-2: a call that passed the check, sent after its server row was removed or switched off. */
async function sendToGoneServer(): Promise<Gate> {
  const runner = runnerOf({ pairs: MCP_CALL.ownerPairs, credentialsFor: async () => ({ kind: 'server_gone' }) });
  const checked = checkCall(MCP_CALL, runner);
  if (checked.kind !== 'allowed') throw new Error('the call must pass the check');
  const execution = await runner.runOutside(checked.call, {
    signal: new AbortController().signal,
    logger: SILENT,
    guard: NO_SERVER_CALLS,
  });
  return kindOf(execution);
}

const RUN_CODE_STUB: AgentTool = {
  name: RUN_CODE_TOOL,
  description: 'Runs a script',
  argsSchema: RunCodeArgsSchema,
  mode: 'outside',
  execute: async () => ({ kind: 'done', outcome: 'success', text: '' }),
};

/** `check` of a `run_code` call against the set the registry builds for a child running `NO_TOOLS`. */
async function checkRunCode(runClass: 'read' | 'write', script: string): Promise<Gate> {
  const registry = createToolRegistry({
    builtins: [],
    runCode: RUN_CODE_STUB,
    // A snapshot that names no server reads nothing of the registry.
    database: {} as Database,
    access: gateOf([]),
    library: createLibraryDouble(),
    logger: SILENT,
  });
  const sessionTools = await registry.sessionTools({
    snapshot: NO_TOOLS,
    ownerId: OWNER,
    agentId: CALLER.agentId,
    root: false,
  });
  return kindOf(
    checkCall({
      toolName: RUN_CODE_TOOL,
      sessionTools,
      ownerPairs: [],
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

/** A header of the starter's `listVisible`: another's agent the chat offers, unless overridden. */
function header(n: number, overrides: Partial<RecordHeader> = {}): RecordHeader {
  return {
    id: id(n),
    kind: 'agent',
    name: `Агент ${n}`,
    description: 'Работает',
    version: 1,
    builtinKey: null,
    author: { id: id(900), name: 'Аня', disabled: false },
    mine: false,
    shared: false,
    offerInChat: true,
    ...overrides,
  };
}

/** The root's set: an offered agent, own and another's records without the switch, a workflow. */
const ROOT: LaunchSet = {
  kind: 'root',
  tool: 'agent',
  headers: [
    header(2),
    header(3, { mine: true, offerInChat: false }),
    header(4, { offerInChat: false }),
    header(5, { kind: 'workflow' }),
  ],
};

/** An agent whose snapshot's `agents` hold one record. */
const AGENT_SET: LaunchSet = { kind: 'agents', ids: [id(2)] };

/** A coordinator's team: `gather` may run twice. */
const TEAM: LaunchSet = { kind: 'team', executors: [{ name: 'gather', maxRuns: 2 }] };

const START: StartGateInput = {
  launchSet: AGENT_SET,
  target: { kind: 'record', recordId: id(2) },
  depth: 1,
  maxDepth: 3,
};

/** `gateStart` of `START` with the given launch set and target. */
function gate(launchSet: LaunchSet, target: StartGateInput['target']): Gate {
  return kindOf(gateStart({ ...START, launchSet, target }));
}

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
      'a pair the gate does not allow, though another tool of its server is allowed',
      () => kindOf(checkCall({ ...MCP_CALL, ownerPairs: ['logs/tail'] })),
      { kind: 'refused', reason: 'no_access' },
    ],
    [
      'arguments that fail the schema',
      () => kindOf(checkCall({ ...START_AGENT_CALL, args: { agent: 'general-purpose' } })),
      { kind: 'refused', reason: 'invalid_arguments' },
    ],
    ['an allowed MCP call', () => kindOf(checkCall(MCP_CALL)), { kind: 'allowed' }],
    [
      'an allowed MCP call whose server is gone by the send',
      sendToGoneServer,
      { kind: 'refused', reason: 'tool_not_in_definition' },
    ],
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
      "a record outside the agent's agents",
      () => gate(AGENT_SET, { kind: 'record', recordId: id(3) }),
      { kind: 'refused', reason: 'not_allowed' },
    ],
    ["a record of the agent's agents", () => gate(AGENT_SET, { kind: 'record', recordId: id(2) }), { kind: 'allowed' }],
    [
      'an executor that reached its maxRuns',
      () => gate(TEAM, { kind: 'executor', name: 'gather', startedCount: 2 }),
      { kind: 'refused', reason: 'run_limit' },
    ],
    [
      'an executor under its maxRuns',
      () => gate(TEAM, { kind: 'executor', name: 'gather', startedCount: 1 }),
      { kind: 'allowed' },
    ],
    [
      'a name outside the team',
      () => gate(TEAM, { kind: 'executor', name: 'answer', startedCount: 0 }),
      { kind: 'refused', reason: 'not_allowed' },
    ],
    ['a fork at a coordinator', () => gate(TEAM, { kind: 'fork' }), { kind: 'refused', reason: 'not_allowed' }],
    ['a fork at an agent', () => gate(AGENT_SET, { kind: 'fork' }), { kind: 'allowed' }],
    ['the root starts an agent the chat offers', () => gate(ROOT, { kind: 'record', recordId: id(2) }), { kind: 'allowed' }],
    [
      'the root starts its own agent without «предлагать в главном чате»',
      () => gate(ROOT, { kind: 'record', recordId: id(3) }),
      { kind: 'allowed' },
    ],
    [
      "the root starts another's agent without «предлагать в главном чате»",
      () => gate(ROOT, { kind: 'record', recordId: id(4) }),
      { kind: 'refused', reason: 'not_allowed' },
    ],
    [
      'the root starts a workflow with start_agent',
      () => gate(ROOT, { kind: 'record', recordId: id(5) }),
      { kind: 'refused', reason: 'not_allowed' },
    ],
    [
      'a depth over the limit',
      () => kindOf(gateStart({ ...START, depth: 3 })),
      { kind: 'refused', reason: 'depth_limit' },
    ],
    ['a child exactly at the depth limit', () => kindOf(gateStart({ ...START, depth: 2 })), { kind: 'allowed' }],
  ])('%s', async (_, gate, expected) => {
    expect(await gate()).toEqual(expected);
  });
});

/** A changing tool of the same server: it needs a confirmation when allowed. */
const CHANGING_TOOL: SessionTool = {
  kind: 'mcp',
  name: 'mcp__logs__purge',
  description: 'Purge log lines',
  inputSchema: { type: 'object' },
  mcp: { ...MCP_TOOL.mcp, name: 'mcp__logs__purge', tool: 'purge', description: 'Purge log lines', readOnly: false },
};

/** An agent whose snapshot names the `logs` server. */
const HELPER: AgentSnapshot = {
  ...NO_TOOLS,
  name: 'helper',
  content: { ...NO_TOOLS.content, servers: ['logs'] },
};

const HELPER_INPUT: SessionInput = { snapshot: HELPER, prompt: 'Clean up the logs', description: 'Clean up' };

/** The denied tool was not offered, so the model step stored the name as asked, without a server. */
const OPEN_PURGE: CallState = {
  callId: 'call-1',
  answerSeq: 2,
  position: 0,
  tool: 'mcp__logs__purge',
  server: null,
  args: {},
  state: 'requested',
  sentAt: null,
  attempts: 0,
  result: null,
};

const SESSION: Session = {
  taskId: CALLER.agentId,
  parentId: CALLER.parentId,
  ownerId: OWNER,
  name: HELPER.name,
  origin: HELPER.origin,
  firstRun: true,
  description: HELPER_INPUT.description,
  model: HELPER.content.model,
  prompt: HELPER_INPUT.prompt,
  forkedFromTaskId: null,
  forkedThroughSeq: null,
  turns: 0,
  interrupted: false,
  closed: false,
  lastInputTokens: null,
  createdAt: new Date(0),
};

function stepContext(): StepContext {
  return {
    taskId: CALLER.agentId,
    rootId: CALLER.rootId,
    parentId: null,
    ownerId: OWNER,
    depth: 0,
    type: 'agent',
    input: HELPER_INPUT,
    stepNo: 3,
    resumedAfterLoss: false,
    messages: [],
    decision: null,
    signal: new AbortController().signal,
    logger: SILENT,
    guard: NO_SERVER_CALLS,
  };
}

/** What one admission scenario gave: its end, the audit records and how many credentials were read. */
interface Admission {
  readonly end: string;
  readonly audits: readonly AccessDeniedEntry[];
  readonly credentialsRead: number;
}

const DENIED_PURGE: AccessDeniedEntry = {
  kind: 'access_denied',
  actor: OWNER,
  objectType: 'tool',
  objectId: 'logs/purge',
  outcome: 'rejected',
  reason: 'no_access',
};

const DENIED_SEARCH: AccessDeniedEntry = { ...DENIED_PURGE, objectId: 'logs/search' };

/** Runs one scenario over a runner whose credentials read counts and answers `server_gone`. */
async function admission(
  pairs: readonly string[] | 'owner_disabled',
  act: (runner: ToolRunner, audits: AccessDeniedEntry[]) => Promise<{ kind: string; reason?: string } | string>,
): Promise<Admission> {
  const audits: AccessDeniedEntry[] = [];
  let credentialsRead = 0;
  const runner = runnerOf({
    pairs,
    audits,
    credentialsFor: async () => {
      credentialsRead += 1;
      return { kind: 'server_gone' };
    },
  });
  const end = await act(runner, audits).then(
    (result) => (typeof result === 'string' ? result : [result.kind, result.reason].filter(Boolean).join(' ')),
    (error: unknown) => (error instanceof OwnerDisabledError ? `rejects ${error.code}` : Promise.reject(error)),
  );
  return { end, audits, credentialsRead };
}

/** A call that passed `check` when the step's set was built (the pair was allowed then). */
function resolvedSearch(runner: ToolRunner) {
  const checked = runner.check(
    { callId: 'call-1', toolName: MCP_TOOL.name, args: { query: 'error' } },
    { sessionTools: [MCP_TOOL], caller: CALLER, allows: () => true },
  );
  if (checked.kind !== 'allowed') throw new Error('the call must pass the check');
  return checked.call;
}

function resolvedBuiltin(runner: ToolRunner) {
  const checked = runner.check(
    { callId: 'call-2', toolName: START_AGENT_TOOL.name, args: START_AGENT_CALL.args },
    { sessionTools: [START_AGENT_TOOL], caller: CALLER, allows: () => false },
  );
  if (checked.kind !== 'allowed') throw new Error('the built-in call must pass the check');
  return checked.call;
}

const OUTSIDE = { signal: new AbortController().signal, logger: SILENT, guard: NO_SERVER_CALLS };

describe('a tool call is admitted only when the gate allows its server–tool pair: a refused pair is `no_access` with one audit call and no credentials asked; a denied changing tool is `no_access` without a confirmation; a built-in tool asks only whether the employee is on', () => {
  it.each<[string, () => Promise<Admission>, Admission]>([
    [
      'a direct call whose pair was taken away after the set was built',
      () => admission([], (runner) => runner.runOutside(resolvedSearch(runner), OUTSIDE)),
      { end: 'refused no_access', audits: [DENIED_SEARCH], credentialsRead: 0 },
    ],
    [
      'a confirmed call whose pair was taken away while the confirmation waited',
      () =>
        admission([], async (runner) => {
          const send = await runner.sendConfirmed(resolvedSearch(runner), { ...OUTSIDE, taskId: CALLER.agentId });
          return send.kind === 'sent' ? send.execution : send;
        }),
      { end: 'refused no_access', audits: [DENIED_SEARCH], credentialsRead: 0 },
    ],
    [
      'a call from code to a pair the gate does not allow',
      () =>
        admission(['logs/tail'], (runner) =>
          runner.callFromCode(
            { name: MCP_TOOL.name, args: { query: 'error' } },
            {
              caller: CALLER,
              snapshot: [MCP_TOOL],
              runClass: 'read',
              agentToolNames: [],
              callId: 'run-1',
              signal: new AbortController().signal,
              logger: SILENT,
            },
          ),
        ),
      { end: 'refused no_access', audits: [DENIED_SEARCH], credentialsRead: 0 },
    ],
    [
      'an allowed pair reaches the credentials',
      () => admission(['logs/search'], (runner) => runner.runOutside(resolvedSearch(runner), OUTSIDE)),
      { end: 'refused tool_not_in_definition', audits: [], credentialsRead: 1 },
    ],
    [
      'a denied changing tool in the tool step: no confirmation request, the agent goes on',
      () =>
        admission(['logs/search'], async (runner, audits) => {
          const step = createToolStep({
            registry: { checkTools: async () => [MCP_TOOL, CHANGING_TOOL] },
            runner,
            access: gateOf(['logs/search']),
            audit: async (entry) => {
              audits.push(entry);
            },
          });
          const result = await step(stepContext(), SESSION, [OPEN_PURGE]);
          return result.outcome;
        }),
      { end: 'continue', audits: [DENIED_PURGE], credentialsRead: 0 },
    ],
    [
      'a built-in tool runs although the gate allows no pair',
      () => admission([], (runner) => runner.runOutside(resolvedBuiltin(runner), OUTSIDE)),
      { end: 'done', audits: [], credentialsRead: 0 },
    ],
    [
      'a built-in tool of a disabled employee does not run',
      () => admission('owner_disabled', (runner) => runner.runOutside(resolvedBuiltin(runner), OUTSIDE)),
      { end: 'rejects OWNER_DISABLED', audits: [], credentialsRead: 0 },
    ],
  ])('%s', async (_, scenario, expected) => {
    expect(await scenario()).toEqual(expected);
  });
});
