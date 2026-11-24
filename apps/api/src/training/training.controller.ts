import {
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { LOGGER, type Logger } from '@agent-os/common';
import type {
  TrainingActivated,
  TrainingStarted,
  TrainingState,
  TrainingView,
} from '@agent-os/contracts';
import { loggedRoute } from '../common/logged-route';
import type { AuthedRequest } from '../identity/auth-user';
import { TrainingService } from './training.service';

/** The training of a deep agent (self-learning design-training.md, «Маршруты обучения»); no `@AdminOnly` (KD-8). */
@Controller('library/:id/training')
export class TrainingController {
  private readonly logger: Logger;

  constructor(
    private readonly training: TrainingService,
    @Inject(LOGGER) logger: Logger,
  ) {
    this.logger = logger.child({ service: 'training.routes' });
  }

  /** `TrainingState`, 200 also without the right (`canTrain: false`); 404 RECORD_NOT_FOUND. */
  @Get()
  state(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<TrainingState> {
    return loggedRoute(this.logger, {
      route: 'GET /library/:id/training',
      fields: { actorId: req.user.id, agentId: id },
      work: () => this.training.state(req.user, id),
      outcomeOf: (state) => ({
        canTrain: state.canTrain,
        runningTrainingId: state.running?.id ?? null,
      }),
    });
  }

  /** 201 `{ trainingId }`; 404, 403 TRAINING_FORBIDDEN, 409 SELF_LEARNING_OFF, TRAINING_RUNNING, TRAINING_NO_PAST_TASKS, START_REFUSED. */
  @Post()
  start(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<TrainingStarted> {
    return loggedRoute(this.logger, {
      route: 'POST /library/:id/training',
      fields: { actorId: req.user.id, agentId: id },
      work: () => this.training.start(req.user, id),
      outcomeOf: (started) => ({ trainingId: started.trainingId }),
    });
  }

  /** `TrainingView`; 404, 403, 404 TRAINING_NOT_FOUND. */
  @Get(':trainingId')
  view(
    @Param('id') id: string,
    @Param('trainingId') trainingId: string,
    @Req() req: AuthedRequest,
  ): Promise<TrainingView> {
    return loggedRoute(this.logger, {
      route: 'GET /library/:id/training/:trainingId',
      fields: { actorId: req.user.id, agentId: id, trainingId },
      work: () => this.training.view(req.user, id, trainingId),
      outcomeOf: (view) => ({
        status: view.status,
        comparisons: view.comparisons.length,
        recommended: view.recommended,
      }),
    });
  }

  /** 200 `{ version, activatedAt }`; 404, 403, 409 TRAINING_NOT_ACTIVATABLE, TRAINING_BASE_CHANGED. */
  @Post(':trainingId/activate')
  @HttpCode(200)
  activate(
    @Param('id') id: string,
    @Param('trainingId') trainingId: string,
    @Req() req: AuthedRequest,
  ): Promise<TrainingActivated> {
    return loggedRoute(this.logger, {
      route: 'POST /library/:id/training/:trainingId/activate',
      fields: { actorId: req.user.id, agentId: id, trainingId },
      work: () => this.training.activate(req.user, id, trainingId),
      outcomeOf: (activated) => ({ version: activated.version }),
    });
  }
}
