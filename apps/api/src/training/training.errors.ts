import { STATUS_CODES } from 'node:http';
import { HttpException } from '@nestjs/common';
import type {
  TestRunRunningError,
  TrainingErrorCode,
} from '@agent-os/contracts';
import { apiError } from '../common/api-error';

/** HTTP status and constant message of each training error code (design-training.md, «Маршруты обучения»). */
const ANSWERS: Record<TrainingErrorCode, { status: number; message: string }> =
  {
    TRAINING_FORBIDDEN: {
      status: 403,
      message: 'Training this agent is not open to you',
    },
    SELF_LEARNING_OFF: { status: 409, message: 'Self-learning is off' },
    TRAINING_RUNNING: { status: 409, message: 'A training is running' },
    TRAINING_NO_PAST_TASKS: {
      status: 409,
      message: 'No past tasks to compare',
    },
    TRAINING_NOT_FOUND: { status: 404, message: 'Training not found' },
    TRAINING_NOT_ACTIVATABLE: {
      status: 409,
      message: 'The training has no version to activate',
    },
    TRAINING_BASE_CHANGED: {
      status: 409,
      message: 'The active version changed after the training started',
    },
    TEST_RUN_RUNNING: { status: 409, message: 'A test run is running' },
    TEST_RUN_NO_OFFER: {
      status: 409,
      message: 'The test run has no agent to take',
    },
    TEST_RUN_NOT_ACCEPTING: {
      status: 409,
      message: 'The test run takes no message now',
    },
  };

/** The answer of a training error code, body `ApiErrorSchema`; `reason` where the code names one. */
export function trainingError(
  code: TrainingErrorCode,
  reason?: string,
): HttpException {
  const { status, message } = ANSWERS[code];
  return apiError(status, code, message, reason);
}

/** 409 TEST_RUN_RUNNING with the running test run's id and its conversation's title (design-trainer-dialog.md, KD-8). */
export function testRunRunning(
  testRunId: string,
  testRunTitle: string,
): HttpException {
  const { status, message } = ANSWERS.TEST_RUN_RUNNING;
  const body = {
    statusCode: status,
    error: STATUS_CODES[status],
    errorCode: 'TEST_RUN_RUNNING',
    message,
    testRunId,
    testRunTitle,
  } satisfies TestRunRunningError;
  return new HttpException(body, status);
}

/** 409 START_REFUSED of the start (Flow 1): the starter may not use the trainer's model — the same code as a conversation's start. */
export function startRefused(reason: string): HttpException {
  return apiError(409, 'START_REFUSED', 'Start refused', reason);
}
