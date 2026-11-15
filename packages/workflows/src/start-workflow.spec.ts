import { type InCommitToolInput, type StartChildRequest, WAITING_RULE } from '@agent-os/agents';
import type { Logger } from '@agent-os/common';

import { createStartWorkflowTool, type StartWorkflowArgs } from './start-workflow.tool.js';
import { parseTemplates } from './template.js';

const [template] = parseTemplates([
  {
    name: 'demo-flow',
    title: 'Demo flow',
    description: 'Use for the demo.',
    coordinator: { prompt: 'Coordinate the executors.', maxTurns: 20 },
    agents: [
      {
        name: 'demo-gather',
        description: 'Gathers material.',
        prompt: 'Gather.',
        tools: [],
        mcpServers: ['fixture'],
        maxTurns: 10,
        maxRuns: 3,
      },
      {
        name: 'demo-answer',
        description: 'Writes the answer.',
        prompt: 'Answer.',
        tools: [],
        mcpServers: [],
        maxTurns: 5,
        maxRuns: 1,
      },
    ],
    finalAgent: 'demo-answer',
  },
]);

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};

const tool = createStartWorkflowTool({ templates: [template!], logger: silentLogger });

function validBrief(): Record<string, unknown> {
  return {
    template: 'demo-flow',
    question: 'Why did checkout errors rise on Monday?',
    boundaries: 'Last 7 days, production only',
    result: 'A short list of causes with numbers',
  };
}

type Mutate = (brief: Record<string, unknown>) => void;

// DC-4, FR-28 (rule): a bad brief never reaches the coordinator; the edit is checked by the same schema.
// Invariant 2 (rule): the confirmed brief becomes the coordinator's task with the template's limits.
describe('start_workflow arguments and spawn', () => {
  it.each<[string, Mutate, boolean]>([
    ['an unknown template', (b) => (b.template = 'other-flow'), false],
    ['an empty question', (b) => (b.question = ''), false],
    ['a question of 4001 characters', (b) => (b.question = 'q'.repeat(4001)), false],
    ['boundaries of 4001 characters', (b) => (b.boundaries = 'b'.repeat(4001)), false],
    ['a result of 4001 characters', (b) => (b.result = 'r'.repeat(4001)), false],
    ['a valid brief with empty boundaries', (b) => (b.boundaries = ''), true],
    ['a valid brief', () => undefined, true],
  ])('%s → accepted: %s', (_, mutate, accepted) => {
    const brief = validBrief();
    mutate(brief);

    expect(tool.argsSchema.safeParse(brief).success).toBe(accepted);
  });

  it('starts the coordinator with the brief as JSON, the question as description and the template limits', async () => {
    const requests: StartChildRequest[] = [];
    const args: StartWorkflowArgs = {
      template: 'demo-flow',
      question: 'Why did checkout errors rise on Monday?',
      boundaries: 'Last 7 days, production only',
      result: 'A short list of causes with numbers',
    };
    const input = {
      callId: 'call-1',
      args,
      caller: { agentId: 'chat-1', ownerId: 'owner-1', rootId: 'chat-1', parentId: null, depth: 0 },
      tx: {},
      effects: {},
      startChild: async (request: StartChildRequest) => {
        requests.push(request);
        return { agentId: 'run-42' };
      },
    } as unknown as InCommitToolInput<StartWorkflowArgs>;

    const result = await tool.execute(input);

    const briefJson =
      '{"question":"Why did checkout errors rise on Monday?","boundaries":"Last 7 days, production only","result":"A short list of causes with numbers"}';
    expect(requests).toEqual([
      {
        definition: 'demo-flow',
        prompt: briefJson,
        description: 'Why did checkout errors rise on Monday?',
        limits: { agents: { 'demo-gather': 3, 'demo-answer': 1 }, finalAgent: 'demo-answer' },
      },
    ]);
    expect(result).toEqual({
      kind: 'done',
      outcome: 'success',
      text: `Workflow "demo-flow" started in the background, run id run-42. Confirmed brief: ${briefJson}\nIts answer will arrive as a message when it finishes. ${WAITING_RULE}`,
      childAgentId: 'run-42',
    });
  });
});
