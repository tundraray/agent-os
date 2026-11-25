import type { TestRunTest, TestVerdict } from '@agent-os/contracts';

import { testRunMove } from './test-run-step';

/** One test with a verdict per round; `null` — the round's run started, not judged yet. */
function test(...verdicts: (TestVerdict | null)[]): TestRunTest {
  return {
    task: 'task',
    expected: 'expected',
    rounds: verdicts.map((verdict) => ({ runId: null, verdict, reason: null })),
  };
}

const state = {
  takenAgentId: null,
  agentId: 'agent',
  tests: [test('passed')],
  versions: 1,
  fixClosed: false,
  summaryClosed: false,
};

// design-trainer-dialog.md, «Фазы и передача хода», hand-over rules 1–6 in their order.
// Catches: a model step after «взять»; a round before the agent; a second round started while one is unjudged; the
//   automatic fix skipped or repeated; a requested round not started or not marked as asked for.
describe('testRunMove', () => {
  it.each([
    ['taken -> the code ends', { takenAgentId: 'agent' }, { kind: 'taken' }],
    ['no agent -> the model', { agentId: null, tests: [] }, { kind: 'model' }],
    [
      'a test of round 1 unjudged -> round 1',
      { tests: [test('passed'), test(null)] },
      { kind: 'round', round: 1, requested: false },
    ],
    [
      'round 1 failed, no version, the fix open -> the model',
      { tests: [test('passed'), test('failed')] },
      { kind: 'model' },
    ],
    [
      'a version and a test of round 2 without its run -> round 2',
      { tests: [test('failed')], versions: 2 },
      { kind: 'round', round: 2, requested: false },
    ],
    [
      'the fix closed without a version -> nothing to fix',
      { tests: [test('failed')], fixClosed: true },
      { kind: 'nothing_to_fix' },
    ],
    [
      'both rounds judged -> the model',
      {
        tests: [test('failed', 'passed')],
        versions: 2,
        fixClosed: true,
        summaryClosed: true,
      },
      { kind: 'model' },
    ],
    [
      'a third version after the summary -> requested round 3',
      {
        tests: [test('failed', 'failed')],
        versions: 3,
        fixClosed: true,
        summaryClosed: true,
      },
      { kind: 'round', round: 3, requested: true },
    ],
  ] as const)('%s', (_, change, move) => {
    expect(testRunMove({ ...state, ...change })).toEqual(move);
  });
});
