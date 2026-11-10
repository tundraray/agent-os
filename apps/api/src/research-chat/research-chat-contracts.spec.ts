import {
  ResearchAnswerMetadataSchema,
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
  summary: 'The deploy doubled the p95 latency.',
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
  summary: null,
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
  [
    'a model_knowledge answer',
    ResearchAnswerMetadataSchema,
    modelKnowledgeAnswer,
    null,
  ],
  // agent-quality engine (design-engine.md, Contract `ResearchAnswerMetadata`): at most three summary items, and the
  // no-sources rule extended to summaryItems, confidence and causal.
  [
    'a fourth summary item',
    ResearchAnswerMetadataSchema,
    {
      ...sourcesAnswer,
      summaryItems: ['c1', 'c2', 'c3', 'c4'].map((claimId) => ({
        claimId,
        text: 'The p95 latency doubled after the deploy',
        confidence: 'high',
      })),
    },
    ['summaryItems'],
  ],
  [
    'a model_knowledge answer with a summary item',
    ResearchAnswerMetadataSchema,
    {
      ...modelKnowledgeAnswer,
      summaryItems: [
        {
          claimId: 'c1',
          text: 'Retries need backoff with jitter',
          confidence: 'low',
        },
      ],
    },
    ['summaryItems'],
  ],
  [
    'a model_knowledge answer with a confidence',
    ResearchAnswerMetadataSchema,
    {
      ...modelKnowledgeAnswer,
      assumed: [
        {
          ...claim('Retries need backoff with jitter', []),
          confidence: 'medium',
        },
      ],
    },
    ['assumed', 0, 'confidence'],
  ],
  [
    'a model_knowledge answer with a causal claim',
    ResearchAnswerMetadataSchema,
    {
      ...modelKnowledgeAnswer,
      assumed: [{ ...claim('Retries cause the latency', []), causal: true }],
    },
    ['assumed', 0, 'causal'],
  ],
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

// UC-E5 (parse half), KD-8: a message written before agent-quality still parses with the new fields at their
// defaults, and a new message keeps them instead of stripping them.
describe('researchAnswer metadata across the agent-quality update', () => {
  it('reads an old message with an empty summary list, null confidence and no causal flag', () => {
    const parsed = ResearchAnswerMetadataSchema.parse(sourcesAnswer);

    expect(parsed.summary).toBe('The deploy doubled the p95 latency.');
    expect(parsed.summaryItems).toEqual([]);
    expect(parsed.established[0]).toMatchObject({
      confidence: null,
      causal: false,
    });
    expect(parsed.assumed[0]).toMatchObject({
      confidence: null,
      causal: false,
    });
  });

  it('keeps summaryItems, confidence and causal of a new message', () => {
    const summaryItem = {
      claimId: 'claim-1',
      text: 'The p95 latency doubled after the deploy',
      confidence: 'very_high',
    };
    const parsed = ResearchAnswerMetadataSchema.parse({
      ...sourcesAnswer,
      summary: null,
      summaryItems: [summaryItem],
      established: [
        {
          ...claim('The p95 latency doubled after the deploy', [1]),
          confidence: 'very_high',
        },
      ],
      assumed: [
        {
          ...claim('The deploy caused the growth', [1]),
          causal: true,
        },
      ],
    });

    expect(parsed.summaryItems).toEqual([summaryItem]);
    expect(parsed.established[0]?.confidence).toBe('very_high');
    expect(parsed.assumed[0]?.causal).toBe(true);
  });
});
