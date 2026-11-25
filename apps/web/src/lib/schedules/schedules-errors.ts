import { createElement, type ReactNode } from 'react';
import { SchedulesErrorCodeSchema } from '@agent-os/contracts';
import type { SchedulesTranslator } from '@/i18n/catalog';
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

/** `agent` — at the dialog's «Агент» field; `form` — above the dialog's actions; `notice` — a toast. */
export type SchedulesErrorText =
  | { place: 'agent'; text: string }
  | { place: 'form' | 'notice'; text: ReactNode };

const serverText = (chunks: ReactNode): ReactNode =>
  createElement('span', { lang: 'en' }, chunks);

/** «Не удалось сохранить: {причина}» or «Не удалось: {причина}», or their «нет связи с сервером». */
function failed(
  t: SchedulesTranslator,
  error: unknown,
  action: 'save' | 'action',
): ReactNode {
  if (isApiRequestError(error) && error.kind === 'network')
    return t(action === 'save' ? 'errors.saveOffline' : 'errors.actionOffline');
  const text = error instanceof Error ? error.message : String(error);
  return t.rich(action === 'save' ? 'errors.save' : 'errors.action', {
    text,
    server: serverText,
  });
}

/**
 * A refused schedules request as its place and text. In the dialog, 404 `RECORD_NOT_FOUND` is the agent of the
 * chip the employee no longer may use (AC-01.3); every other refusal reads «Не удалось …: {причина}».
 */
export function describeSchedulesError(
  t: SchedulesTranslator,
  error: unknown,
  context: SchedulesErrorWhere,
): SchedulesErrorText {
  if (context.where === 'action')
    return { place: 'notice', text: failed(t, error, 'action') };
  if (
    isApiRequestError(error) &&
    error.code === SchedulesErrorCodeSchema.enum.RECORD_NOT_FOUND &&
    context.agentName !== null
  )
    return {
      place: 'agent',
      text: t('errors.agentUnavailable', { name: context.agentName }),
    };
  return { place: 'form', text: failed(t, error, 'save') };
}
