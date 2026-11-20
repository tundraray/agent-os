import type {
  InCommitToolInput,
  StartChildRequest,
  StartRequest,
  StartResolution,
  WorkflowSnapshot,
} from '@agent-os/agents';
import type { Logger } from '@agent-os/common';

import {
  createStartWorkflowTool,
  type PreparedWorkflowStart,
  type StartWorkflowArgs,
} from './start-workflow.tool.js';

const WORKFLOW_ID = '0b7c6a52-3f5e-4d6a-9a43-2f1e8c0d9b11';
const EDITED_WORKFLOW_ID = '7d2e4f61-1a3b-4c5d-8e9f-0a1b2c3d4e5f';
const MODEL = 'anthropic/claude-sonnet-5-5';

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};

const snapshot: WorkflowSnapshot = {
  kind: 'workflow',
  name: 'Demo flow',
  origin: {
    recordId: EDITED_WORKFLOW_ID,
    kind: 'workflow',
    version: 4,
    name: 'Demo flow',
    author: null,
    builtinKey: null,
    executor: null,
  },
  content: {
    coordinator: { rules: '', model: MODEL, maxTurns: 20 },
    executors: [
      {
        name: 'answer',
        role: 'Writes the answer.',
        prompt: 'Answer.',
        servers: [],
        model: MODEL,
        maxTurns: 5,
        maxRuns: 1,
        tools: [],
        source: null,
      },
    ],
    finalExecutor: 'answer',
    selfLearning: false,
  },
};

const requested: StartWorkflowArgs = {
  workflow: WORKFLOW_ID,
  question: 'Why did checkout errors rise on Monday?',
  boundaries: 'Last 7 days, production only',
  result: 'A short list of causes with numbers',
};
/** The employee's edit on the brief card: another workflow record and a narrower boundary. */
const confirmed: StartWorkflowArgs = {
  ...requested,
  workflow: EDITED_WORKFLOW_ID,
  boundaries: 'Last 3 days',
};

function toolOver(resolution: StartResolution, inLaunchSet = true) {
  const asked: StartRequest[] = [];
  const tool = createStartWorkflowTool({
    agents: {
      resolveStart: async (request) => {
        asked.push(request);
        return resolution;
      },
      auditStartRefusal: async () => undefined,
      rootMayStart: async () => inLaunchSet,
    },
    logger: silentLogger,
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
  } as unknown as InCommitToolInput<StartWorkflowArgs, PreparedWorkflowStart>);
  return { asked, started, result };
}

// AC-13.4, Reference Contract (Confirmation): the brief card holds the workflow record and the three
// fields, no title; the root alone gets the tool.
describe('start_workflow brief card', () => {
  it('shows the workflow record and the three fields of the requested brief', () => {
    const { tool } = toolOver({ kind: 'snapshot', snapshot });

    expect(tool.rootOnly).toBe(true);
    expect(tool.confirmation?.content(requested, [])).toEqual({
      workflow: WORKFLOW_ID,
      question: 'Why did checkout errors rise on Monday?',
      boundaries: 'Last 7 days, production only',
      result: 'A short list of causes with numbers',
    });
  });
});

// AC-13.4 (rule), Flow 2: the snapshot is resolved from the confirmed arguments on behalf of the employee,
// and the coordinator starts on it with the confirmed brief; a refused resolution starts nothing.
describe('start_workflow on the confirmed brief', () => {
  const confirmedBrief =
    '{"question":"Why did checkout errors rise on Monday?","boundaries":"Last 3 days","result":"A short list of causes with numbers"}';

  it.each<[string, StartResolution, boolean, StartChildRequest[], unknown]>([
    [
      'a resolved workflow starts the coordinator on its snapshot',
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
    // AC-15.2: someone else's workflow with «предлагать в главном чате» off is visible but not startable.
    [
      'a workflow outside the chat launch set starts nothing',
      { kind: 'snapshot', snapshot },
      false,
      [],
      { kind: 'refused', reason: 'not_allowed', refusalDetail: null },
    ],
    [
      'a coordinator model not allowed starts nothing and names the model',
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
        source: { kind: 'record', recordId: EDITED_WORKFLOW_ID, expected: 'workflow' },
      },
    ]);
    expect(started).toEqual(expectedStarts);
    expect(result).toMatchObject(expectedResult as object);
  });
});
