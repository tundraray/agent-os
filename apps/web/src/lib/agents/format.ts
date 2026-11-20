import { AgentFailureReasonSchema, type AgentFailureReason, type AgentStatus } from "@agent-os/contracts";
import { pluralRu } from "@/lib/i18n/plural-ru";

/**
 * Display formatters shared by the agent screens, the feed and the tool-call block: one place decides
 * how a status, a model, a moment, a duration and a failure reason read (agent-status.md, tool-call.md,
 * UXRD MC-3, MC-8, MC-14, MC-18).
 */

/** MC-3: the label of each agent status. */
export const AGENT_STATUS_LABEL: Record<AgentStatus, string> = {
  working: "Работает",
  awaiting_confirmation: "Ждёт подтверждения",
  interrupted: "Прерван",
  completed: "Завершён",
  failed: "Сбой",
  stopped: "Остановлен",
};

/** The text with its first letter capital: a lowercase phrase that starts a sentence. */
export function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The failure reasons of a model provider (model-providers UXRD MC-9). */
export const PROVIDER_FAILURE_REASONS = [
  "provider_missing",
  "provider_disabled",
  "provider_key_missing",
  "provider_key_rejected",
  "provider_unavailable",
  "provider_tools_rejected",
] as const satisfies readonly AgentFailureReason[];
export type ProviderFailureReason = (typeof PROVIDER_FAILURE_REASONS)[number];

export const isProviderFailureReason = (reason: string | null): reason is ProviderFailureReason =>
  PROVIDER_FAILURE_REASONS.some((known) => known === reason);

/** MC-9 by the reason; `model` is «модели» or «модели {название}». */
const PROVIDER_REASON: Record<ProviderFailureReason, (model: string) => string> = {
  provider_missing: (model) => `провайдер ${model} не настроен`,
  provider_disabled: (model) => `провайдер ${model} выключен`,
  provider_key_missing: (model) => `у провайдера ${model} нет ключа`,
  provider_key_rejected: (model) => `провайдер ${model} отклонил ключ`,
  provider_unavailable: (model) => `провайдер ${model} не отвечает`,
  provider_tools_rejected: (model) => `провайдер ${model} не принял описание инструментов`,
};

/**
 * The one place of the MC-9 words (model-providers design-web.md, KD-7), lowercase as after «Сбой:» and
 * «Причина:»; `model` is the model's label, and without it the same words name no model.
 */
export function providerReasonText(reason: ProviderFailureReason, model?: string): string {
  return PROVIDER_REASON[reason](model === undefined ? "модели" : `модели ${model}`);
}

/** MC-10: the second line under a provider failure — who can fix it, or that a retry may help. */
export function providerFailureHint(reason: ProviderFailureReason): string {
  return reason === "provider_unavailable"
    ? "Напишите, чтобы попробовать снова. Если сбой повторится, сообщите администратору Agent OS."
    : "Исправить это может администратор Agent OS. Потом напишите, чтобы продолжить.";
}

/**
 * Failure reasons MC-14 and MC-18 (and enterprise-access MC-14) name — every reason an agent fails with
 * by itself apart from a provider's, so a new one does not compile without its words; every other one
 * reads «ошибка платформы» (KD-6).
 */
const NAMED_FAILURE_REASON: Record<Exclude<AgentFailureReason, ProviderFailureReason>, string> = {
  turn_limit: "исчерпан предел ходов",
  model_error: "ошибка модели",
  owner_disabled: "сотрудник отключён",
  quota_exhausted: "квота исчерпана",
  model_not_allowed: "модель не разрешена",
  model_not_connected: "модель не подключена",
  no_models_allowed: "не разрешена ни одна модель",
};

/**
 * The words after «Сбой:» (event line) and «Причина:» (report) for a failure reason, and the code to
 * show as the hint when the words do not name it (KD-6). `model` — the label a provider reason names.
 */
export function failureReasonText(reason: string | null, model?: string): { text: string; hint: string | null } {
  const named = AgentFailureReasonSchema.safeParse(reason);
  if (!named.success) return { text: "ошибка платформы", hint: reason };
  if (isProviderFailureReason(named.data)) return { text: providerReasonText(named.data, model), hint: null };
  return { text: NAMED_FAILURE_REASON[named.data], hint: null };
}

const MODEL_FAMILY = /(?:^|\/)claude-([a-z]+)-/;

const DEFAULT_MODEL = "Модель по умолчанию";

/**
 * What a place that already reads the models knows (model-providers design-web.md, KD-6): the models with
 * their titles and the default chat model — its id, `null` while none is chosen, absent when not read.
 */
export type ModelNames = {
  models: readonly { model: string; name: string }[];
  defaultModel?: string | null;
};

/**
 * The one label of a model (KD-6, UXRD MC-8). A model in `names` reads by its title; otherwise
 * `anthropic/claude-haiku-5-5` → «Haiku» (the segment after `claude-`, capitalised, no version) and any
 * other id as it is. `null` is a record on the default chat model, named when `names` knows it.
 */
export function formatModel(modelId: string | null, names?: ModelNames): string {
  if (modelId === null) {
    const defaultModel = names?.defaultModel;
    if (defaultModel === undefined) return DEFAULT_MODEL;
    if (defaultModel === null) return `${DEFAULT_MODEL} — не выбрана`;
    return `${DEFAULT_MODEL} · ${formatModel(defaultModel, names)}`;
  }
  const named = names?.models.find((row) => row.model === modelId);
  if (named !== undefined) return named.name;
  const family = MODEL_FAMILY.exec(modelId)?.[1];
  if (family === undefined) return modelId;
  return capitalize(family);
}

const clock = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" });
const day = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short" });

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

const toDate = (at: string | Date): Date => (typeof at === "string" ? new Date(at) : at);

/** «19 нояб.» — the day of a moment in the viewer's time zone. */
export function formatDay(at: string | Date): string {
  return day.format(toDate(at));
}

/** «19 нояб., 14:32» — day and time, today too. */
export function formatDayTime(at: string | Date): string {
  const date = toDate(at);
  return `${day.format(date)}, ${clock.format(date)}`;
}

/** «ЧЧ:ММ» for today, otherwise «12 нояб., ЧЧ:ММ»; `now` is injectable for a fixed clock. */
export function formatTime(at: string | Date, now: Date = new Date()): string {
  const date = toDate(at);
  return isSameDay(date, now) ? clock.format(date) : formatDayTime(date);
}

/** A duration for MC-18: «<1 с», «42 с», «3 мин 5 с», «2 ч 14 мин». */
export function formatDuration(ms: number): string {
  if (ms < 1000) return "<1 с";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds} с`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rest = seconds % 60;
    return rest === 0 ? `${minutes} мин` : `${minutes} мин ${rest} с`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} ч` : `${hours} ч ${rest} мин`;
}

/** «{N} вызовов инструментов» with «вызов» agreeing with N (MC-18). */
export function formatToolCallCount(count: number): string {
  return `${count} ${pluralRu(count, ["вызов", "вызова", "вызовов"])} инструментов`;
}

/** MC-12: the agent page composer's placeholder by the agent's status. */
export function agentComposerPlaceholder(status: AgentStatus): string {
  switch (status) {
    case "working":
    case "awaiting_confirmation":
      return "Сообщение агенту — получит после текущего шага";
    case "interrupted":
      return "Напишите, что делать дальше";
    case "completed":
    case "failed":
    case "stopped":
      return "Напишите, чтобы продолжить с прежней историей";
  }
}

const INHERITED_HISTORY_TITLE = "История до ответвления";

/** MC-9: the inherited history block; without a count while it is unknown (not read, or the read failed). */
export function inheritedHistoryCaption(count: number | null): string {
  if (count === null) return INHERITED_HISTORY_TITLE;
  return `${INHERITED_HISTORY_TITLE} · ${count} ${pluralRu(count, ["сообщение", "сообщения", "сообщений"])}`;
}

/** The workflow brief's three parts in card order, with their labels (MC-9, MC-20). */
export const BRIEF_PARTS = [
  { key: "question", label: "Вопрос" },
  { key: "boundaries", label: "Границы" },
  { key: "result", label: "Результат" },
] as const;
