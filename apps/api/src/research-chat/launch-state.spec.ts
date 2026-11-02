import type { ResearchLaunchView } from '@agent-os/contracts';
import {
  type LaunchAction,
  type LaunchMode,
  type LaunchRecord,
  type LaunchState,
  nextLaunchState,
  toLaunchView,
} from './launch-state.js';

// State Transitions of design-chat-entry.md: every edge of the diagram, the omitted edges into `discarded`, and
// «остановка строку в `answer_reappend` не меняет». Every other pair of state and action changes nothing: a repeated
// or late decision only reads the current state (DC-1, AC-19.7), a decision turn does not supersede (DC-2), and a
// proposal leaves `proposed` only by a confirmation (invariants 1, 2).
// `start_failed` is the only action whose target depends on the launch's mode; every other edge holds for both.
const EDGES: readonly [
  LaunchState,
  LaunchAction,
  LaunchMode | 'any',
  LaunchState,
][] = [
  ['proposed', 'confirm', 'any', 'launching'],
  ['proposed', 'decline', 'any', 'declined'],
  ['proposed', 'supersede', 'any', 'superseded'],
  ['proposed', 'discard', 'any', 'discarded'],
  ['launching', 'started', 'any', 'running'],
  ['launching', 'start_failed', 'proposal', 'proposed'],
  ['launching', 'start_failed', 'explicit', 'failed'],
  ['launching', 'discard', 'any', 'discarded'],
  ['running', 'task_succeeded', 'any', 'answer_pending'],
  ['running', 'task_failed', 'any', 'failed'],
  ['running', 'task_cancelled', 'any', 'stopped'],
  ['running', 'stop', 'any', 'stopped'],
  ['running', 'discard', 'any', 'discarded'],
  ['answer_pending', 'answer_written', 'any', 'answered'],
  ['answer_pending', 'stop', 'any', 'stopped'],
  ['answer_pending', 'append_window_expired', 'any', 'failed'],
  ['answer_pending', 'discard', 'any', 'discarded'],
  ['answered', 'answer_removed', 'any', 'answer_reappend'],
  ['answered', 'discard', 'any', 'discarded'],
  ['answer_reappend', 'answer_written', 'any', 'answered'],
  ['answer_reappend', 'append_window_expired', 'any', 'failed'],
  ['answer_reappend', 'discard', 'any', 'discarded'],
];

const STATES: readonly LaunchState[] = [
  'proposed',
  'launching',
  'running',
  'answer_pending',
  'answered',
  'answer_reappend',
  'declined',
  'superseded',
  'failed',
  'stopped',
  'discarded',
];
const ACTIONS: readonly LaunchAction[] = [
  'confirm',
  'decline',
  'stop',
  'supersede',
  'discard',
  'started',
  'start_failed',
  'task_succeeded',
  'task_failed',
  'task_cancelled',
  'answer_removed',
  'append_window_expired',
  'answer_written',
];
const MODES: readonly LaunchMode[] = ['explicit', 'proposal'];

const edgeTarget = (
  state: LaunchState,
  action: LaunchAction,
  mode: LaunchMode,
): LaunchState | null =>
  EDGES.find(
    ([from, by, edgeMode]) =>
      from === state &&
      by === action &&
      (edgeMode === 'any' || edgeMode === mode),
  )?.[3] ?? null;

const transitionRows = STATES.flatMap((state) =>
  ACTIONS.flatMap((action) =>
    MODES.map((mode) => ({
      state,
      action,
      mode,
      expected: edgeTarget(state, action, mode),
    })),
  ),
);

describe('nextLaunchState (State Transitions; DC-1, DC-2, AC-19.7, invariants 1, 2)', () => {
  it.each(transitionRows)(
    '$state × $action ($mode) → $expected',
    ({ state, action, mode, expected }) => {
      expect(nextLaunchState({ state, mode }, action)).toBe(expected);
    },
  );
});

const record = (overrides: Partial<LaunchRecord>): LaunchRecord => ({
  launchKey: 'call-1',
  resourceId: 'user-1',
  threadId: 'thread-1',
  mode: 'proposal',
  goal: 'Why did checkout latency grow last week?',
  tokenBudget: 200_000,
  userMessageId: null,
  state: 'proposed',
  investigationId: null,
  controllerTaskId: null,
  sourceMode: null,
  createdAt: new Date(Date.UTC(2026, 10, 2, 10, 0, 0, 123)),
  finishedAt: null,
  answeredAt: null,
  appendFailedAt: null,
  nextAppendAt: null,
  ...overrides,
});

const INVESTIGATION = '5b0c2f3e-8a51-4f4e-9d7a-0c6f1e2b3a4d';
const TASK = '9e1d7c2a-3b4f-4a5e-8c6d-7f8a9b0c1d2e';
const started = {
  investigationId: INVESTIGATION,
  controllerTaskId: TASK,
  sourceMode: 'sources',
} as const;

const view = (overrides: Partial<ResearchLaunchView>): ResearchLaunchView => ({
  launchKey: 'call-1',
  mode: 'proposal',
  state: 'proposed',
  notLaunchedReason: null,
  goal: 'Why did checkout latency grow last week?',
  tokenBudget: 200_000,
  createdAt: '2026-11-02T10:00:00.123Z',
  answerMessageId: null,
  answerPending: false,
  sourceMode: 'model_knowledge',
  ...overrides,
});

// The engine's current mode is `model_knowledge` in every row: a row with an investigation must still show the mode
// copied from it (KD-8, DC-8), a row without one shows the engine's.
const viewRows: readonly [string, Partial<LaunchRecord>, ResearchLaunchView][] =
  [
    ['proposed shows the engine mode', {}, view({})],
    [
      'declined → not_launched, declined',
      { state: 'declined' },
      view({ state: 'not_launched', notLaunchedReason: 'declined' }),
    ],
    [
      'superseded → not_launched, superseded',
      { state: 'superseded' },
      view({ state: 'not_launched', notLaunchedReason: 'superseded' }),
    ],
    [
      'launching → running, engine mode',
      { mode: 'explicit', userMessageId: 'msg-1', state: 'launching' },
      view({ mode: 'explicit', state: 'running' }),
    ],
    [
      'failed at the start, engine mode',
      { mode: 'explicit', userMessageId: 'msg-1', state: 'failed' },
      view({ mode: 'explicit', state: 'failed' }),
    ],
    [
      'running keeps the investigation mode',
      { state: 'running', ...started },
      view({ state: 'running', sourceMode: 'sources' }),
    ],
    [
      'answer_pending → running',
      { state: 'answer_pending', ...started },
      view({ state: 'running', sourceMode: 'sources' }),
    ],
    [
      'answered → completed with the answer message',
      { state: 'answered', ...started },
      view({
        state: 'completed',
        answerMessageId: `research-answer-${INVESTIGATION}`,
        sourceMode: 'sources',
      }),
    ],
    [
      'answer_reappend → completed, answer pending, no answer message',
      { state: 'answer_reappend', ...started },
      view({ state: 'completed', answerPending: true, sourceMode: 'sources' }),
    ],
    [
      'stopped',
      { state: 'stopped', ...started },
      view({ state: 'stopped', sourceMode: 'sources' }),
    ],
    [
      'failed after the start',
      { state: 'failed', ...started },
      view({ state: 'failed', sourceMode: 'sources' }),
    ],
  ];

describe('toLaunchView (Contract Definitions, ResearchLaunchView; KD-8, DC-8)', () => {
  it.each(viewRows)('%s', (_, overrides, expected) => {
    expect(toLaunchView(record(overrides), 'model_knowledge')).toEqual(
      expected,
    );
  });

  it('has no view of a discarded launch', () => {
    expect(() =>
      toLaunchView(record({ state: 'discarded' }), 'sources'),
    ).toThrow('discarded');
  });
});
