import type { HttpException } from '@nestjs/common';
import type { TrainingErrorCode } from '@agent-os/contracts';
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
  };

/** The answer of a training error code, body `ApiErrorSchema`. */
export function trainingError(code: TrainingErrorCode): HttpException {
  const { status, message } = ANSWERS[code];
  return apiError(status, code, message);
}

/** 409 START_REFUSED of the start (Flow 1): the starter may not use the trainer's model — the same code as a conversation's start. */
export function startRefused(reason: string): HttpException {
  return apiError(409, 'START_REFUSED', 'Start refused', reason);
}
