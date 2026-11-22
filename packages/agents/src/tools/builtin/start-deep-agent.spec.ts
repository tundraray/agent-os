import { createLogger } from '@agent-os/common';

import type { StartRequest, StartResolution } from '../../start/resolve-start';
import type { DeepAgentSnapshot } from '../../start/snapshot';
import type { InCommitToolInput, StartChildRequest } from '../tool';
import {
  createStartDeepAgentTool,
  type PreparedDeepAgentStart,
  type StartDeepAgentArgs,
} from './start-deep-agent';

const DEEP_AGENT_ID = '0b7c6a52-3f5e-4d6a-9a43-2f1e8c0d9b11';
const EDITED_DEEP_AGENT_ID = '7d2e4f61-1a3b-4c5d-8e9f-0a1b2c3d4e5f';
const MODEL = 'anthropic/claude-sonnet-5-5';
const SILENT = createLogger({ sinks: [], secrets: [], minLevel: 'error' });

const snapshot: DeepAgentSnapshot = {
  kind: 'deep_agent',
  name: 'Demo research',
  origin: {
    recordId: EDITED_DEEP_AGENT_ID,
    kind: 'deep_agent',
    version: 4,
    name: 'Demo research',
    author: null,
    builtinKey: null,
    subagent: null,
  },
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
  },
};

const requested: StartDeepAgentArgs = {
  deepAgent: DEEP_AGENT_ID,
  question: 'Why did checkout errors rise on Monday?',
  boundaries: 'Last 7 days, production only',
  result: 'A short list of causes with numbers',
};
/** The employee's edit on the brief card: another deep agent record and a narrower boundary. */
const confirmed: StartDeepAgentArgs = {
  ...requested,
  deepAgent: EDITED_DEEP_AGENT_ID,
  boundaries: 'Last 3 days',
};

function toolOver(resolution: StartResolution, inLaunchSet = true) {
  const asked: StartRequest[] = [];
  const tool = createStartDeepAgentTool({
    resolveStart: async (request) => {
      asked.push(request);
      return resolution;
    },
    auditStartRefusal: async () => undefined,
    rootMayStart: async () => inLaunchSet,
    logger: SILENT,
  });
  return { tool, asked };
}

const caller = {
  agentId: 'chat-1',
  ownerId: 'owner-1',
  rootId: 'chat-1',
  parentId: null,
  depth: 0,
};

/** `prepare` and `execute` as the runner calls them after the decision, with the confirmed arguments. */
async function runConfirmed(resolution: StartResolution, inLaunchSet: boolean) {
  const { tool, asked } = toolOver(resolution, inLaunchSet);
  const started: StartChildRequest[] = [];
  const prepared = await tool.prepare?.({ args: confirmed, caller } as never);
  const result = await tool.execute({
    callId: 'call-1',
    args: confirmed,
    caller,
    tx: {},
    effects: {},
    prepared,
    startChild: async (request: StartChildRequest) => {
      started.push(request);
      return { agentId: 'run-42' };
    },
  } as unknown as InCommitToolInput<StartDeepAgentArgs, PreparedDeepAgentStart>);
  return { asked, started, result };
}

// DD «`start_deep_agent`»: the brief card holds the deep agent record and the three fields; the root alone gets the tool.
describe('start_deep_agent brief card', () => {
  it('shows the deep agent record and the three fields of the requested brief', () => {
    const { tool } = toolOver({ kind: 'snapshot', snapshot });

    expect(tool.rootOnly).toBe(true);
    expect(tool.confirmation?.content(requested, [])).toEqual({
      deepAgent: DEEP_AGENT_ID,
      question: 'Why did checkout errors rise on Monday?',
      boundaries: 'Last 7 days, production only',
      result: 'A short list of causes with numbers',
    });
  });
});

// AC-03.1 (rule): the snapshot is resolved from the confirmed arguments on behalf of the employee, and the
// deep agent starts on it with the confirmed brief as JSON in the order question, boundaries, result; a
// refused resolution starts nothing.
describe('start_deep_agent on the confirmed brief', () => {
  const confirmedBrief =
    '{"question":"Why did checkout errors rise on Monday?","boundaries":"Last 3 days","result":"A short list of causes with numbers"}';

  it.each<[string, StartResolution, boolean, StartChildRequest[], unknown]>([
    [
      'a resolved deep agent starts on its snapshot',
      { kind: 'snapshot', snapshot },
      true,
      [{ snapshot, prompt: confirmedBrief, description: 'Why did checkout errors rise on Monday?' }],
      { kind: 'done', outcome: 'success', childAgentId: 'run-42' },
    ],
    [
      'an unavailable record starts nothing',
      { kind: 'refused', reason: 'record_unavailable', model: null, denied: null },
      true,
      [],
      { kind: 'refused', reason: 'record_unavailable', refusalDetail: null },
    ],
    // AC-15.2: someone else's deep agent with «предлагать в главном чате» off is visible but not startable.
    [
      'a deep agent outside the chat launch set starts nothing',
      { kind: 'snapshot', snapshot },
      false,
      [],
      { kind: 'refused', reason: 'not_allowed', refusalDetail: null },
    ],
    [
      'a model not allowed starts nothing and names the model',
      { kind: 'refused', reason: 'model_not_allowed', model: MODEL, denied: null },
      true,
      [],
      { kind: 'refused', reason: 'model_not_allowed', refusalDetail: { model: MODEL } },
    ],
  ])('%s', async (_case, resolution, inLaunchSet, expectedStarts, expectedResult) => {
    const { asked, started, result } = await runConfirmed(resolution, inLaunchSet);

    expect(asked).toEqual([
      {
        ownerId: 'owner-1',
        source: { kind: 'record', recordId: EDITED_DEEP_AGENT_ID, expected: 'deep_agent' },
      },
    ]);
    expect(started).toEqual(expectedStarts);
    expect(result).toMatchObject(expectedResult as object);
  });
});
