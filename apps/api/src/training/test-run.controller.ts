import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { LOGGER, type Logger } from '@agent-os/common';
import {
  ActivateTestRunBodySchema,
  type ActivateTestRunBody,
  StartTestRunBodySchema,
  type StartTestRunBody,
  type TestRunStarted,
  type TestRunTaken,
  type TestRunView,
  type TrainingActivated,
} from '@agent-os/contracts';
import { chatRoute } from '../chat/chat.errors';
import { loggedRoute } from '../common/logged-route';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import type { AuthedRequest } from '../identity/auth-user';
import { TestRunService } from './test-run.service';

/** The test runs of a new agent (design-test-run.md, «Маршруты прогона»); no `@AdminOnly` (KD-6). */
@Controller('test-runs')
export class TestRunController {
  private readonly logger: Logger;

  constructor(
    private readonly testRuns: TestRunService,
    @Inject(LOGGER) logger: Logger,
  ) {
    this.logger = logger.child({ service: 'test_run.routes' });
  }

  /** 201 `{ testRunId }`; 400, 403 TRAINING_FORBIDDEN, 404 THREAD_NOT_FOUND, 409 TEST_RUN_RUNNING, FORK_REFUSED, START_REFUSED. */
  @Post()
  start(
    @Body(new ZodValidationPipe(StartTestRunBodySchema))
    body: StartTestRunBody,
    @Req() req: AuthedRequest,
  ): Promise<TestRunStarted> {
    return loggedRoute(this.logger, {
      route: 'POST /test-runs',
      fields: {
        actorId: req.user.id,
        descriptionChars: body.description.length,
        originThreadId: body.originThreadId ?? null,
      },
      work: () => this.testRuns.start(req.user, body),
      outcomeOf: (started) => ({ testRunId: started.testRunId }),
    });
  }

  /**
   * 200 `TestRunTaken`; 404 TRAINING_NOT_FOUND, RECORD_NOT_FOUND, 409 TEST_RUN_NO_OFFER. The body is not read; a
   * refused start of the new conversation is 409 START_REFUSED.
   */
  @Post(':testRunId/take')
  @HttpCode(200)
  take(
    @Param('testRunId') testRunId: string,
    @Req() req: AuthedRequest,
  ): Promise<TestRunTaken> {
    return loggedRoute(
      this.logger,
      {
        route: 'POST /test-runs/:testRunId/take',
        fields: { actorId: req.user.id, testRunId },
        work: () => this.testRuns.take(req.user, testRunId),
        outcomeOf: (taken) => ({
          agentId: taken.record.id,
          threadId: taken.threadId,
        }),
      },
      chatRoute(),
    );
  }

  /** `TestRunView`; 404 TRAINING_NOT_FOUND. */
  @Get(':testRunId')
  view(
    @Param('testRunId') testRunId: string,
    @Req() req: AuthedRequest,
  ): Promise<TestRunView> {
    return loggedRoute(this.logger, {
      route: 'GET /test-runs/:testRunId',
      fields: { actorId: req.user.id, testRunId },
      work: () => this.testRuns.view(req.user, testRunId),
      outcomeOf: (view) => ({
        status: view.status,
        agentId: view.agent?.id ?? null,
        tests: view.tests.length,
      }),
    });
  }

  /** 200 `{ version, activatedAt }`; 404, 403, 409 TRAINING_NOT_ACTIVATABLE, TRAINING_BASE_CHANGED. */
  @Post(':testRunId/activate')
  @HttpCode(200)
  activate(
    @Param('testRunId') testRunId: string,
    @Body(new ZodValidationPipe(ActivateTestRunBodySchema))
    body: ActivateTestRunBody,
    @Req() req: AuthedRequest,
  ): Promise<TrainingActivated> {
    return loggedRoute(this.logger, {
      route: 'POST /test-runs/:testRunId/activate',
      fields: { actorId: req.user.id, testRunId, version: body.version },
      work: () => this.testRuns.activate(req.user, testRunId, body.version),
      outcomeOf: (activated) => ({ version: activated.version }),
    });
  }
}
