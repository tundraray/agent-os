import type { MyModel, MyModels, ToolRefusalReason } from '@agent-os/contracts';
import {
  capitalize,
  failureReasonText,
  formatModel,
  isProviderFailureReason,
  PROVIDER_FAILURE_REASONS,
  providerReasonText,
} from '@/lib/agents/format';
import { formatMonth, utcMonthOf, type Formatter } from '@/lib/i18n/formats';

/**
 * Texts of the access refusals and failures (enterprise-access UXRD, MC-10, MC-11, MC-14, MC-17): one
 * place for each, picked by the reason. Model IDs read as `formatModel` gives them, the quota line names
 * the model by its catalogue name.
 */

const ASK_ADMIN = 'Обратитесь к администратору Agent OS.';

/** MC-9 and MC-11: the employee is allowed no model — the empty «Модели и расход» and the reply error. */
export const NO_MODELS_ALLOWED = `Вам не разрешена ни одна модель. ${ASK_ADMIN}`;

/**
 * MC-10: the refusal line of a tool-call block; `model` is the `model` argument of `start_agent`, absent
 * when the child runs on its definition's or the default model (plan Notes 10). `null` — a reason MC-22 names.
 */
export function refusalText(reason: ToolRefusalReason, model: string | null): string | null {
  const named = model === null ? '' : `: ${formatModel(model)}`;
  switch (reason) {
    case 'no_access':
      return 'Нет доступа к инструменту';
    case 'model_not_allowed':
      return `Модель не разрешена${named}`;
    case 'model_not_connected':
      return `Модель не подключена${named}`;
    default:
      return null;
  }
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

const REPLY_FAILED = 'Не удалось получить ответ.';

/**
 * MC-11 by the reason, «Не удалось получить ответ.» for a model error (chat-shell TH-08) and for any
 * other error of a reply; `model` is the root's model ID, null only while the conversation has no root.
 * A provider reason names the model by its ID label (model-providers design-web.md, «Отличия от UXRD»).
 */
export function chatFailureText(reason: string | null, model: string | null): string {
  if (reason === 'no_models_allowed') return NO_MODELS_ALLOWED;
  if (isProviderFailureReason(reason)) {
    const text = capitalize(providerReasonText(reason, model === null ? undefined : formatModel(model)));
    return reason === 'provider_unavailable' ? `${text}. Попробуйте перегенерировать позже.` : `${text}. ${ASK_ADMIN}`;
  }
  if (model === null) return REPLY_FAILED;
  if (reason === 'model_not_allowed') return `Модель ${formatModel(model)} вам не разрешена. ${ASK_ADMIN}`;
  if (reason === 'model_not_connected') return `Модель ${formatModel(model)} не подключена. ${ASK_ADMIN}`;
  return REPLY_FAILED;
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
export function quotaFailureText(format: Formatter, row: MyModel | null, month: string): string {
  if (row === null || row.quotaUsd === null) return `Сбой: ${failureReasonText('quota_exhausted').text}`;
  const spent = format.number(row.spentUsd, 'usd');
  const quota = format.number(row.quotaUsd, 'usdQuota');
  return `Сбой: квота ${row.name} исчерпана — ${spent} из ${quota} за ${formatMonth(format, month)}`;
}

/** The second line of QS-01. */
export const QUOTA_FAILURE_HINT = 'Напишите, чтобы продолжить, когда квоту поднимут или начнётся новый месяц.';

/** MC-17: the polite announcement of a QS-01 line. */
export function quotaFailureAnnouncement(row: MyModel | null): string {
  return row === null ? 'Работа завершена сбоем: исчерпана квота' : `Работа завершена сбоем: исчерпана квота ${row.name}`;
}
