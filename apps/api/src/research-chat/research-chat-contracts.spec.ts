import {
  ResearchAnswerMetadataSchema,
  ResearchDecisionSchema,
  ResearchLaunchViewSchema,
} from '@agent-os/contracts';

// Rules of the chat-entry part in its schemas (design-chat-entry.md, Contract Definitions; DC-8, KD-8).

const view = {
  launchKey: 'launch-1',
  mode: 'explicit',
  state: 'completed',
  notLaunchedReason: null,
  goal: 'Why did checkout latency grow last week?',
  tokenBudget: 200_000,
  createdAt: '2026-11-02T10:00:00.000Z',
  answerMessageId: 'research-answer-inv-1',
  answerPending: false,
  sourceMode: 'sources',
};

const claim = (text: string, footnotes: number[]) => ({
  text,
  footnotes,
  verified: footnotes.length > 0,
});

const sourcesAnswer = {
  launchKey: 'launch-1',
  goal: 'Why did checkout latency grow last week?',
  outcome: 'answered',
  stopReason: null,
  launch: { messageId: 'msg-user-1' },
  established: [claim('The p95 latency doubled after the deploy', [1])],
  assumed: [claim('The cache was cold', [])],
  unknown: [],
  sources: [
    {
      number: 1,
      sourceId: 'grafana',
      toolName: 'query_metrics',
      snapshot: '2026-11-01T00:00:00Z',
      truncated: false,
    },
  ],
  sourceMode: 'sources',
};

const modelKnowledgeAnswer = {
  ...sourcesAnswer,
  launch: { toolCallId: 'call-1' },
  established: [],
  assumed: [claim('Retries need backoff with jitter', [])],
  sources: [],
  sourceMode: 'model_knowledge',
};

type Row = [
  name: string,
  schema: {
    safeParse: (value: unknown) => {
      success: boolean;
      error?: { issues: { path: PropertyKey[] }[] };
    };
  },
  input: unknown,
  errorPath: PropertyKey[] | null,
];

const rows: Row[] = [
  [
    'an unknown decision action',
    ResearchDecisionSchema,
    { action: 'restart', launchKey: 'launch-1' },
    ['action'],
  ],
  [
    'answerMessageId outside completed',
    ResearchLaunchViewSchema,
    { ...view, state: 'running' },
    ['answerMessageId'],
  ],
  [
    'notLaunchedReason outside not_launched',
    ResearchLaunchViewSchema,
    { ...view, notLaunchedReason: 'declined' },
    ['notLaunchedReason'],
  ],
  [
    'a model_knowledge answer with an established claim',
    ResearchAnswerMetadataSchema,
    {
      ...modelKnowledgeAnswer,
      established: [claim('Retries need backoff with jitter', [])],
    },
    ['established'],
  ],
  [
    'a model_knowledge answer with a footnote',
    ResearchAnswerMetadataSchema,
    {
      ...modelKnowledgeAnswer,
      assumed: [claim('Retries need backoff with jitter', [1])],
    },
    ['assumed', 0, 'footnotes'],
  ],
  [
    'a model_knowledge answer with a source',
    ResearchAnswerMetadataSchema,
    { ...modelKnowledgeAnswer, sources: sourcesAnswer.sources },
    ['sources'],
  ],
  ['a confirm decision', ResearchDecisionSchema, { action: 'confirm', launchKey: 'launch-1' }, null],
  ['a completed view with its answer', ResearchLaunchViewSchema, view, null],
  [
    'a not_launched view with its reason',
    ResearchLaunchViewSchema,
    {
      ...view,
      state: 'not_launched',
      notLaunchedReason: 'superseded',
      answerMessageId: null,
    },
    null,
  ],
  ['a sources answer', ResearchAnswerMetadataSchema, sourcesAnswer, null],
  ['a model_knowledge answer', ResearchAnswerMetadataSchema, modelKnowledgeAnswer, null],
];

describe('chat-entry contract rules', () => {
  it.each(rows)('%s', (_name, schema, input, errorPath) => {
    const result = schema.safeParse(input);

    if (errorPath === null) {
      expect(result.success).toBe(true);
      return;
    }
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path)).toContainEqual(
      errorPath,
    );
  });
});
