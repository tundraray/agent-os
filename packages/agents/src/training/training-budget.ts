import type { Logger } from '@agent-os/common';
import {
  Db,
  RuntimeModelCallsRepository,
  TrainingsRepository,
} from '@agent-os/db';
import { TaskControl, withTxRetry } from '@agent-os/runtime';
import { Inject, Injectable } from '@nestjs/common';

import { AGENTS_LOGGER } from '../agents.tokens';

/**
 * The spending cap of a training tree (self-learning design-training.md KD-5, Flow 3), asked before every model
 * call of the tree. The spend is the token ledger summed over the tree's root, read from the database, so a restart
 * does not reset it; the cap is the one copied into the training row at its start.
 */
@Injectable()
export class TrainingBudget {
  private readonly logger: Logger;

  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(TrainingsRepository)
    private readonly trainings: Pick<
      TrainingsRepository,
      'find' | 'markCapped'
    >,
    @Inject(RuntimeModelCallsRepository)
    private readonly modelCalls: Pick<RuntimeModelCallsRepository, 'sumTree'>,
    @Inject(TaskControl) private readonly tasks: Pick<TaskControl, 'stop'>,
    @Inject(AGENTS_LOGGER) logger: Logger,
  ) {
    this.logger = logger.child({ service: 'agents.training-budget' });
  }

  /**
   * `allowed` below the cap. At the cap one transaction stops the tree from its root as the starter and marks the
   * training row; the mark goes only with the stop that stopped the root, so a tree stopped by hand or by a
   * concurrent check gets none. Either way the answer is `capped` and no call starts.
   */
  async check({
    rootId,
    ownerId,
  }: {
    readonly rootId: string;
    readonly ownerId: string;
  }): Promise<'allowed' | 'capped'> {
    const training = await this.trainings.find(rootId);
    if (training === undefined)
      throw new Error(`Training tree ${rootId} has no training row`);
    const spentUsd = await this.modelCalls.sumTree(rootId);
    if (Number(spentUsd) < Number(training.capUsd)) return 'allowed';
    // The stop writes the root first and goes down the tree (runtime CLAUDE.md, row order); a child's end writes
    // up to the root, so the two can deadlock — `withTxRetry` repeats this transaction after `40P01`.
    const stoppedIds = await withTxRetry(
      {
        db: this.db,
        logger: this.logger,
        operation: 'training.cap',
        taskId: rootId,
      },
      async () => {
        const stopped = await this.tasks.stop(rootId, ownerId);
        // `stop` lists the root first only when this transaction stopped it.
        if (stopped[0] === rootId) await this.trainings.markCapped(rootId);
        return stopped;
      },
    );
    this.logger.info('training cap reached', {
      rootId,
      ownerId,
      spentUsd,
      capUsd: training.capUsd,
      stoppedIds,
      marked: stoppedIds[0] === rootId,
    });
    return 'capped';
  }
}
