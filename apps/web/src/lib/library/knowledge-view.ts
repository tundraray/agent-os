import type {
  KnowledgeItem,
  KnowledgeSelection,
  KnowledgeView,
  LastExtraction,
  LastExtractionReason,
} from "@agent-os/contracts";
import { formatDay, formatDayTime, formatModel } from "@/lib/agents/format";
import { pluralRu } from "@/lib/i18n/plural-ru";

/**
 * The one place where the knowledge screen's server answer becomes its words (self-learning design-web.md,
 * «Как экран выбирает, что показать»; UXRD KN-01, MC-2 – MC-6): state lines, tabs, row marks, the «Запись»
 * cell and the delete texts. Every number of a state line is a `counts` field as the server gives it and every
 * mark follows the record's `state` and `placement`; the only counting here is the rows of a tab and the
 * relations that leave with an entity (KD-5). Nothing here sorts: rows keep the server's order.
 */

/** Characters of a record's text in the row menu and the delete dialog before «…» (KD-4). */
const ITEM_TEXT_MAX = 60;

/** MC-6: the end of every delete dialog's text. */
const FOREVER = "Вернуть нельзя — workflow может узнать это снова.";
const LEAVES_ONE = `Следующие шаги запусков её уже не получат. ${FOREVER}`;

/** Texts of the screen outside the per-record functions (MC-2, MC-4 – MC-7). */
export const KNOWLEDGE_TEXT = {
  /** MC-1, MC-7: the link under the flag and the panel button. */
  entry: "Что узнал workflow",
  /** MC-2: the `h1`. */
  title: (name: string) => `Что узнал «${name}»`,
  openWorkflow: "Открыть workflow",
  columns: { record: "Запись", kind: "Вид", confirmations: "Подтверждений", date: "Дата" },
  delete: "Удалить",
  cancel: "Отмена",
  deleteFailed: (reason: string) => `Не удалось удалить: ${reason}`,
  loading: "Загружаем знания…",
  loadFailed: "Не удалось загрузить знания",
} as const;

/**
 * `employeeInPanel` — the panel screen of an employee's workflow (the record has an `author`): only the author
 * can turn self-learning on, so the texts say so instead of pointing at the editor.
 */
export type KnowledgeAudience = { employeeInPanel: boolean };

/** MC-5: the empty table — the graph has no records yet, or self-learning is off. */
export function knowledgeEmpty(selfLearning: boolean, { employeeInPanel }: KnowledgeAudience): { title: string; description: string } {
  if (selfLearning) {
    return {
      title: "Workflow пока ничего не узнал",
      description: "Знания появятся после первого законченного запуска. Остановленные запуски не учат.",
    };
  }
  return {
    title: "Самообучение выключено",
    description: employeeInPanel
      ? "Включить его может автор."
      : "Включите его в редакторе workflow — запуски начнут запоминать, где что нашли.",
  };
}

export type KnowledgeStateLineKey =
  | "scope"
  | "beyond"
  | "outdated"
  | "self_learning_off"
  | "lessons_off"
  | "selection"
  | "last_run";

/**
 * One state line (UXRD KN-01, «Состояние»): the first line of the list reads as UI text, the rest as captions.
 * `icon: "info"` — the line starts with `Info`; `reason` — line 5's reason, shown after `CircleMinus`.
 */
export type KnowledgeStateLine = { key: KnowledgeStateLineKey; text: string; icon: "info" | null; reason: string | null };

const line = (key: KnowledgeStateLineKey, text: string, icon: "info" | null = null): KnowledgeStateLine => ({
  key,
  text,
  icon,
  reason: null,
});

/** MC-3: why selection by meaning is off. */
function selectionOffReason(selection: Extract<KnowledgeSelection, { state: "off" }>): string {
  return selection.reason === "model_not_selected"
    ? "для него не выбрана модель — её выбирает администратор в панели, в разделе «Модели»"
    : `модель ${formatModel(selection.model)} не ответила или отказала — проверить её может администратор в панели, в разделе «Модели»`;
}

function selectionLine(selection: KnowledgeSelection): KnowledgeStateLine | null {
  switch (selection.state) {
    case "on":
      return null;
    case "off":
      return line(
        "selection",
        `Отбор по смыслу выключен: ${selectionOffReason(selection)}. Пока он выключен, место заполняют самые подтверждённые записи.`,
        "info",
      );
    case "preparing":
      return line(
        "selection",
        `Отбор по смыслу пока работает не для всех записей: ${selection.pending} ещё готовят к нему, до тех пор они идут в запуски по подтверждениям.`,
        "info",
      );
  }
}

/** MC-3: why the last run taught nothing; `model` is the round's model label. */
const LAST_RUN_REASON: Record<LastExtractionReason, (model: string) => string> = {
  stopped: () => "запуск остановили",
  owner_disabled: () => "запустивший отключён",
  quota_exhausted: (model) => `у запустившего закончилась квота на модель ${model}`,
  model_not_connected: (model) => `модель ${model} отключена`,
  model_not_allowed: (model) => `у запустившего больше нет доступа к модели ${model}`,
  no_models_allowed: () => "у запустившего нет доступа ни к одной модели — его выдаёт администратор",
  model_error: (model) => `модель ${model} не ответила`,
  invalid_answer: (model) => `модель ${model} дважды дала ответ, который не удалось разобрать`,
  interrupted: () => "работа прервалась из-за сбоя на сервере",
};

/** Line 5: what the last round added, confirmed and outdated, or why it taught nothing. */
function lastRunLine(last: LastExtraction): KnowledgeStateLine {
  const head = `Последний запуск, ${formatDayTime(last.at)}`;
  if (last.status === "done") {
    const parts = [
      last.added > 0 ? `добавлено ${last.added}` : null,
      last.confirmed > 0 ? `подтверждено ${last.confirmed}` : null,
      last.outdated > 0 ? `устарело ${last.outdated}` : null,
    ].filter((part) => part !== null);
    return line("last_run", `${head}: ${parts.length > 0 ? parts.join(", ") : "нового не нашлось"}`);
  }
  // The contract gives a reason on every skipped or failed round; without one the line names none.
  if (last.reason === null) return line("last_run", `${head}, ничему не научил`);
  return { ...line("last_run", `${head}, ничему не научил:`), reason: LAST_RUN_REASON[last.reason](formatModel(last.model)) };
}

const records = (count: number): string => pluralRu(count, ["запись", "записи", "записей"]);
/** «из {M} …»: the genitive after «из». */
const ofRecords = (count: number): string => pluralRu(count, ["записи", "записей", "записей"]);

/**
 * The state lines MC-3, top to bottom (design-web.md, «Как экран выбирает, что показать»). None while the graph
 * is empty: the table's empty state stands alone. With self-learning off its line replaces lines 1–2 and the
 * lines about lessons and selection are absent; line 3 and line 5 stay.
 */
export function knowledgeStateLines(view: KnowledgeView, audience: KnowledgeAudience): KnowledgeStateLine[] {
  if (view.items.length === 0) return [];
  const { active, always, beyond, outdated, percent } = view.counts;
  const lines: KnowledgeStateLine[] = [];
  if (view.selfLearning) {
    const place = `знания занимают ${percent}% места`;
    lines.push(
      beyond === 0
        ? line("scope", `Запуски получают все ${active} ${records(active)} · ${place}`)
        : line("scope", `При любом вопросе запуски получают ${always} из ${active} ${ofRecords(active)} · ${place}`),
    );
    if (beyond > 0) {
      lines.push(
        view.selection.state === "off"
          ? line(
              "beyond",
              `${beyond} ${pluralRu(beyond, ["не помещается", "не помещаются", "не помещаются"])}: первыми выпадают записи, которые подтверждались реже, а среди равных — самые старые.`,
              "info",
            )
          : line(
              "beyond",
              `Ещё ${beyond} — только по теме вопроса: до половины места запуск отдаёт записям, ближайшим по смыслу к вопросу, остальное — самым подтверждённым, а среди равных — самым новым.`,
              "info",
            ),
      );
    }
  } else {
    const author = audience.employeeInPanel ? " Включить его может автор." : "";
    lines.push(
      line("self_learning_off", `Самообучение выключено: запуски не получают эти знания и не пополняют их.${author}`, "info"),
    );
  }
  if (outdated > 0) {
    lines.push(
      line("outdated", `Ещё ${outdated} ${pluralRu(outdated, ["устарела", "устарели", "устарели"])} — запуски их не получают.`),
    );
  }
  if (view.selfLearning) {
    if (!view.lessonsEnabled) {
      lines.push(
        line(
          "lessons_off",
          "Уроки сейчас не идут в запуски — их выключил администратор. Факты и «искал — не нашёл» идут как обычно.",
          "info",
        ),
      );
    }
    const selection = selectionLine(view.selection);
    if (selection !== null) lines.push(selection);
  }
  if (view.lastExtraction !== null) lines.push(lastRunLine(view.lastExtraction));
  return lines;
}

export type KnowledgeTabId = "all" | "facts" | "lessons" | "searched_nothing" | "beyond";

/**
 * A tab of the list (MC-4): `label` «{имя} · {число}», its records in the server's order, and the table's
 * «Нет совпадений» text (MC-5) — `null` on «Все» and the fifth tab, which never show an empty list.
 */
export type KnowledgeTab = { id: KnowledgeTabId; label: string; items: KnowledgeItem[]; noMatches: string | null };

const tab = (id: KnowledgeTabId, name: string, items: KnowledgeItem[], noMatches: string | null): KnowledgeTab => ({
  id,
  label: `${name} · ${items.length}`,
  items,
  noMatches,
});

/**
 * The tabs of the list. The fifth holds the records beyond the always-part and exists only with self-learning on
 * and such records present; it reads «Не помещаются» while selection by meaning is off, otherwise «Только по
 * теме» (UXRD KD-7).
 */
export function knowledgeTabs(view: KnowledgeView): KnowledgeTab[] {
  const { items } = view;
  const tabs = [
    tab("all", "Все", items, null),
    tab("facts", "Факты", items.filter((item) => item.kind === "fact"), "Фактов нет"),
    tab("lessons", "Уроки", items.filter((item) => item.kind === "lesson"), "Уроков нет"),
    tab(
      "searched_nothing",
      "Искал — не нашёл",
      items.filter((item) => item.kind === "searched_nothing"),
      "Записей «искал — не нашёл» нет",
    ),
  ];
  const beyond = items.filter((item) => item.placement === "by_topic" || item.placement === "does_not_fit");
  if (view.selfLearning && beyond.length > 0) {
    tabs.push(tab("beyond", view.selection.state === "off" ? "Не помещаются" : "Только по теме", beyond, null));
  }
  return tabs;
}

/** A record's mark (MC-4): a `StateBadge` word and its state. */
export type KnowledgeMark = { text: string; state: "neutral" | "off" };

/**
 * The «Запись» cell (MC-4): `tool` — `server.tool` in Mono before the title (lessons and «искал — не нашёл»),
 * `title` — the first line, `detail` — the second line before the mark.
 */
export type KnowledgeCell = { tool: string | null; title: string; detail: string | null };

/** One row of the list: everything the table shows for a record. */
export type KnowledgeRow = {
  /** `${type}:${id}` — an id is unique only within its `type`. */
  key: string;
  /** The record's text cut to 60 characters: the row menu's name and the delete dialog's text. */
  name: string;
  kind: string;
  mark: KnowledgeMark | null;
  cell: KnowledgeCell;
  confirmations: number;
  /** The day of `date` in the viewer's time zone. */
  date: string;
};

const KIND_LABEL: Record<KnowledgeItem["kind"], string> = {
  fact: "факт",
  lesson: "рабочий урок",
  searched_nothing: "искал — не нашёл",
};

/**
 * One mark per record: by `state` first, then, for an `active` record, by `placement`. With self-learning off
 * no placement mark stands (core sends `placement` `null` then).
 */
function knowledgeMark(item: KnowledgeItem, selfLearning: boolean): KnowledgeMark | null {
  if (item.state === "outdated") return { text: "устарела", state: "off" };
  if (item.state === "lessons_off") return { text: "уроки выключены", state: "off" };
  if (!selfLearning) return null;
  if (item.placement === "by_topic") return { text: "только по теме", state: "neutral" };
  if (item.placement === "does_not_fit") return { text: "не помещается", state: "off" };
  return null;
}

const toolOf = (item: { server: string; tool: string }): string => `${item.server}.${item.tool}`;

function knowledgeCell(item: KnowledgeItem): KnowledgeCell {
  if (item.type === "entity") return { tool: null, title: item.name, detail: item.description };
  switch (item.kind) {
    case "fact":
      return { tool: null, title: `${item.from.name} → ${item.label} → ${item.to.name}`, detail: null };
    case "lesson":
      return { tool: toolOf(item), title: item.question, detail: `${item.hint} — ${item.outcome}` };
    case "searched_nothing":
      return { tool: toolOf(item), title: item.question, detail: "пусто" };
  }
}

/** The record's text for the row menu and the delete dialog, cut after 60 characters with «…». */
function itemText(item: KnowledgeItem): string {
  const { tool, title } = knowledgeCell(item);
  const text = tool === null ? title : `${tool} · ${title}`;
  return text.length > ITEM_TEXT_MAX ? `${text.slice(0, ITEM_TEXT_MAX)}…` : text;
}

export function knowledgeRow(item: KnowledgeItem, selfLearning: boolean): KnowledgeRow {
  return {
    key: `${item.type}:${item.id}`,
    name: itemText(item),
    kind: KIND_LABEL[item.kind],
    mark: knowledgeMark(item, selfLearning),
    cell: knowledgeCell(item),
    confirmations: item.confirmations,
    date: formatDay(item.date),
  };
}

/**
 * KN-02, MC-6: the delete dialog. An entity names the relation facts among the loaded records that leave with it
 * (`DELETE` answers 204 without a body); `relations` is what the notice after the delete reports.
 */
export function knowledgeDeleteDialog(
  item: KnowledgeItem,
  items: readonly KnowledgeItem[],
): { title: string; body: string; relations: number } {
  const text = itemText(item);
  if (item.type !== "entity") {
    return { title: "Удалить запись?", body: `«${text}». ${LEAVES_ONE}`, relations: 0 };
  }
  const relations = items.filter(
    (other) => other.type === "relation" && other.kind === "fact" && (other.from.id === item.id || other.to.id === item.id),
  ).length;
  return {
    title: `Удалить «${text}»?`,
    body:
      relations > 0
        ? `Вместе с ней удалятся связи: ${relations}. Следующие шаги запусков их уже не получат. ${FOREVER}`
        : LEAVES_ONE,
    relations,
  };
}

/** MC-6: the notice after a delete; `relations` from `knowledgeDeleteDialog`. */
export function knowledgeDeletedNotice(relations: number): string {
  return relations > 0 ? `Удалено вместе со связями: ${relations}` : "Удалено";
}
