import { CrashPoints } from './crash-points.js';

const POINT = 'dispatch.after-claim';
const OTHER_POINT = 'relay.before-done';
const PASSES = 5;

/** Passes (1-based) of {@link POINT} on which the injected exit was called, with code 137. */
function exitingPasses(crashAt: string, nodeEnv: string): number[] {
  const exits: number[] = [];
  let pass = 0;
  const crashPoints = new CrashPoints({
    crashAt,
    nodeEnv,
    exit: (code) => {
      expect(code).toBe(137);
      exits.push(pass);
    },
  });
  for (pass = 1; pass <= PASSES; pass++) {
    crashPoints.hit(OTHER_POINT);
    crashPoints.hit(POINT);
  }
  return exits;
}

// Runtime Settings `RUNTIME_CRASH_AT` (`<point>[:n]`, exit 137 on the n-th pass, never under
// NODE_ENV=production). Risk: a test crash point kills the process in production.
describe('CrashPoints — RUNTIME_CRASH_AT parse and production switch', () => {
  it.each([
    {
      name: 'production with a set point never fires',
      crashAt: POINT,
      nodeEnv: 'production',
      passes: [],
    },
    {
      name: '<point> fires on pass 1 only',
      crashAt: POINT,
      nodeEnv: 'test',
      passes: [1],
    },
    {
      name: '<point>:3 fires on pass 3 only',
      crashAt: `${POINT}:3`,
      nodeEnv: 'test',
      passes: [3],
    },
  ])('$name', ({ crashAt, nodeEnv, passes }) => {
    expect(exitingPasses(crashAt, nodeEnv)).toEqual(passes);
  });

  it.each([
    { name: 'an unknown point', crashAt: 'dispatch.after-nothing' },
    { name: 'pass 0', crashAt: `${POINT}:0` },
  ])('rejects $name naming the value', ({ crashAt }) => {
    expect(
      () =>
        new CrashPoints({ crashAt, nodeEnv: 'test', exit: () => undefined }),
    ).toThrow(`RUNTIME_CRASH_AT "${crashAt}"`);
  });
});
