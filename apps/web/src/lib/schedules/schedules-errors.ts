import type { ReactNode } from 'react';
import { SchedulesErrorCodeSchema } from '@agent-os/contracts';
import type { ErrorsTranslator } from '@/i18n/catalog';
import { failedText } from '@/i18n/server-text';
import { isApiRequestError } from '@/lib/api/api-request';

/**
 * Texts of the schedules API's refusals and where each one shows (UXRD MC-3, MC-9). Screens keep no refusal
 * texts of their own; the server's own message is marked English for screen readers.
 */

export type SchedulesErrorWhere =
  /** Saving the schedule dialog (MC-3). */
  | { where: 'dialog'; agentName: string | null }
  /** An action on the schedule's page: pause, resume, run, delete (MC-9). */
  | { where: 'action' };

/**
 * `agent` — at the dialog's «Агент» field; `target` — at its «Куда писать ответ» field; `form` — above the
 * dialog's actions; `notice` — a toast.
 */
export type SchedulesErrorText =
  | { place: 'agent' | 'target'; text: string }
  | { place: 'form' | 'notice'; text: ReactNode };

/**
 * A refused schedules request as its place and text. In the dialog, 404 `RECORD_NOT_FOUND` is the agent of the
 * chip the employee no longer may use (AC-01.3) and 404 `THREAD_NOT_FOUND` the reply conversation deleted since
 * the dialog opened; every other refusal reads «Не удалось …: {причина}».
 */
export function describeSchedulesError(
  t: ErrorsTranslator,
  error: unknown,
  context: SchedulesErrorWhere,
): SchedulesErrorText {
  if (context.where === 'action')
    return { place: 'notice', text: failedText(t, 'action', error) };
  if (
    isApiRequestError(error) &&
    error.code === SchedulesErrorCodeSchema.enum.RECORD_NOT_FOUND &&
    context.agentName !== null
  )
    return {
      place: 'agent',
      text: t('agentUnavailable', { name: context.agentName }),
    };
  if (
    isApiRequestError(error) &&
    error.code === SchedulesErrorCodeSchema.enum.THREAD_NOT_FOUND
  )
    return { place: 'target', text: t('schedules.conversationDeleted') };
  return { place: 'form', text: failedText(t, 'save', error) };
}
