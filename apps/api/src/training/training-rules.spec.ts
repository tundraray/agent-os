import { canTrain } from './training-rules';

// design-training.md KD-8: who may train an agent and switch on its training's version.
// Catches: an author without the right, or a holder of the right to train any agent on a private agent, let through; the admin right
//   counted as a training right.
describe('canTrain', () => {
  it.each([
    [
      'the author with trainOwn',
      { trainOwn: true, trainAny: false },
      { isAuthor: true, inPanel: false },
      true,
    ],
    [
      'the author without it',
      { trainOwn: false, trainAny: false },
      { isAuthor: true, inPanel: false },
      false,
    ],
    [
      'trainAny on a shared agent',
      { trainOwn: false, trainAny: true },
      { isAuthor: false, inPanel: true },
      true,
    ],
    [
      'trainAny on an unshared private agent',
      { trainOwn: false, trainAny: true },
      { isAuthor: false, inPanel: false },
      false,
    ],
    // The admin right is no input: an admin without either training right is refused even on a shared agent.
    [
      'the admin right alone',
      { trainOwn: false, trainAny: false },
      { isAuthor: false, inPanel: true },
      false,
    ],
  ] as const)('%s', (_, rights, agent, allowed) => {
    expect(canTrain(rights, agent)).toBe(allowed);
  });
});
