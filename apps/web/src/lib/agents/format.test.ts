import { describe, expect, it } from "vitest";
import { testTranslator } from "@/test/intl";
import { failureReasonText, formatRecordModel, providerFailureHint, type ModelNames, type ProviderFailureReason } from "./format";

const models: ModelNames["models"] = [
  { model: "google/gemini-2.5-flash", name: "Gemini 2.5 Flash" },
  { model: "anthropic/claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
];

// AC-06.1, UXRD MP-08 / MC-8: a model reads by its title from the list; a record without its own model
// names the default chat model, or says none is chosen; without a list the label stays as before.
describe("formatRecordModel", () => {
  it.each<[string, string | null, ModelNames | undefined, string]>([
    ["a Claude id without a list", "anthropic/claude-haiku-5-5", undefined, "Haiku"],
    ["an id in the list", "google/gemini-2.5-flash", { models }, "Gemini 2.5 Flash"],
    ["an id outside the list", "local/qwen-3", { models }, "local/qwen-3"],
    ["null without a list", null, undefined, "Модель по умолчанию"],
    ["null with the default model in the list", null, { models, defaultModel: "google/gemini-2.5-flash" }, "Модель по умолчанию · Gemini 2.5 Flash"],
    ["null with no default model chosen", null, { models, defaultModel: null }, "Модель по умолчанию — не выбрана"],
  ])("labels %s", (_case, model, names, expected) => {
    expect(formatRecordModel(testTranslator("formats"), model, names)).toBe(expected);
  });
});

// AC-09.2–AC-09.5, AC-04.2, UXRD MC-9: each provider reason reads its own words, naming the model when it is
// known (event line) and without it (the report has no model).
describe("failureReasonText of a provider reason", () => {
  it.each<[ProviderFailureReason, string, string]>([
    ["provider_missing", "провайдер модели Haiku не настроен", "провайдер модели не настроен"],
    ["provider_disabled", "провайдер модели Haiku выключен", "провайдер модели выключен"],
    ["provider_key_missing", "у провайдера модели Haiku нет ключа", "у провайдера модели нет ключа"],
    ["provider_key_rejected", "провайдер модели Haiku отклонил ключ", "провайдер модели отклонил ключ"],
    ["provider_unavailable", "провайдер модели Haiku не отвечает", "провайдер модели не отвечает"],
    ["provider_tools_rejected", "провайдер модели Haiku не принял описание инструментов", "провайдер модели не принял описание инструментов"],
  ])("%s", (reason, withModel, withoutModel) => {
    expect(failureReasonText(testTranslator("errors"), reason, "Haiku")).toEqual({ text: withModel, hint: null });
    expect(failureReasonText(testTranslator("errors"), reason)).toEqual({ text: withoutModel, hint: null });
  });

  // MC-10: a provider that does not answer asks for a retry; every other reason waits for the administrator.
  it.each<[ProviderFailureReason, string]>([
    ["provider_unavailable", "Напишите, чтобы попробовать снова. Если сбой повторится, сообщите администратору Agent OS."],
    ["provider_key_rejected", "Исправить это может администратор Agent OS. Потом напишите, чтобы продолжить."],
  ])("the hint under %s", (reason, expected) => {
    expect(providerFailureHint(testTranslator("errors"), reason)).toBe(expected);
  });
});
