import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { KnowledgeItem, KnowledgeView, LastExtraction } from "@agent-os/contracts";
import { testFormatter } from "@/test/intl";
import { knowledgeRow, knowledgeStateLines, knowledgeTabs } from "./knowledge-view";

// Times are UTC; vitest runs in Europe/Berlin (UTC+1 in November), so 23:30Z is the next day there.
const billing: KnowledgeItem = {
  type: "entity", kind: "fact", id: 1, name: "billing-api", description: "Сервис списаний",
  confirmations: 1, date: "2026-11-18T23:30:00Z", state: "active", placement: "always",
};
const team: KnowledgeItem = {
  type: "entity", kind: "fact", id: 2, name: "команда Платежи", description: "Владельцы оплаты",
  confirmations: 4, date: "2026-11-19T10:00:00Z", state: "active", placement: "always",
};
const owns: KnowledgeItem = {
  type: "relation", kind: "fact", id: 1, from: { id: 2, name: "команда Платежи" }, to: { id: 1, name: "billing-api" },
  label: "владеет", confirmations: 4, date: "2026-11-19T10:00:00Z", state: "active", placement: "by_topic",
};
const writes: KnowledgeItem = {
  type: "relation", kind: "fact", id: 2, from: { id: 1, name: "billing-api" }, to: { id: 9, name: "таблица orders" },
  label: "пишет", confirmations: 1, date: "2026-11-03T10:00:00Z", state: "outdated", placement: null,
};
const lesson: KnowledgeItem = {
  type: "relation", kind: "lesson", id: 3, server: "logs", tool: "search", question: "ошибки оплаты",
  hint: "Искать в логах billing-api", outcome: "ошибки нашлись", confirmations: 3, date: "2026-11-19T10:00:00Z",
  state: "lessons_off", placement: null,
};
const nothing: KnowledgeItem = {
  type: "relation", kind: "searched_nothing", id: 4, server: "logs", tool: "search", question: "ошибки payment-gateway",
  confirmations: 2, date: "2026-11-18T10:00:00Z", state: "active", placement: "does_not_fit",
};

// `counts` deliberately disagree with the six items: the lines must read the server's numbers.
const base: KnowledgeView = {
  selfLearning: true,
  lessonsEnabled: true,
  selection: { state: "on" },
  counts: { active: 126, always: 64, beyond: 62, outdated: 7, percent: 180 },
  items: [team, owns, billing, lesson, nothing, writes],
  lastExtraction: null,
};
const view = (over: Partial<KnowledgeView>): KnowledgeView => ({ ...base, ...over });
const offNoModel = { state: "off", reason: "model_not_selected", model: null } as const;
const AUTHOR = { employeeInPanel: false };
const format = testFormatter();

const texts = (v: KnowledgeView, employeeInPanel = false) =>
  knowledgeStateLines(v, { employeeInPanel }, format).map((line) => line.text);
const lineOf = (v: KnowledgeView, key: string) => knowledgeStateLines(v, AUTHOR, format).find((line) => line.key === key);
const lastRun = (over: Partial<LastExtraction>) =>
  lineOf(view({ lastExtraction: { at: "2026-11-19T13:32:00Z", model: "anthropic/claude-haiku-5-5", status: "failed", added: 0, confirmed: 0, outdated: 0, reason: null, ...over } }), "last_run");
const reasonOf = (reason: LastExtraction["reason"]) => lastRun({ status: "skipped", reason })?.reason;
const tabLabels = (v: KnowledgeView) => knowledgeTabs(v).map((tab) => tab.label);

// AC-02.2, AC-03.2, AC-03.4, AC-04.3, AC-06.1, AC-06.2, AC-08.2, AC-11.1, AC-11.5, AC-11.6, AC-15.3, AC-17.1,
// AC-18.3, AC-18.4 (design-web.md UC-5): the screen's words come only from the server's fields — numbers of
// the state lines are `counts` as given, marks follow `state` then `placement`, the fifth tab follows selection.
// Catches: numbers counted from items, the wrong mark or tab with selection or self-learning off, wrong reason words.
describe("knowledge view", () => {
  // A row's day carries the year only outside the current one: the clock stays in the items' year.
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-21T12:00:00Z") });
  });
  afterAll(() => {
    vi.useRealTimers();
  });

  it.each<[string, () => unknown, unknown]>([
    ["line 1, not all fit: N of M from counts", () => texts(base)[0],
      "При любом вопросе запуски получают 64 из 126 записей · знания занимают 180% места"],
    ["line 1, all fit", () => texts(view({ counts: { active: 21, always: 21, beyond: 0, outdated: 0, percent: 40 } })),
      ["Запуски получают все 21 запись · знания занимают 40% места"]],
    ["line 2, selection on", () => lineOf(base, "beyond"),
      { key: "beyond", icon: "info", reason: null,
        text: "Ещё 62 — только по теме вопроса: до половины места запуск отдаёт записям, ближайшим по смыслу к вопросу, остальное — самым подтверждённым, а среди равных — самым новым." }],
    ["line 2, selection off", () => lineOf(view({ selection: offNoModel }), "beyond")?.text,
      "62 не помещаются: первыми выпадают записи, которые подтверждались реже, а среди равных — самые старые."],
    ["line 3", () => lineOf(base, "outdated")?.text, "Ещё 7 устарели — запуски их не получают."],
    ["selection off, model not selected", () => lineOf(view({ selection: offNoModel }), "selection")?.text,
      "Отбор по смыслу выключен: для него не выбрана модель — её выбирает администратор в панели, в разделе «Модели». Пока он выключен, место заполняют самые подтверждённые записи."],
    ["selection off, provider failed",
      () => lineOf(view({ selection: { state: "off", reason: "provider_failed", model: "anthropic/claude-haiku-5-5" } }), "selection")?.text,
      "Отбор по смыслу выключен: модель Haiku не ответила или отказала — проверить её может администратор в панели, в разделе «Модели». Пока он выключен, место заполняют самые подтверждённые записи."],
    ["selection preparing", () => lineOf(view({ selection: { state: "preparing", pending: 12 } }), "selection")?.text,
      "Отбор по смыслу пока работает не для всех записей: 12 ещё готовят к нему, до тех пор они идут в запуски по подтверждениям."],
    ["selection on: no selection line", () => lineOf(base, "selection"), undefined],
    ["lessons off", () => lineOf(view({ lessonsEnabled: false }), "lessons_off")?.text,
      "Уроки сейчас не идут в запуски — их выключил администратор. Факты и «искал — не нашёл» идут как обычно."],
    ["self-learning off: its line replaces 1–2, no lessons or selection line",
      () => knowledgeStateLines(view({ selfLearning: false, lessonsEnabled: false, selection: offNoModel, lastExtraction: { at: "2026-11-19T13:32:00Z", model: "anthropic/claude-haiku-5-5", status: "done", added: 1, confirmed: 0, outdated: 0, reason: null } }), AUTHOR, format).map((line) => line.key),
      ["self_learning_off", "outdated", "last_run"]],
    ["self-learning off, employee's workflow in the panel", () => texts(view({ selfLearning: false }), true)[0],
      "Самообучение выключено: запуски не получают эти знания и не пополняют их. Включить его может автор."],
    ["empty graph: no lines", () => texts(view({ items: [], lastExtraction: { at: "2026-11-19T13:32:00Z", model: "anthropic/claude-haiku-5-5", status: "done", added: 1, confirmed: 0, outdated: 0, reason: null } })), []],
    ["tabs, selection on", () => tabLabels(base),
      ["Все · 6", "Факты · 4", "Уроки · 1", "Искал — не нашёл · 1", "Только по теме · 2"]],
    ["tabs, selection preparing", () => tabLabels(view({ selection: { state: "preparing", pending: 3 } })).at(-1), "Только по теме · 2"],
    ["tabs, selection off", () => tabLabels(view({ selection: offNoModel })).at(-1), "Не помещаются · 2"],
    ["tabs keep the server's order", () => knowledgeTabs(base)[1]?.items, [team, owns, billing, writes]],
    ["tabs, self-learning off: no fifth tab", () => knowledgeTabs(view({ selfLearning: false })).map((tab) => tab.id),
      ["all", "facts", "lessons", "searched_nothing"]],
    ["marks by state, then placement", () => base.items.map((item) => knowledgeRow(item, true, format).mark),
      [null, { text: "только по теме", state: "neutral" }, null, { text: "уроки выключены", state: "off" },
        { text: "не помещается", state: "off" }, { text: "устарела", state: "off" }]],
    ["self-learning off: no placement marks", () => base.items.map((item) => knowledgeRow(item, false, format).mark?.text ?? null),
      [null, null, null, "уроки выключены", null, "устарела"]],
    ["row of an entity: key, kind, cell, day in the viewer's zone", () => knowledgeRow(billing, true, format),
      { key: "entity:1", name: "billing-api", kind: "факт", mark: null, confirmations: 1, date: "19 нояб.",
        cell: { tool: null, title: "billing-api", detail: "Сервис списаний" } }],
    ["cell of a relation fact", () => [knowledgeRow(owns, true, format).key, knowledgeRow(owns, true, format).cell],
      ["relation:1", { tool: null, title: "команда Платежи → владеет → billing-api", detail: null }]],
    ["cell of a lesson", () => [knowledgeRow(lesson, true, format).kind, knowledgeRow(lesson, true, format).cell],
      ["рабочий урок", { tool: "logs.search", title: "ошибки оплаты", detail: "Искать в логах billing-api — ошибки нашлись" }]],
    ["cell of «искал — не нашёл»", () => [knowledgeRow(nothing, true, format).kind, knowledgeRow(nothing, true, format).cell],
      ["искал — не нашёл", { tool: "logs.search", title: "ошибки payment-gateway", detail: "пусто" }]],
    ["line 5, done", () => lastRun({ status: "done", added: 5, confirmed: 3 })?.text,
      "Последний запуск, 19 нояб., 14:32: добавлено 5, подтверждено 3"],
    ["line 5, done with nothing new", () => lastRun({ status: "done" })?.text,
      "Последний запуск, 19 нояб., 14:32: нового не нашлось"],
    ["line 5, skipped", () => lastRun({ status: "skipped", reason: "stopped" }),
      { key: "last_run", icon: null, text: "Последний запуск, 19 нояб., 14:32, ничему не научил:", reason: "запуск остановили" }],
    ["line 5, failed", () => lastRun({ status: "failed", reason: "model_error" })?.reason, "модель Haiku не ответила"],
    ["reason owner_disabled", () => reasonOf("owner_disabled"), "запустивший отключён"],
    ["reason quota_exhausted", () => reasonOf("quota_exhausted"), "у запустившего закончилась квота на модель Haiku"],
    ["reason model_not_connected", () => reasonOf("model_not_connected"), "модель Haiku отключена"],
    ["reason model_not_allowed", () => reasonOf("model_not_allowed"), "у запустившего больше нет доступа к модели Haiku"],
    ["reason no_models_allowed", () => reasonOf("no_models_allowed"), "у запустившего нет доступа ни к одной модели — его выдаёт администратор"],
    ["reason invalid_answer", () => reasonOf("invalid_answer"), "модель Haiku дважды дала ответ, который не удалось разобрать"],
    ["reason interrupted", () => reasonOf("interrupted"), "работа прервалась из-за сбоя на сервере"],
  ])("%s", (_case, actual, expected) => {
    expect(actual()).toEqual(expected);
  });
});
