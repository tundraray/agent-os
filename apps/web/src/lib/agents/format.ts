import type { AgentStatus } from "@agent-os/contracts";
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

/** Failure reasons MC-14 and MC-18 name; every other one reads «ошибка платформы» (KD-6). */
const NAMED_FAILURE_REASON: Record<string, string> = {
  turn_limit: "исчерпан предел ходов",
  model_error: "ошибка модели",
};

/**
 * The words after «Сбой:» (event line) and «Причина:» (report) for a failure reason, and the code to
 * show as the hint when the words do not name it (KD-6).
 */
export function failureReasonText(reason: string | null): { text: string; hint: string | null } {
  const named = reason === null ? undefined : NAMED_FAILURE_REASON[reason];
  if (named !== undefined) return { text: named, hint: null };
  return { text: "ошибка платформы", hint: reason };
}

const MODEL_FAMILY = /(?:^|\/)claude-([a-z]+)-/;

/**
 * `anthropic/claude-haiku-5-5` → «Haiku»: the segment after `claude-` up to the next hyphen, capitalised;
 * the version is never shown. Any other id reads as it is.
 */
export function formatModel(modelId: string): string {
  const family = MODEL_FAMILY.exec(modelId)?.[1];
  if (family === undefined) return modelId;
  return family.charAt(0).toUpperCase() + family.slice(1);
}

const clock = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" });
const day = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short" });

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** «ЧЧ:ММ» for today, otherwise «12 нояб., ЧЧ:ММ»; `now` is injectable for a fixed clock. */
export function formatTime(at: string | Date, now: Date = new Date()): string {
  const date = typeof at === "string" ? new Date(at) : at;
  const time = clock.format(date);
  return isSameDay(date, now) ? time : `${day.format(date)}, ${time}`;
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
