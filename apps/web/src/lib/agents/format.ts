import { AgentFailureReasonSchema, type AgentFailureReason } from "@agent-os/contracts";
import type { ErrorsTranslator, FormatsTranslator } from "@/lib/i18n/messages";

/**
 * Display formatters shared by the agent screens, the feed and the tool-call block: one place decides
 * how a model, a duration and a failure reason read (agent-status.md, tool-call.md, UXRD MC-8, MC-14, MC-18).
 * Status labels (MC-3) and the composer placeholder (MC-12) are the `agents` messages.
 */

/** The model family of `formatModel` with its first letter capital: a name, not a phrase. */
function capitalize(text: string): string {
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

/**
 * The MC-9 words of a provider reason (model-providers design-web.md, KD-7), lowercase as after «Сбой:» and
 * «Причина:»; `model` is the model's label, and without it the words name no model.
 */
export function providerFailureText(t: ErrorsTranslator, reason: ProviderFailureReason, model?: string): string {
  return model === undefined ? t(`providerReason.unnamed.${reason}`) : t(`providerReason.named.${reason}`, { model });
}

/** MC-10: the second line under a provider failure — who can fix it, or that a retry may help. */
export function providerFailureHint(t: ErrorsTranslator, reason: ProviderFailureReason): string {
  return t(reason === "provider_unavailable" ? "providerHint.retry" : "providerHint.admin");
}

/**
 * The words after «Сбой:» (event line) and «Причина:» (report) for a failure reason, and the code to show as
 * the hint when the words do not name it (KD-6): every reason an agent fails with by itself has its message,
 * so a new one does not compile without it; any other reads «ошибка платформы». `model` — the label a
 * provider reason names.
 */
export function failureReasonText(
  t: ErrorsTranslator,
  reason: string | null,
  model?: string,
): { text: string; hint: string | null } {
  const named = AgentFailureReasonSchema.safeParse(reason);
  if (!named.success) return { text: t("platformFailure"), hint: reason };
  if (isProviderFailureReason(named.data)) return { text: providerFailureText(t, named.data, model), hint: null };
  return { text: t(`failureReason.${named.data}`), hint: null };
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

/** The deep agent brief's three parts in card order (MC-9, MC-20); each reads `agents.brief.{part}`. */
export const BRIEF_PARTS = ["question", "boundaries", "result"] as const;
