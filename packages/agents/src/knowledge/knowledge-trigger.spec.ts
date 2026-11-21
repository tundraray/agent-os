import {
  type TriggerDecision,
  triggerDecision,
  type TriggerEmbedding,
  type TriggerRun,
} from './knowledge-trigger';

// KD-3, KD-8, Invariants 1, 2, 13; AC-01.1, AC-03.2, AC-03.3, DC-3, DC-4 (design-core.md): one
// extraction per run end, never after a stop; a failed extraction or pass never keeps its id.
const COORDINATOR = '00000000-0000-4000-8000-000000000001';
const EXTRACTION = '00000000-0000-4000-8000-000000000002';
const PASS = '00000000-0000-4000-8000-000000000003';
const OTHER_TASK = '00000000-0000-4000-8000-000000000004';
const RECORD = '00000000-0000-4000-8000-000000000005';

function run(patch: Partial<TriggerRun> = {}): TriggerRun {
  return {
    runId: COORDINATOR,
    extractTaskId: null,
    lastExtractTaskId: null,
    needsRound: false,
    ...patch,
  };
}

function embedding(patch: Partial<TriggerEmbedding> = {}): TriggerEmbedding {
  return { recordId: RECORD, passTaskId: null, needsPass: false, ...patch };
}

const IDLE = run();
const EXTRACTING = run({ extractTaskId: EXTRACTION });
const EXTRACTING_MARKED = run({ extractTaskId: EXTRACTION, needsRound: true });
const EXTRACTED = run({ lastExtractTaskId: EXTRACTION });
const NO_PASS = embedding();
const PASSING = embedding({ passTaskId: PASS });
const PASSING_MARKED = embedding({ passTaskId: PASS, needsPass: true });

interface Row {
  readonly name: string;
  readonly type: 'task.completed' | 'task.failed' | 'task.stopped';
  readonly taskId: string;
  readonly run?: TriggerRun;
  readonly embedding?: TriggerEmbedding;
  readonly expected: TriggerDecision;
}

const ROWS: Row[] = [
  {
    name: 'coordinator completed, no extraction in progress: create one',
    type: 'task.completed',
    taskId: COORDINATOR,
    run: IDLE,
    expected: { action: 'create_extract', run: IDLE },
  },
  {
    name: 'coordinator failed while a round runs: only the «one more round» mark',
    type: 'task.failed',
    taskId: COORDINATOR,
    run: EXTRACTING,
    expected: { action: 'mark_round', run: EXTRACTING },
  },
  {
    name: 'coordinator stopped: «stopped», no task even while a round runs',
    type: 'task.stopped',
    taskId: COORDINATOR,
    run: EXTRACTING,
    expected: { action: 'stopped', run: EXTRACTING },
  },
  {
    name: 'extraction failed without the mark: interrupted, no new task',
    type: 'task.failed',
    taskId: EXTRACTION,
    run: EXTRACTING,
    expected: { action: 'interrupted', run: EXTRACTING, nextRound: false },
  },
  {
    name: 'extraction failed with the mark: interrupted and a new task',
    type: 'task.failed',
    taskId: EXTRACTION,
    run: EXTRACTING_MARKED,
    expected: { action: 'interrupted', run: EXTRACTING_MARKED, nextRound: true },
  },
  {
    name: 'extraction completed, no pass in progress: queue a pass',
    type: 'task.completed',
    taskId: EXTRACTION,
    run: EXTRACTED,
    embedding: NO_PASS,
    expected: { action: 'queue_embed', run: EXTRACTED },
  },
  {
    name: 'extraction completed while a pass runs: only the «one more pass» mark',
    type: 'task.completed',
    taskId: EXTRACTION,
    run: EXTRACTED,
    embedding: PASSING,
    expected: { action: 'mark_pass', run: EXTRACTED },
  },
  {
    name: 'extraction completed after its workflow record was deleted: ignore',
    type: 'task.completed',
    taskId: EXTRACTION,
    run: EXTRACTED,
    expected: { action: 'ignore', reason: 'record_deleted' },
  },
  {
    name: 'pass failed with the mark: id released and a new pass',
    type: 'task.failed',
    taskId: PASS,
    embedding: PASSING_MARKED,
    expected: { action: 'release_pass', embedding: PASSING_MARKED, nextPass: true },
  },
  {
    name: 'a task no knowledge row names (or the run row went with its conversation): ignore',
    type: 'task.completed',
    taskId: OTHER_TASK,
    expected: { action: 'ignore', reason: 'not_learning' },
  },
];

describe('triggerDecision: one extraction per run end, none after a stop', () => {
  it.each(ROWS)('$name', (row) => {
    expect(triggerDecision({ type: row.type, taskId: row.taskId }, row.run, row.embedding)).toEqual(
      row.expected,
    );
  });
});
