import type { ReactNode } from 'react';
import { LibraryErrorCode } from '@agent-os/contracts';
import type { ErrorsTranslator } from '@/i18n/catalog';
import { failedText, type FailedAction } from '@/i18n/server-text';
import { isApiRequestError } from '@/lib/api/api-request';

/**
 * Texts of the tracker API's refusals and where each one shows (task-tracker UXRD MC-5, MC-7, MC-9, MC-11).
 * Screens keep no refusal texts of their own; the server's own message is marked English for screen readers.
 */

export type TrackerErrorWhere =
  /** «Новая задача» (MC-5), under the field. */
  | { where: 'create' }
  /** The status of the task's header (MC-7), a toast. */
  | { where: 'status' }
  /** The title or the description (MC-7), a toast. */
  | { where: 'save' }
  /** The comment field (MC-9), under the field. */
  | { where: 'comment' }
  /** Deleting the task (MC-13), in its confirmation. */
  | { where: 'delete' }
  /** The delegate dialog (MC-11); `agentName` — the chosen agent, `null` for the chat agent. */
  | { where: 'delegate'; agentName: string | null };

/** `agent` — at the dialog's «Агент» field; `text` — wherever the context shows a refusal. */
export type TrackerErrorText =
  { place: 'agent'; text: string } | { place: 'text'; text: ReactNode };

const ACTION: Record<TrackerErrorWhere['where'], FailedAction> = {
  create: 'create_task',
  status: 'status',
  save: 'save',
  comment: 'send',
  delete: 'delete',
  delegate: 'delegate',
};

/**
 * A refused tracker request as its place and text. In the dialog, 404 `RECORD_NOT_FOUND` is an agent the employee
 * no longer may start (AC-04.4); every other refusal reads «Не удалось …: {причина}».
 */
export function describeTrackerError(
  t: ErrorsTranslator,
  error: unknown,
  context: TrackerErrorWhere,
): TrackerErrorText {
  if (
    context.where === 'delegate' &&
    context.agentName !== null &&
    isApiRequestError(error) &&
    error.code === LibraryErrorCode.RECORD_NOT_FOUND
  )
    return {
      place: 'agent',
      text: t('agentUnavailable', { name: context.agentName }),
    };
  return { place: 'text', text: failedText(t, ACTION[context.where], error) };
}
