import type {
  Comparison,
  TaskStatus,
  TrainingStatus,
} from '@agent-os/contracts';

/** A training's state from its root task's status (design-training.md, «Состояния обучения»). */
export function trainingStatus(root: TaskStatus): TrainingStatus {
  switch (root) {
    case 'completed':
      return 'done';
    case 'failed':
    case 'stopped':
      return root;
    default:
      return 'running';
  }
}

/**
 * Who may train an agent and switch on its training's version (design-training.md, KD-8; pure-decision.md): its
 * author with the right to train own agents; a holder of the right to train any agent when the agent is in the
 * panel — a system agent or one open to at least one role. The admin right takes no part.
 */
export function canTrain(
  rights: { readonly trainOwn: boolean; readonly trainAny: boolean },
  agent: { readonly isAuthor: boolean; readonly inPanel: boolean },
): boolean {
  return (
    (agent.isAuthor && rights.trainOwn) || (agent.inPanel && rights.trainAny)
  );
}

/**
 * The recommendation, computed on read (KD-7): for a `done` training with a proposed version — more wins than
 * losses; otherwise `null`, so a training stopped by hand or at the cap shows none.
 */
export function recommendation(
  status: TrainingStatus,
  hasVersion: boolean,
  comparisons: readonly Comparison[],
): boolean | null {
  if (status !== 'done' || !hasVersion) return null;
  const count = (verdict: Comparison['verdict']) =>
    comparisons.filter((comparison) => comparison.verdict === verdict).length;
  return count('proposed_better') > count('base_better');
}
