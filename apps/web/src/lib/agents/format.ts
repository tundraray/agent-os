import { AgentFailureReasonSchema, type AgentFailureReason, type AgentStatus } from "@agent-os/contracts";
import type { FormatsTranslator } from "@/lib/i18n/formats";

/**
 * Display formatters shared by the agent screens, the feed and the tool-call block: one place decides
 * how a status, a model, a duration and a failure reason read (agent-status.md, tool-call.md,
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
 * other id as it is.
 */
export function formatModel(modelId: string, names?: ModelNames): string {
  const named = names?.models.find((row) => row.model === modelId);
  if (named !== undefined) return named.name;
  const family = MODEL_FAMILY.exec(modelId)?.[1];
  if (family === undefined) return modelId;
  return capitalize(family);
}

/** The model a record runs on: `null` is the default chat model, named when `names` knows it. */
export function formatRecordModel(t: FormatsTranslator, modelId: string | null, names?: ModelNames): string {
  if (modelId !== null) return formatModel(modelId, names);
  const defaultModel = names?.defaultModel;
  if (defaultModel === undefined) return t("defaultModel");
  if (defaultModel === null) return t("defaultModelUnset");
  return t("defaultModelNamed", { model: formatModel(defaultModel, names) });
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

/** The workflow brief's three parts in card order, with their labels (MC-9, MC-20). */
export const BRIEF_PARTS = [
  { key: "question", label: "Вопрос" },
  { key: "boundaries", label: "Границы" },
  { key: "result", label: "Результат" },
] as const;
