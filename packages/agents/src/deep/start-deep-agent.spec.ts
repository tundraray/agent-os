import { createLogger } from '@agent-os/common';

import type {
  NamedStartRequest,
  NamedStartResolution,
} from '../start/resolve-start';
import type { RunStart } from '../start/run-definition';
import type { InCommitToolInput, StartChildRequest } from '../tools/tool';
import {
  createStartDeepAgentTool,
  type PreparedDeepAgentStart,
  type StartDeepAgentArgs,
} from './start-deep-agent';

const DEEP_AGENT_NAME = 'Ресерч платежей';
const EDITED_DEEP_AGENT_NAME = 'Demo research';
const EDITED_DEEP_AGENT_ID = '7d2e4f61-1a3b-4c5d-8e9f-0a1b2c3d4e5f';
const MODEL = 'anthropic/claude-sonnet-5-5';
const CHAT_MODEL = 'anthropic/claude-haiku-5-5';
const SILENT = createLogger({ sinks: [], secrets: [], minLevel: 'error' });

const run: RunStart = {
  name: 'Demo research',
  subagent: null,
  model: MODEL,
  version: {
    id: '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f',
    agentId: EDITED_DEEP_AGENT_ID,
    number: 4,
    kind: 'deep_agent',
    content: {
      prompt: 'Research.',
      servers: [],
      model: MODEL,
      maxTurns: 20,
      subagents: [
        {
          name: 'answer',
          description: 'Writes the answer.',
          prompt: 'Answer.',
          servers: [],
          model: MODEL,
          maxTurns: 5,
          maxRuns: 1,
          taskList: false,
        },
      ],
      finalSubagent: 'answer',
      taskList: true,
      listDelegation: true,
      selfLearning: false,
      scripts: [],
    },
  },
};

const requested: StartDeepAgentArgs = {
  deepAgent: DEEP_AGENT_NAME,
  question: 'Why did checkout errors rise on Monday?',
  boundaries: 'Last 7 days, production only',
  result: 'A short list of causes with numbers',
};
/** The employee's edit on the brief card: another deep agent's name and a narrower boundary. */
const confirmed: StartDeepAgentArgs = {
  ...requested,
  deepAgent: EDITED_DEEP_AGENT_NAME,
  boundaries: 'Last 3 days',
};

function toolOver(resolution: NamedStartResolution) {
  const asked: NamedStartRequest[] = [];
  const tool = createStartDeepAgentTool({
    resolveNamedStart: async (request) => {
      asked.push(request);
      return resolution;
    },
    answeredChip: async () => null,
    auditStartRefusal: async () => undefined,
    logger: SILENT,
  });
  return { tool, asked };
}

/** The chat that calls the tool: its model is the second link of the deep agent's model chain (KD-3). */
const caller = {
  agentId: 'chat-1',
  ownerId: 'owner-1',
  rootId: 'chat-1',
  root: true,
  depth: 0,
  run: { model: CHAT_MODEL },
};

/** `prepare` and `execute` as the runner calls them after the decision, with the confirmed arguments. */
async function runConfirmed(resolution: NamedStartResolution) {
  const { tool, asked } = toolOver(resolution);
  const started: StartChildRequest[] = [];
  const prepared = await tool.prepare?.({
    callId: 'call-1',
    args: confirmed,
    caller,
  } as never);
  const result = await tool.execute({
    callId: 'call-1',
    args: confirmed,
    caller,
    effects: {},
    prepared,
    startChild: async (request: StartChildRequest) => {
      started.push(request);
      return { agentId: 'run-42' };
    },
  } as unknown as InCommitToolInput<
    StartDeepAgentArgs,
    PreparedDeepAgentStart
  >);
  return { asked, started, result };
}

// DD «`start_deep_agent`»: the brief card holds the deep agent's name and the three fields; the root alone gets the tool.
describe('start_deep_agent brief card', () => {
  it('shows the deep agent name and the three fields of the requested brief', () => {
    const { tool } = toolOver({ kind: 'started', run });

    expect(tool.rootOnly).toBe(true);
    expect(tool.confirmation?.content(requested, [])).toEqual({
      deepAgent: DEEP_AGENT_NAME,
      question: 'Why did checkout errors rise on Monday?',
      boundaries: 'Last 7 days, production only',
      result: 'A short list of causes with numbers',
    });
  });
});

// AC-03.1 (rule): the deep agent's version is resolved by the confirmed name on behalf of the employee, and the
// deep agent starts on it with the confirmed brief as JSON in the order question, boundaries, result; a
// refused resolution starts nothing. DC-27 (rule): the name of an agent the employee sees is `not_allowed`.
describe('start_deep_agent on the confirmed brief', () => {
  const confirmedBrief =
    '{"question":"Why did checkout errors rise on Monday?","boundaries":"Last 3 days","result":"A short list of causes with numbers"}';

  it.each<[string, NamedStartResolution, StartChildRequest[], unknown]>([
    [
      'a resolved deep agent starts on its version',
      { kind: 'started', run },
      [
        {
          run,
          prompt: confirmedBrief,
          description: 'Why did checkout errors rise on Monday?',
        },
      ],
      { kind: 'done', outcome: 'success', childAgentId: 'run-42' },
    ],
    [
      'the name of an agent starts nothing and names the tool that starts it',
      { kind: 'other_kind', found: 'agent' },
      [],
      {
        kind: 'refused',
        reason: 'not_allowed',
        refusalDetail: null,
        text: 'This name is an agent, not a deep agent: start it with start_agent.',
      },
    ],
    [
      'a model not allowed starts nothing and names the model',
      {
        kind: 'refused',
        reason: 'model_not_allowed',
        model: MODEL,
        denied: null,
      },
      [],
      {
        kind: 'refused',
        reason: 'model_not_allowed',
        refusalDetail: { model: MODEL },
      },
    ],
  ])('%s', async (_case, resolution, expectedStarts, expectedResult) => {
    const { asked, started, result } = await runConfirmed(resolution);

    expect(asked).toEqual([
      {
        ownerId: 'owner-1',
        name: EDITED_DEEP_AGENT_NAME,
        kind: 'deep_agent',
        callerModel: CHAT_MODEL,
        chip: null,
      },
    ]);
    expect(started).toEqual(expectedStarts);
    expect(result).toMatchObject(expectedResult as object);
  });
});
