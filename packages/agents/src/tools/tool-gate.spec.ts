import { z } from 'zod';
import {
  type CallGateInput,
  gateCall,
  gateStart,
  gateTarget,
  type StartGateInput,
} from './tool-gate.js';

// AC-03.1, AC-11.3, DC-6 (a refused call never reaches the server and carries its reason), AC-10.2,
// DC-4 (the caller's list and count), AC-10.3 (depth), DC-2 (unpriced model), and the descendant-only
// target of message_agent and stop_agent.
const HAIKU = 'anthropic/claude-haiku-5-5';

const MCP_CALL: CallGateInput = {
  toolName: 'mcp__logs__search',
  sessionTools: ['start_agent', 'mcp__logs__search'],
  serverId: 'logs',
  ownerAllowed: true,
  args: { query: 'error' },
};

const START_AGENT_CALL: CallGateInput = {
  toolName: 'start_agent',
  sessionTools: ['start_agent'],
  serverId: null,
  ownerAllowed: false,
  args: { description: 'gather', agent: 'general-purpose', prompt: 'look' },
  argsSchema: z.object({ description: z.string(), agent: z.string(), prompt: z.string() }),
};

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
  it.each<[string, () => Gate, Gate]>([
    [
      'a tool outside the session set',
      () => kindOf(gateCall({ ...MCP_CALL, toolName: 'mcp__backoffice__create_incident_note' })),
      { kind: 'refused', reason: 'tool_not_in_definition' },
    ],
    [
      'start_agent without the tool in the definition',
      () => kindOf(gateCall({ ...START_AGENT_CALL, sessionTools: ['mcp__logs__search'] })),
      { kind: 'refused', reason: 'tool_not_in_definition' },
    ],
    [
      'a server outside the access table',
      () => kindOf(gateCall({ ...MCP_CALL, ownerAllowed: false })),
      { kind: 'refused', reason: 'no_access' },
    ],
    [
      'arguments that fail the schema',
      () => kindOf(gateCall({ ...START_AGENT_CALL, args: { agent: 'general-purpose' } })),
      { kind: 'refused', reason: 'invalid_arguments' },
    ],
    ['an allowed MCP call', () => kindOf(gateCall(MCP_CALL)), { kind: 'allowed' }],
    ['an allowed built-in call', () => kindOf(gateCall(START_AGENT_CALL)), { kind: 'allowed' }],
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
    [
      'a target that is not a descendant',
      () => kindOf(gateTarget({ isDescendant: false })),
      { kind: 'refused', reason: 'unknown_agent' },
    ],
    ['a descendant target', () => kindOf(gateTarget({ isDescendant: true })), { kind: 'allowed' }],
  ])('%s', (_, gate, expected) => {
    expect(gate()).toEqual(expected);
  });
});
