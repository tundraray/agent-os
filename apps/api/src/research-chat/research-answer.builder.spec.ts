import type { ResearchAnswerMetadata } from '@agent-os/contracts';
import type { InvestigationView } from '@agent-os/engine';
import fc from 'fast-check';
import {
  type AnswerSourceRecord,
  buildResearchAnswer,
  citedEvidenceIds,
} from './research-answer.builder.js';

type AnswerView = NonNullable<InvestigationView['answer']>;
type Claim = AnswerView['assumed'] extends readonly (infer C)[] | undefined
  ? C
  : never;

const LAUNCH = {
  launchKey: 'launch-1',
  goal: 'Why did checkout latency grow last week?',
  launch: { messageId: 'user-message-1' },
} as const;

function viewOf(
  sourceMode: InvestigationView['sourceMode'],
  answer: AnswerView,
): InvestigationView {
  return {
    investigationId: 'inv-1',
    status: 'completed',
    controllerTaskId: 'task-1',
    processId: 'deep-research',
    version: 1,
    sourceMode,
    answer,
    usage: {
      byRoleAndModel: [],
      totalTokens: 0,
      totalCostUsd: 0,
      tokenBudget: 200_000,
    },
  };
}

const claim = (
  claimId: string,
  text: string,
  evidenceIds: string[],
  verified: boolean,
): Claim => ({
  claimId,
  text,
  evidenceIds,
  verified,
});

const answerOf = (
  fields: Partial<AnswerView> & Pick<AnswerView, 'outcome' | 'stopReason'>,
): AnswerView => ({
  answerId: 'answer-1',
  summary: null,
  established: [],
  assumed: [],
  unknown: [],
  removed: [],
  ...fields,
});

/** An answer whose process config leaves the `summary` section out: the view omits the key (investigation-view.ts). */
function withoutSummary(answer: AnswerView): AnswerView {
  const { summary: _omitted, ...rest } = answer;
  return rest;
}

// The map lists `ev-a` before `ev-b`, the answer cites `ev-b` first: numbering by the map's order is wrong.
const EVIDENCE = new Map<string, AnswerSourceRecord>([
  [
    'ev-a',
    {
      sourceId: 'logs',
      toolName: 'aggregate_logs',
      snapshot: 'snap-a',
      truncated: true,
    },
  ],
  [
    'ev-b',
    {
      sourceId: 'logs',
      toolName: 'search_logs',
      snapshot: 'snap-b',
      truncated: false,
    },
  ],
  [
    'ev-c',
    {
      sourceId: 'traces',
      toolName: 'get_trace',
      snapshot: 'snap-c',
      truncated: false,
    },
  ],
  [
    'ev-unused',
    {
      sourceId: 'traces',
      toolName: 'get_trace',
      snapshot: 'snap-x',
      truncated: false,
    },
  ],
]);

const MC_32 =
  'Источники данных не подключены — ответ опирается только на знания модели и не проверен по данным.';
const MC_34 = 'Краткий пересказ — основания в утверждениях ниже';

interface Row {
  view: InvestigationView;
  cited: string[];
  text: string;
  metadata: Omit<ResearchAnswerMetadata, 'launchKey' | 'goal' | 'launch'>;
}

// AC-20.7 (server), AC-27.3 (server), DC-9, DC-10, UC-4, UC-E8, invariant 4: text and `researchAnswer` of one answer message.
describe('buildResearchAnswer', () => {
  it.each<[string, Row]>([
    [
      'sources, answered, summary null: footnotes by first appearance, removed left out, no MC-34',
      {
        view: viewOf(
          'sources',
          answerOf({
            outcome: 'answered',
            stopReason: null,
            established: [
              claim(
                'c1',
                'Checkout p95 grew from 180 ms to 420 ms',
                ['ev-b', 'ev-a', 'ev-b'],
                true,
              ),
              claim(
                'c2',
                'The growth started after release 4.2',
                ['ev-a'],
                true,
              ),
            ],
            assumed: [
              claim(
                'c3',
                'The new retry policy doubles calls to payments',
                ['ev-c'],
                false,
              ),
            ],
            unknown: [
              claim('c4', 'Whether the mobile clients are affected', [], false),
            ],
            removed: [
              {
                claimId: 'c5',
                text: 'The database is the cause',
                reason: 'refuted',
              },
            ],
          }),
        ),
        cited: ['ev-b', 'ev-a', 'ev-c'],
        text: [
          '**Ответ ресерча** · Есть ответ',
          'Цель: Why did checkout latency grow last week?',
          '',
          '### Установлено',
          '- Checkout p95 grew from 180 ms to 420 ms [1][2]',
          '- The growth started after release 4.2 [2]',
          '',
          '### Предположения',
          '- The new retry policy doubles calls to payments [3] (не проверено)',
          '',
          '### Не выяснено',
          '- Whether the mobile clients are affected (не проверено)',
          '',
          '### Источники (3)',
          '1. logs · search_logs · snap-b',
          '2. logs · aggregate_logs · snap-a · данные усечены',
          '3. traces · get_trace · snap-c',
        ].join('\n'),
        metadata: {
          summary: null,
          outcome: 'answered',
          stopReason: null,
          established: [
            {
              text: 'Checkout p95 grew from 180 ms to 420 ms',
              footnotes: [1, 2],
              verified: true,
            },
            {
              text: 'The growth started after release 4.2',
              footnotes: [2],
              verified: true,
            },
          ],
          assumed: [
            {
              text: 'The new retry policy doubles calls to payments',
              footnotes: [3],
              verified: false,
            },
          ],
          unknown: [
            {
              text: 'Whether the mobile clients are affected',
              footnotes: [],
              verified: false,
            },
          ],
          sources: [
            {
              number: 1,
              sourceId: 'logs',
              toolName: 'search_logs',
              snapshot: 'snap-b',
              truncated: false,
            },
            {
              number: 2,
              sourceId: 'logs',
              toolName: 'aggregate_logs',
              snapshot: 'snap-a',
              truncated: true,
            },
            {
              number: 3,
              sourceId: 'traces',
              toolName: 'get_trace',
              snapshot: 'snap-c',
              truncated: false,
            },
          ],
          sourceMode: 'sources',
        },
      },
    ],
    [
      'sources, stopped by force: outcome and reason pass, no MC-32 or MC-33',
      {
        view: viewOf(
          'sources',
          answerOf({
            outcome: 'partial',
            stopReason: 'step_limit',
            established: [claim('c1', 'Checkout p95 grew', ['ev-a'], true)],
          }),
        ),
        cited: ['ev-a'],
        text: [
          '**Ответ ресерча** · Частичный ответ',
          'Цель: Why did checkout latency grow last week?',
          'Остановлен: достигнут лимит шагов',
          '',
          '### Установлено',
          '- Checkout p95 grew [1]',
          '',
          '### Источники (1)',
          '1. logs · aggregate_logs · snap-a · данные усечены',
        ].join('\n'),
        metadata: {
          summary: null,
          outcome: 'partial',
          stopReason: 'step_limit',
          established: [
            { text: 'Checkout p95 grew', footnotes: [1], verified: true },
          ],
          assumed: [],
          unknown: [],
          sources: [
            {
              number: 1,
              sourceId: 'logs',
              toolName: 'aggregate_logs',
              snapshot: 'snap-a',
              truncated: true,
            },
          ],
          sourceMode: 'sources',
        },
      },
    ],
    [
      'model_knowledge with claims: MC-32 first, MC-33 after each claim, no footnotes or sources',
      {
        view: viewOf(
          'model_knowledge',
          answerOf({
            outcome: 'answered',
            stopReason: null,
            assumed: [
              claim('c1', 'Retries need backoff with jitter', [], false),
            ],
            unknown: [claim('c2', "The provider's exact limit", [], false)],
          }),
        ),
        cited: [],
        text: [
          MC_32,
          '',
          '**Ответ ресерча** · Есть ответ',
          'Цель: Why did checkout latency grow last week?',
          '',
          '### Предположения',
          '- Retries need backoff with jitter (из знаний модели, без источника)',
          '',
          '### Не выяснено',
          "- The provider's exact limit (из знаний модели, без источника)",
        ].join('\n'),
        metadata: {
          summary: null,
          outcome: 'answered',
          stopReason: null,
          established: [],
          assumed: [
            {
              text: 'Retries need backoff with jitter',
              footnotes: [],
              verified: false,
            },
          ],
          unknown: [
            {
              text: "The provider's exact limit",
              footnotes: [],
              verified: false,
            },
          ],
          sources: [],
          sourceMode: 'model_knowledge',
        },
      },
    ],
    [
      'model_knowledge stopped before synthesis (UC-E8): MC-32 and MC-25, no claims',
      {
        view: viewOf(
          'model_knowledge',
          answerOf({ outcome: 'inconclusive', stopReason: 'budget_exhausted' }),
        ),
        cited: [],
        text: [
          MC_32,
          '',
          '**Ответ ресерча** · Вывода нет',
          'Цель: Why did checkout latency grow last week?',
          'Остановлен: исчерпан бюджет',
        ].join('\n'),
        metadata: {
          summary: null,
          outcome: 'inconclusive',
          stopReason: 'budget_exhausted',
          established: [],
          assumed: [],
          unknown: [],
          sources: [],
          sourceMode: 'model_knowledge',
        },
      },
    ],
    [
      'sources with a summary (UC-4, DC-10, MC-34): summary, then MC-34, between the header and the groups',
      {
        view: viewOf(
          'sources',
          answerOf({
            outcome: 'answered',
            stopReason: null,
            summary:
              'Latency grew because release 4.2 doubled payment retries.',
            established: [claim('c1', 'Checkout p95 grew', ['ev-a'], true)],
          }),
        ),
        cited: ['ev-a'],
        text: [
          '**Ответ ресерча** · Есть ответ',
          'Цель: Why did checkout latency grow last week?',
          '',
          'Latency grew because release 4.2 doubled payment retries.',
          '',
          MC_34,
          '',
          '### Установлено',
          '- Checkout p95 grew [1]',
          '',
          '### Источники (1)',
          '1. logs · aggregate_logs · snap-a · данные усечены',
        ].join('\n'),
        metadata: {
          summary: 'Latency grew because release 4.2 doubled payment retries.',
          outcome: 'answered',
          stopReason: null,
          established: [
            { text: 'Checkout p95 grew', footnotes: [1], verified: true },
          ],
          assumed: [],
          unknown: [],
          sources: [
            {
              number: 1,
              sourceId: 'logs',
              toolName: 'aggregate_logs',
              snapshot: 'snap-a',
              truncated: true,
            },
          ],
          sourceMode: 'sources',
        },
      },
    ],
    [
      'sources, the process config leaves the summary section out (DC-10): no paragraph, summary null',
      {
        view: viewOf(
          'sources',
          withoutSummary(
            answerOf({
              outcome: 'answered',
              stopReason: null,
              unknown: [claim('c1', 'Whether mobile is affected', [], false)],
            }),
          ),
        ),
        cited: [],
        text: [
          '**Ответ ресерча** · Есть ответ',
          'Цель: Why did checkout latency grow last week?',
          '',
          '### Не выяснено',
          '- Whether mobile is affected (не проверено)',
        ].join('\n'),
        metadata: {
          summary: null,
          outcome: 'answered',
          stopReason: null,
          established: [],
          assumed: [],
          unknown: [
            {
              text: 'Whether mobile is affected',
              footnotes: [],
              verified: false,
            },
          ],
          sources: [],
          sourceMode: 'sources',
        },
      },
    ],
    [
      'model_knowledge with a summary (DC-9, DC-10, MC-34): MC-32, header, summary, MC-34',
      {
        view: viewOf(
          'model_knowledge',
          answerOf({
            outcome: 'answered',
            stopReason: null,
            summary: 'Add backoff with jitter to the retries.',
            assumed: [
              claim('c1', 'Retries need backoff with jitter', [], false),
            ],
          }),
        ),
        cited: [],
        text: [
          MC_32,
          '',
          '**Ответ ресерча** · Есть ответ',
          'Цель: Why did checkout latency grow last week?',
          '',
          'Add backoff with jitter to the retries.',
          '',
          MC_34,
          '',
          '### Предположения',
          '- Retries need backoff with jitter (из знаний модели, без источника)',
        ].join('\n'),
        metadata: {
          summary: 'Add backoff with jitter to the retries.',
          outcome: 'answered',
          stopReason: null,
          established: [],
          assumed: [
            {
              text: 'Retries need backoff with jitter',
              footnotes: [],
              verified: false,
            },
          ],
          unknown: [],
          sources: [],
          sourceMode: 'model_knowledge',
        },
      },
    ],
    [
      'sources, only unknown claims with a summary (MC-34): summary and MC-34 stay',
      {
        view: viewOf(
          'sources',
          answerOf({
            outcome: 'inconclusive',
            stopReason: null,
            summary: 'The data does not show whether mobile is affected.',
            unknown: [claim('c1', 'Whether mobile is affected', [], false)],
          }),
        ),
        cited: [],
        text: [
          '**Ответ ресерча** · Вывода нет',
          'Цель: Why did checkout latency grow last week?',
          '',
          'The data does not show whether mobile is affected.',
          '',
          MC_34,
          '',
          '### Не выяснено',
          '- Whether mobile is affected (не проверено)',
        ].join('\n'),
        metadata: {
          summary: 'The data does not show whether mobile is affected.',
          outcome: 'inconclusive',
          stopReason: null,
          established: [],
          assumed: [],
          unknown: [
            {
              text: 'Whether mobile is affected',
              footnotes: [],
              verified: false,
            },
          ],
          sources: [],
          sourceMode: 'sources',
        },
      },
    ],
    [
      'engine summary with no claims (DC-10, MC-34): summary null, no summary paragraph, no MC-34',
      {
        view: viewOf(
          'sources',
          answerOf({
            outcome: 'inconclusive',
            stopReason: 'step_limit',
            summary: 'Latency grew because of the retries.',
            removed: [
              {
                claimId: 'c1',
                text: 'The database is the cause',
                reason: 'refuted',
              },
            ],
          }),
        ),
        cited: [],
        text: [
          '**Ответ ресерча** · Вывода нет',
          'Цель: Why did checkout latency grow last week?',
          'Остановлен: достигнут лимит шагов',
        ].join('\n'),
        metadata: {
          summary: null,
          outcome: 'inconclusive',
          stopReason: 'step_limit',
          established: [],
          assumed: [],
          unknown: [],
          sources: [],
          sourceMode: 'sources',
        },
      },
    ],
  ])('%s', (_, row) => {
    const message = buildResearchAnswer({
      view: row.view,
      launch: LAUNCH,
      evidence: EVIDENCE,
    });

    expect(citedEvidenceIds(row.view)).toEqual(row.cited);
    expect(message.id).toBe('research-answer-inv-1');
    expect(message.text).toBe(row.text);
    expect(message.researchAnswer).toEqual({
      launchKey: 'launch-1',
      goal: 'Why did checkout latency grow last week?',
      launch: { messageId: 'user-message-1' },
      ...row.metadata,
    });
  });

  // DC-9 rule as a property: a source's number is the order of its first appearance across the groups, every claim
  // cites its evidence by those numbers, and the numbers in the text are the numbers in the metadata.
  it('numbers sources by first appearance, the same for the same input, in text and metadata alike', () => {
    const groups = fc.integer({ min: 0, max: 5 }).chain((poolSize) => {
      const references = fc.array(
        poolSize === 0
          ? fc.constant('')
          : fc
              .integer({ min: 0, max: poolSize - 1 })
              .map((index) => `ev-${index}`),
        { maxLength: poolSize === 0 ? 0 : 8 },
      );
      const claims = fc.array(references, { maxLength: 4 });
      return fc.record({
        poolSize: fc.constant(poolSize),
        established: claims,
        assumed: claims,
        unknown: claims,
      });
    });

    fc.assert(
      fc.property(groups, ({ poolSize, established, assumed, unknown }) => {
        const toClaims = (group: string, refs: string[][]): Claim[] =>
          refs.map((evidenceIds, index) =>
            claim(
              `${group}-${index}`,
              `${group} claim ${index}`,
              evidenceIds,
              true,
            ),
          );
        const view = viewOf(
          'sources',
          answerOf({
            outcome: 'answered',
            stopReason: null,
            established: toClaims('established', established),
            assumed: toClaims('assumed', assumed),
            unknown: toClaims('unknown', unknown),
          }),
        );
        const evidence = new Map<string, AnswerSourceRecord>(
          Array.from({ length: poolSize }, (__, index) => [
            `ev-${index}`,
            {
              sourceId: 'logs',
              toolName: 'search_logs',
              snapshot: `snap-${index}`,
              truncated: false,
            },
          ]),
        );
        const firstAppearance = [
          ...new Set([...established, ...assumed, ...unknown].flat()),
        ];
        const numberOf = (evidenceId: string): number =>
          firstAppearance.indexOf(evidenceId) + 1;

        const message = buildResearchAnswer({ view, launch: LAUNCH, evidence });
        const metadata = message.researchAnswer;

        expect(buildResearchAnswer({ view, launch: LAUNCH, evidence })).toEqual(
          message,
        );
        expect(citedEvidenceIds(view)).toEqual(firstAppearance);
        expect(
          metadata.sources.map(({ number, snapshot }) => [number, snapshot]),
        ).toEqual(
          firstAppearance.map((evidenceId) => [
            numberOf(evidenceId),
            `snap-${evidenceId.slice(3)}`,
          ]),
        );
        expect(
          [metadata.established, metadata.assumed, metadata.unknown]
            .flat()
            .map((c) => c.footnotes),
        ).toEqual(
          [established, assumed, unknown]
            .flat()
            .map((refs) => [...new Set(refs)].map(numberOf)),
        );
        const textNumbers = new Set(
          [...message.text.matchAll(/\[(\d+)\]/g)].map((match) =>
            Number(match[1]),
          ),
        );
        const metadataNumbers = new Set(
          [metadata.established, metadata.assumed, metadata.unknown]
            .flat()
            .flatMap((c) => c.footnotes),
        );
        expect(textNumbers).toEqual(metadataNumbers);
      }),
    );
  });
});
