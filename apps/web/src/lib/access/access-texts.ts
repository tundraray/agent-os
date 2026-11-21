import type { MyModel, MyModels, ToolRefusalReason } from '@agent-os/contracts';
import {
  failureReasonText,
  formatModel,
  isProviderFailureReason,
  PROVIDER_FAILURE_REASONS,
} from '@/lib/agents/format';
import { formatMonth, formatQuota, utcMonthOf, type Formatter } from '@/lib/i18n/formats';
import { CATALOGUE, hasMessage, type ErrorsTranslator } from '@/lib/i18n/messages';

/**
 * Texts of the access refusals and failures (enterprise-access UXRD, MC-10, MC-11, MC-14, MC-17): one
 * message for each, picked by the reason. Model IDs read as `formatModel` gives them, the quota line names
 * the model by its catalogue name.
 */

/**
 * MC-10 and MC-22: the refusal line of a tool-call block; `model` is the refused model, absent when the child
 * runs on its definition's or the default model (plan Notes 10). `null` — a reason without a message here.
 */
export function refusalText(t: ErrorsTranslator, reason: ToolRefusalReason, model: string | null): string | null {
  if (model !== null && hasMessage(CATALOGUE.errors.refusalWithModel, reason)) {
    return t(`refusalWithModel.${reason}`, { model: formatModel(model) });
  }
  return hasMessage(CATALOGUE.errors.refusal, reason) ? t(`refusal.${reason}`) : null;
}

/** Failure reasons of the conversation's root that read as the reply error block TH-08. */
export const CHAT_FAILURE_REASONS = [
  'model_error',
  'model_not_allowed',
  'model_not_connected',
  'no_models_allowed',
  ...PROVIDER_FAILURE_REASONS,
] as const;
export type ChatFailureReason = (typeof CHAT_FAILURE_REASONS)[number];

export const isChatFailureReason = (reason: string | null): reason is ChatFailureReason =>
  CHAT_FAILURE_REASONS.some((known) => known === reason);

/**
 * MC-11 by the reason, «Не удалось получить ответ.» for a model error (chat-shell TH-08) and for any
 * other error of a reply; `model` is the root's model ID, null only while the conversation has no root.
 * A provider reason names the model by its ID label (model-providers design-web.md, «Отличия от UXRD»).
 */
export function replyFailureText(t: ErrorsTranslator, reason: string | null, model: string | null): string {
  if (reason === 'no_models_allowed') return t('noModelsAllowed');
  if (isProviderFailureReason(reason)) {
    return model === null
      ? t(`replyFailure.provider.unnamed.${reason}`)
      : t(`replyFailure.provider.named.${reason}`, { model: formatModel(model) });
  }
  if (model === null) return t('replyFailed');
  if (reason === 'model_not_allowed' || reason === 'model_not_connected') {
    return t(`replyFailure.${reason}`, { model: formatModel(model) });
  }
  return t('replyFailed');
}

/**
 * The row whose amounts a quota failure at `at` shows: the event's model, while the answer is for the
 * event's UTC month and the quota is still spent. Otherwise the amounts would not be the ones the agent
 * hit, and the line reads without them.
 */
export function quotaRowOf(models: MyModels, model: string, at: string): MyModel | null {
  if (models.month !== utcMonthOf(new Date(at))) return null;
  return models.models.find((row) => row.model === model && row.exhausted) ?? null;
}

/** QS-01 (MC-14) without the time, which the event line adds; without a row or a quota — «Сбой: квота исчерпана». */
export function quotaFailureText(t: ErrorsTranslator, format: Formatter, row: MyModel | null, month: string): string {
  if (row === null || row.quotaUsd === null) {
    return t('failedEvent', { reason: failureReasonText(t, 'quota_exhausted').text });
  }
  return t('quota.failure', {
    model: row.name,
    spent: format.number(row.spentUsd, 'usd'),
    quota: formatQuota(format, row.quotaUsd),
    month: formatMonth(format, month),
  });
}

/** MC-17: the polite announcement of a QS-01 line. */
export function quotaFailureAnnouncement(t: ErrorsTranslator, row: MyModel | null): string {
  return row === null ? t('quota.announcement') : t('quota.announcementNamed', { model: row.name });
}
