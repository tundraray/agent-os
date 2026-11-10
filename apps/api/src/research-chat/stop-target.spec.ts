import type { LaunchState } from './launch-state.js';
import { stopTarget, type StopTarget } from './stop-target.js';

/** A launch of the caller's thread as the choice reads it. */
function launch(launchKey: string, state: LaunchState) {
  return { launchKey, state };
}

const RUNNING_A = launch('a', 'running');
const PENDING_B = launch('b', 'answer_pending');
const ANSWERED = launch('answered', 'answered');
const LAUNCHING = launch('launching', 'launching');
const PROPOSED = launch('proposed', 'proposed');
const DISCARDED = launch('discarded', 'discarded');

// «Какой ресерч останавливает агент» (design-lifecycle.md, KD-4, DC-10): a named key is the launch of the caller's
// thread in any state, or `not_found`; without a key only a launch in `running` or `answer_pending` counts, and the
// choice stops it only when it is the one such launch. The rows are the thread's launches, as the service lists them.
describe('stopTarget (KD-4, DC-10)', () => {
  it.each<
    [
      string,
      ReturnType<typeof launch>[],
      string | undefined,
      StopTarget<ReturnType<typeof launch>>,
    ]
  >([
    [
      'the named key of one of two running launches',
      [RUNNING_A, PENDING_B],
      'b',
      { kind: 'stop', launch: PENDING_B },
    ],
    [
      'the named key of a settled launch (the stop returns it as it is)',
      [ANSWERED, RUNNING_A],
      'answered',
      { kind: 'stop', launch: ANSWERED },
    ],
    [
      'a key not in this thread (another thread, another owner, unknown)',
      [RUNNING_A],
      'foreign',
      { kind: 'not_found' },
    ],
    [
      'the named key of a discarded launch',
      [DISCARDED, RUNNING_A],
      'discarded',
      { kind: 'not_found' },
    ],
    [
      'no key in a thread without launches',
      [],
      undefined,
      { kind: 'nothing_to_stop' },
    ],
    [
      'no key and no launch running (settled, proposed, still launching)',
      [ANSWERED, PROPOSED, LAUNCHING],
      undefined,
      { kind: 'nothing_to_stop' },
    ],
    [
      'no key and one running launch among settled ones',
      [ANSWERED, RUNNING_A, LAUNCHING],
      undefined,
      { kind: 'stop', launch: RUNNING_A },
    ],
    [
      'no key and one launch whose answer is pending',
      [PROPOSED, PENDING_B],
      undefined,
      { kind: 'stop', launch: PENDING_B },
    ],
    [
      'no key and two running launches',
      [RUNNING_A, ANSWERED, PENDING_B],
      undefined,
      { kind: 'ambiguous', running: [RUNNING_A, PENDING_B] },
    ],
  ])('%s', (_case, launches, launchKey, expected) => {
    expect(stopTarget(launches, launchKey)).toEqual(expected);
  });
});
