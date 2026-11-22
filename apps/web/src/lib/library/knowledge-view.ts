import type {
  KnowledgeItem,
  KnowledgeSelection,
  KnowledgeView,
  LastExtraction,
} from '@agent-os/contracts';
import { formatModel } from '@/lib/agents/format';
import { formatDay, type Formatter } from '@/i18n/formats';
import type { LibraryTranslator } from '@/i18n/catalog';

/**
 * The one place where the knowledge screen's server answer becomes its words (self-learning design-web.md,
 * «Как экран выбирает, что показать»; UXRD KN-01, MC-2 – MC-6): state lines, tabs, row marks, the «Запись»
 * cell and the delete texts. Every number of a state line is a `counts` field as the server gives it and every
 * mark follows the record's `state` and `placement`; the only counting here is the rows of a tab and the
 * relations that leave with an entity (KD-5). Nothing here sorts: rows keep the server's order. The words come
 * from the `library.knowledge` catalogue through the translator the caller passes.
 */

/** Characters of a record's text in the row menu and the delete dialog before «…» (KD-4). */
const ITEM_TEXT_MAX = 60;

/** The page's translator and formatter: what every text function of the screen needs. */
export type KnowledgeIntl = { t: LibraryTranslator; format: Formatter };

/**
 * `employeeInPanel` — the panel screen of an employee's deep agent (the record has an `author`): only the author
 * can turn self-learning on, so the texts say so instead of pointing at the editor.
 */
export type KnowledgeAudience = { employeeInPanel: boolean };

const audienceOf = ({ employeeInPanel }: KnowledgeAudience): string =>
  employeeInPanel ? 'panel' : 'editor';

/** MC-5: the empty table — the graph has no records yet, or self-learning is off. */
export function knowledgeEmpty(
  t: LibraryTranslator,
  selfLearning: boolean,
  audience: KnowledgeAudience,
): { title: string; description: string } {
  if (selfLearning) {
    return {
      title: t('knowledge.empty.nothingTitle'),
      description: t('knowledge.empty.nothingText'),
    };
  }
  return {
    title: t('knowledge.empty.offTitle'),
    description: t('knowledge.empty.offText', {
      audience: audienceOf(audience),
    }),
  };
}

export type KnowledgeStateLineKey =
  | 'scope'
  | 'beyond'
  | 'outdated'
  | 'self_learning_off'
  | 'lessons_off'
  | 'selection'
  | 'last_run';

/**
 * One state line (UXRD KN-01, «Состояние»): the first line of the list reads as UI text, the rest as captions.
 * `icon: "info"` — the line starts with `Info`; `reason` — line 5's reason, shown after `CircleMinus`.
 */
export type KnowledgeStateLine = {
  key: KnowledgeStateLineKey;
  text: string;
  icon: 'info' | null;
  reason: string | null;
};

const line = (
  key: KnowledgeStateLineKey,
  text: string,
  icon: 'info' | null = null,
): KnowledgeStateLine => ({
  key,
  text,
  icon,
  reason: null,
});

/** MC-3: the selection line, when selection by meaning is not fully on. */
function selectionLine(
  t: LibraryTranslator,
  selection: KnowledgeSelection,
): KnowledgeStateLine | null {
  switch (selection.state) {
    case 'on':
      return null;
    case 'off':
      return line(
        'selection',
        selection.reason === 'model_not_selected'
          ? t('knowledge.lines.selectionNoModel')
          : t('knowledge.lines.selectionFailed', {
              model: formatModel(selection.model),
            }),
        'info',
      );
    case 'preparing':
      return line(
        'selection',
        t('knowledge.lines.selectionPreparing', { pending: selection.pending }),
        'info',
      );
  }
}

/** Line 5: what the last round added, confirmed and outdated, or why it taught nothing (MC-3). */
function lastRunLine(
  { t, format }: KnowledgeIntl,
  last: LastExtraction,
): KnowledgeStateLine {
  const at = format.dateTime(new Date(last.at), 'dayTime');
  if (last.status === 'done') {
    const results = [
      last.added > 0
        ? t('knowledge.lastRun.added', { count: last.added })
        : null,
      last.confirmed > 0
        ? t('knowledge.lastRun.confirmed', { count: last.confirmed })
        : null,
      last.outdated > 0
        ? t('knowledge.lastRun.outdated', { count: last.outdated })
        : null,
    ].filter((part) => part !== null);
    // Each part is a whole phrase of its language; only the comma between them is shared by both.
    const text =
      results.length > 0
        ? results.join(', ')
        : t('knowledge.lastRun.nothingNew');
    return line('last_run', t('knowledge.lastRun.done', { at, results: text }));
  }
  // The contract gives a reason on every skipped or failed round; without one the line names none.
  if (last.reason === null)
    return line('last_run', t('knowledge.lastRun.taughtNothing', { at }));
  return {
    ...line('last_run', t('knowledge.lastRun.taughtNothingBecause', { at })),
    reason: t(`knowledge.lastRun.reason.${last.reason}`, {
      model: formatModel(last.model),
    }),
  };
}

/**
 * The state lines MC-3, top to bottom (design-web.md, «Как экран выбирает, что показать»). None while the graph
 * is empty: the table's empty state stands alone. With self-learning off its line replaces lines 1–2 and the
 * lines about lessons and selection are absent; line 3 and line 5 stay.
 */
export function knowledgeStateLines(
  view: KnowledgeView,
  audience: KnowledgeAudience,
  intl: KnowledgeIntl,
): KnowledgeStateLine[] {
  const { t } = intl;
  if (view.items.length === 0) return [];
  const { active, always, beyond, outdated, percent } = view.counts;
  const lines: KnowledgeStateLine[] = [];
  if (view.selfLearning) {
    lines.push(
      beyond === 0
        ? line('scope', t('knowledge.lines.scopeAll', { active, percent }))
        : line(
            'scope',
            t('knowledge.lines.scopeSome', { always, active, percent }),
          ),
    );
    if (beyond > 0) {
      const text =
        view.selection.state === 'off'
          ? t('knowledge.lines.doesNotFit', { beyond })
          : t('knowledge.lines.byTopic', { beyond });
      lines.push(line('beyond', text, 'info'));
    }
  } else {
    lines.push(
      line(
        'self_learning_off',
        t('knowledge.lines.selfLearningOff', {
          audience: audienceOf(audience),
        }),
        'info',
      ),
    );
  }
  if (outdated > 0)
    lines.push(line('outdated', t('knowledge.lines.outdated', { outdated })));
  if (view.selfLearning) {
    if (!view.lessonsEnabled)
      lines.push(line('lessons_off', t('knowledge.lines.lessonsOff'), 'info'));
    const selection = selectionLine(t, view.selection);
    if (selection !== null) lines.push(selection);
  }
  if (view.lastExtraction !== null)
    lines.push(lastRunLine(intl, view.lastExtraction));
  return lines;
}

export type KnowledgeTabId =
  'all' | 'facts' | 'lessons' | 'searched_nothing' | 'beyond';

/**
 * A tab of the list (MC-4): `label` «{имя} · {число}», its records in the server's order, and the table's
 * «Нет совпадений» text (MC-5) — `null` on «Все» and the fifth tab, which never show an empty list.
 */
export type KnowledgeTab = {
  id: KnowledgeTabId;
  label: string;
  items: KnowledgeItem[];
  noMatches: string | null;
};

/**
 * The tabs of the list. The fifth holds the records beyond the always-part and exists only with self-learning on
 * and such records present; it reads «Не помещаются» while selection by meaning is off, otherwise «Только по
 * теме» (UXRD KD-7).
 */
export function knowledgeTabs(
  t: LibraryTranslator,
  view: KnowledgeView,
): KnowledgeTab[] {
  const { items } = view;
  const ofKind = (kind: KnowledgeItem['kind']) =>
    items.filter((item) => item.kind === kind);
  const facts = ofKind('fact');
  const lessons = ofKind('lesson');
  const nothing = ofKind('searched_nothing');
  const tabs: KnowledgeTab[] = [
    {
      id: 'all',
      label: t('knowledge.tabs.all', { count: items.length }),
      items,
      noMatches: null,
    },
    {
      id: 'facts',
      label: t('knowledge.tabs.facts', { count: facts.length }),
      items: facts,
      noMatches: t('knowledge.noMatches.facts'),
    },
    {
      id: 'lessons',
      label: t('knowledge.tabs.lessons', { count: lessons.length }),
      items: lessons,
      noMatches: t('knowledge.noMatches.lessons'),
    },
    {
      id: 'searched_nothing',
      label: t('knowledge.tabs.searchedNothing', { count: nothing.length }),
      items: nothing,
      noMatches: t('knowledge.noMatches.searchedNothing'),
    },
  ];
  const beyond = items.filter(
    (item) =>
      item.placement === 'by_topic' || item.placement === 'does_not_fit',
  );
  if (view.selfLearning && beyond.length > 0) {
    const label =
      view.selection.state === 'off'
        ? t('knowledge.tabs.doesNotFit', { count: beyond.length })
        : t('knowledge.tabs.byTopic', { count: beyond.length });
    tabs.push({ id: 'beyond', label, items: beyond, noMatches: null });
  }
  return tabs;
}

/** A record's mark (MC-4): a `StateBadge` word and its state. */
export type KnowledgeMark = { text: string; state: 'neutral' | 'off' };

/**
 * The «Запись» cell (MC-4): `tool` — `server.tool` in Mono before the title (lessons and «искал — не нашёл»),
 * `title` — the first line, `detail` — the second line before the mark.
 */
export type KnowledgeCell = {
  tool: string | null;
  title: string;
  detail: string | null;
};

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

const KIND_KEY = {
  fact: 'fact',
  lesson: 'lesson',
  searched_nothing: 'searchedNothing',
} as const satisfies Record<KnowledgeItem['kind'], string>;

/**
 * One mark per record: by `state` first, then, for an `active` record, by `placement`. With self-learning off
 * no placement mark stands (core sends `placement` `null` then).
 */
function knowledgeMark(
  t: LibraryTranslator,
  item: KnowledgeItem,
  selfLearning: boolean,
): KnowledgeMark | null {
  if (item.state === 'outdated')
    return { text: t('knowledge.marks.outdated'), state: 'off' };
  if (item.state === 'lessons_off')
    return { text: t('knowledge.marks.lessonsOff'), state: 'off' };
  if (!selfLearning) return null;
  if (item.placement === 'by_topic')
    return { text: t('knowledge.marks.byTopic'), state: 'neutral' };
  if (item.placement === 'does_not_fit')
    return { text: t('knowledge.marks.doesNotFit'), state: 'off' };
  return null;
}

const toolOf = (item: { server: string; tool: string }): string =>
  `${item.server}.${item.tool}`;

function knowledgeCell(
  t: LibraryTranslator,
  item: KnowledgeItem,
): KnowledgeCell {
  if (item.type === 'entity')
    return { tool: null, title: item.name, detail: item.description };
  switch (item.kind) {
    case 'fact':
      return {
        tool: null,
        title: `${item.from.name} → ${item.label} → ${item.to.name}`,
        detail: null,
      };
    case 'lesson':
      return {
        tool: toolOf(item),
        title: item.question,
        detail: `${item.hint} — ${item.outcome}`,
      };
    case 'searched_nothing':
      return {
        tool: toolOf(item),
        title: item.question,
        detail: t('knowledge.nothingFound'),
      };
  }
}

/** The record's text for the row menu and the delete dialog, cut after 60 characters with «…». */
function itemText(t: LibraryTranslator, item: KnowledgeItem): string {
  const { tool, title } = knowledgeCell(t, item);
  const text = tool === null ? title : `${tool} · ${title}`;
  return text.length > ITEM_TEXT_MAX
    ? `${text.slice(0, ITEM_TEXT_MAX)}…`
    : text;
}

export function knowledgeRow(
  item: KnowledgeItem,
  selfLearning: boolean,
  { t, format }: KnowledgeIntl,
): KnowledgeRow {
  return {
    key: `${item.type}:${item.id}`,
    name: itemText(t, item),
    kind: t(`knowledge.kinds.${KIND_KEY[item.kind]}`),
    mark: knowledgeMark(t, item, selfLearning),
    cell: knowledgeCell(t, item),
    confirmations: item.confirmations,
    date: formatDay(format, item.date),
  };
}

/**
 * KN-02, MC-6: the delete dialog. An entity names the relation facts among the loaded records that leave with it
 * (`DELETE` answers 204 without a body); `relations` is what the notice after the delete reports.
 */
export function knowledgeDeleteDialog(
  t: LibraryTranslator,
  item: KnowledgeItem,
  items: readonly KnowledgeItem[],
): { title: string; body: string; relations: number } {
  const text = itemText(t, item);
  if (item.type !== 'entity') {
    return {
      title: t('knowledge.deleteDialog.recordTitle'),
      body: t('knowledge.deleteDialog.record', { text }),
      relations: 0,
    };
  }
  const relations = items.filter(
    (other) =>
      other.type === 'relation' &&
      other.kind === 'fact' &&
      (other.from.id === item.id || other.to.id === item.id),
  ).length;
  return {
    title: t('knowledge.deleteDialog.entityTitle', { text }),
    body:
      relations > 0
        ? t('knowledge.deleteDialog.entityWithRelations', { relations })
        : t('knowledge.deleteDialog.entity'),
    relations,
  };
}

/** MC-6: the notice after a delete; `relations` from `knowledgeDeleteDialog`. */
export function knowledgeDeletedNotice(
  t: LibraryTranslator,
  relations: number,
): string {
  return t('knowledge.deleted', { relations });
}
