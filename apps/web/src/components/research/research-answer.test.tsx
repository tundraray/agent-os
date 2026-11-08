import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  RESEARCH_METADATA_KEYS,
  ResearchAnswerMetadataSchema,
  type ResearchAnswerMetadata,
} from '@agent-os/contracts';
import { researchAnswerMessage } from '@/test/fixtures';
import { ResearchAnswer } from './research-answer';

const GOAL = 'Почему выросли расходы на облако';
const MC_32 = 'Источники данных не подключены — ответ опирается только на знания модели и не проверен по данным.';
const MC_33 = 'из знаний модели, без источника';
const MC_34 = 'Краткий пересказ — основания в утверждениях ниже';
const MC_2 = 'Главное из установленного';
const MC_3 = 'причинная связь не доказана';
/** The summary string of a message stored before agent-quality (the fixture's default); the screen never draws it. */
const OLD_SUMMARY = 'Расходы выросли из-за новых кластеров.';

type AnswerOverrides = Partial<ResearchAnswerMetadata> & Pick<ResearchAnswerMetadata, 'launchKey'>;

/** The `researchAnswer` metadata exactly as the answer message carries it. */
function answerOf(overrides: AnswerOverrides): ResearchAnswerMetadata {
  const message = researchAnswerMessage({ id: 'm-answer', answer: overrides });
  return z.object({ [RESEARCH_METADATA_KEYS.researchAnswer]: ResearchAnswerMetadataSchema }).parse(message.metadata).researchAnswer;
}

const WITH_SOURCES: AnswerOverrides = {
  launchKey: 'k1',
  established: [
    { text: 'В октябре добавлены два кластера.', footnotes: [1, 2], verified: true, confidence: null, causal: false },
  ],
  assumed: [{ text: 'Рост связан с выкладкой.', footnotes: [3], verified: false, confidence: null, causal: false }],
  sources: [
    { number: 1, sourceId: 'billing', toolName: 'get_costs', snapshot: '30.10 14:00–15:00', truncated: false },
    { number: 2, sourceId: 'k8s', toolName: 'list_clusters', snapshot: '30.10', truncated: true },
    { number: 3, sourceId: 'deploys', toolName: 'list_deploys', snapshot: '30.10 14:02', truncated: false },
  ],
};

const WITHOUT_SOURCES: AnswerOverrides = {
  launchKey: 'k1',
  sourceMode: 'model_knowledge',
  established: [],
  assumed: [
    { text: 'Нужен backoff с джиттером.', footnotes: [], verified: false, confidence: null, causal: false },
    { text: 'Число попыток ограничивают.', footnotes: [], verified: false, confidence: null, causal: false },
  ],
  sources: [],
};

function follows(earlier: HTMLElement, later: HTMLElement): boolean {
  return (earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

// AC-20.1 (draw), AC-20.7, MC-23…MC-28, DC-10: the header, the groups, footnotes and the source list follow the metadata (the summary is U-1 below).
describe('ResearchAnswer — parts drawn from researchAnswer', () => {
  it.each<{
    name: string;
    answer: AnswerOverrides;
    outcome: string;
    stopReason: string | null;
    groups: string[];
    footnotes: string[];
    unverified: number;
    sourceList: string | null;
  }>([
    { name: 'answered from sources', answer: WITH_SOURCES, outcome: 'Есть ответ', stopReason: null, groups: ['Установлено', 'Предположения'], footnotes: ['Источник 1', 'Источник 2', 'Источник 3'], unverified: 1, sourceList: 'Источники (3)' },
    { name: 'partial, stopped by force', answer: { ...WITH_SOURCES, outcome: 'partial', summary: null, stopReason: 'budget_exhausted' }, outcome: 'Частичный ответ', stopReason: 'Остановлен: исчерпан бюджет', groups: ['Установлено', 'Предположения'], footnotes: ['Источник 1', 'Источник 2', 'Источник 3'], unverified: 1, sourceList: 'Источники (3)' },
    { name: 'only «Не выяснено»', answer: { launchKey: 'k1', outcome: 'inconclusive', established: [], unknown: [{ text: 'Причина роста не найдена.', footnotes: [], verified: false, confidence: null, causal: false }], sources: [] }, outcome: 'Вывода нет', stopReason: null, groups: ['Не выяснено'], footnotes: [], unverified: 1, sourceList: null },
    { name: 'no claim', answer: { launchKey: 'k1', outcome: 'inconclusive', stopReason: 'step_limit', established: [], sources: [] }, outcome: 'Вывода нет', stopReason: 'Остановлен: достигнут лимит шагов', groups: [], footnotes: [], unverified: 0, sourceList: null },
  ])('$name', ({ answer, outcome, stopReason, groups, footnotes, unverified, sourceList }) => {
    render(<ResearchAnswer answer={answerOf(answer)} />);

    expect(screen.getByRole('heading', { level: 2, name: 'Ответ ресерча' })).toBeInTheDocument();
    expect(screen.getByText(outcome)).toBeInTheDocument();
    expect(screen.getByText(GOAL)).toBeInTheDocument();
    if (stopReason !== null) expect(screen.getByText(stopReason)).toBeInTheDocument();
    expect(screen.queryAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)).toEqual(groups);
    expect(screen.queryAllByRole('link', { name: /^Источник \d+$/ }).map((link) => link.getAttribute('aria-label'))).toEqual(footnotes);
    expect(screen.queryAllByText('не проверено')).toHaveLength(unverified);
    if (sourceList === null) expect(screen.queryByRole('button', { name: /^Источники/ })).toBeNull();
    else expect(screen.getByRole('button', { name: sourceList })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(MC_32)).toBeNull();
    expect(screen.queryByText(MC_33)).toBeNull();
  });

  it('a footnote opens the source list and moves focus to its record, with the truncation mark', async () => {
    const user = userEvent.setup();
    render(<ResearchAnswer answer={answerOf(WITH_SOURCES)} />);

    await user.click(screen.getByRole('link', { name: 'Источник 2' }));

    expect(screen.getByRole('button', { name: 'Источники (3)' })).toHaveAttribute('aria-expanded', 'true');
    const records = within(screen.getByRole('list', { name: 'Источники (3)' })).getAllByRole('listitem');
    expect(records[1]).toHaveFocus();
    expect(records[1]).toHaveTextContent('2. k8slist_clusters30.10данные усечены');
    expect(within(records[0]).queryByText('данные усечены')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Источники (3)' }));
    expect(screen.getByRole('button', { name: 'Источники (3)' })).toHaveAttribute('aria-expanded', 'false');
  });

  it.each([
    { launch: { messageId: 'm-launch' }, href: '#m-launch' },
    { launch: { toolCallId: 'call-1' }, href: '#call-1' },
  ])('«К запросу» points at $href', async ({ launch, href }) => {
    const user = userEvent.setup();
    const onShowLaunch = vi.fn();
    render(<ResearchAnswer answer={answerOf({ ...WITH_SOURCES, launch })} onShowLaunch={onShowLaunch} />);
    const link = screen.getByRole('link', { name: 'К запросу ресерча' });
    expect(link).toHaveAttribute('href', href);
    await user.click(link);
    expect(onShowLaunch).toHaveBeenCalledExactlyOnceWith(href.slice(1));
  });
});

// AC-27.3 (draw), AC-27.4, NFR-05 (reading order), UXRD KD-9…KD-11: without sources MC-32 opens the answer, MC-33 follows every claim as text, and
// nothing points at a source.
describe('ResearchAnswer — without sources', () => {
  it('claims: MC-32 under the goal, then each claim followed by MC-33 as plain text', () => {
    render(<ResearchAnswer answer={answerOf(WITHOUT_SOURCES)} />);

    const goal = screen.getByText(GOAL);
    const warning = screen.getByText(MC_32);
    const marks = screen.getAllByText(MC_33);
    const claims = [screen.getByText(/^Нужен backoff с джиттером\./), screen.getByText(/^Число попыток ограничивают\./)];

    expect([follows(goal, warning), follows(warning, claims[0])]).toEqual([true, true]);
    expect(marks).toHaveLength(2);
    marks.forEach((mark, index) => {
      expect(claims[index]).toContainElement(mark);
      expect(mark.closest('[aria-hidden="true"]')).toBeNull();
      expect(mark).not.toHaveAttribute('title');
      expect(mark).toBeVisible();
    });
    expect(warning.closest('[role="alert"]')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryAllByRole('link', { name: /^Источник/ })).toHaveLength(0);
    expect(screen.queryByText('не проверено')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Источники/ })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Установлено' })).toBeNull();
  });

  it('a stop before the synthesis: MC-32 and MC-25, no claim, no summary', () => {
    render(
      <ResearchAnswer
        answer={answerOf({ ...WITHOUT_SOURCES, outcome: 'inconclusive', summary: null, stopReason: 'deadline', assumed: [] })}
      />,
    );

    expect(screen.getByText('Вывода нет')).toBeInTheDocument();
    expect(follows(screen.getByText(MC_32), screen.getByText('Остановлен: истёк срок расследования'))).toBe(true);
    expect(screen.queryByText(MC_33)).toBeNull();
    expect(screen.queryByText(MC_2)).toBeNull();
    expect(screen.queryAllByRole('heading', { level: 3 })).toHaveLength(0);
  });
});

/** The last list item whose text starts with `text`: the claim in its group (a summary item with the same text comes earlier). */
function claimItem(text: string): HTMLElement {
  const item = screen.getAllByText((_, element) => element?.tagName === 'LI' && (element.textContent ?? '').startsWith(text)).at(-1);
  if (item === undefined) throw new Error(`no claim «${text}»`);
  return item;
}

// U-1. AC-15.3, DC-3, DC-4, DC-5, UXRD KD-3, KD-7: the summary is drawn iff `summaryItems` is non-empty; the `summary` string is never read.
describe('ResearchAnswer — U-1 the summary is drawn iff summaryItems is non-empty', () => {
  const established = [
    { text: 'Ошибки 5xx идут от таймаутов к gateway.', footnotes: [1, 2], verified: true, confidence: 'high', causal: false },
    { text: 'Таймауты начались в 14:00.', footnotes: [2], verified: true, confidence: 'medium', causal: false },
  ] satisfies ResearchAnswerMetadata['established'];
  const sources = [
    { number: 1, sourceId: 'logs', toolName: 'search_logs', snapshot: '30.10 14:00–15:00', truncated: false },
    { number: 2, sourceId: 'metrics', toolName: 'query_metrics', snapshot: '30.10', truncated: false },
  ];

  it.each<{ name: string; answer: AnswerOverrides; items: string[] | null; firstAfterGoal: string }>([
    {
      name: 'UC-1 two items: MC-2 under the goal and a list of item text and group words, no footnotes',
      answer: {
        launchKey: 'k1',
        summary: null,
        summaryItems: [
          { claimId: 'c1', text: established[0].text, confidence: 'high' },
          { claimId: 'c2', text: established[1].text, confidence: 'medium' },
        ],
        established,
        sources,
      },
      items: ['Ошибки 5xx идут от таймаутов к gateway. уверенность высокая', 'Таймауты начались в 14:00. уверенность средняя'],
      firstAfterGoal: MC_2,
    },
    {
      name: 'UC-E1 no items, only «Предположения» and «Не выяснено»: no caption, no list, the first heading follows the goal',
      answer: {
        launchKey: 'k1',
        summary: null,
        established: [],
        assumed: [{ text: 'Рост связан с выкладкой.', footnotes: [1], verified: false, confidence: null, causal: false }],
        unknown: [{ text: 'Причина роста не найдена.', footnotes: [], verified: false, confidence: null, causal: false }],
        sources: sources.slice(0, 1),
      },
      items: null,
      firstAfterGoal: 'Предположения',
    },
    {
      name: 'UC-E2 without sources: MC-32, then the groups, no summary',
      answer: { ...WITHOUT_SOURCES, summary: null },
      items: null,
      firstAfterGoal: MC_32,
    },
    {
      name: 'UC-E3 forced stop: the stop reason under the goal, no summary',
      answer: { launchKey: 'k1', outcome: 'partial', stopReason: 'budget_exhausted', summary: null, established: [established[1]], sources },
      items: null,
      firstAfterGoal: 'Остановлен: исчерпан бюджет',
    },
    {
      name: 'old shape: no items and a summary string: neither the string, MC-34 nor MC-2',
      answer: WITH_SOURCES,
      items: null,
      firstAfterGoal: 'Установлено',
    },
  ])('$name', ({ answer, items, firstAfterGoal }) => {
    render(<ResearchAnswer answer={answerOf(answer)} />);

    const goal = screen.getByText(GOAL);
    // The block right after the goal line is the expected part: no empty summary block in between.
    expect(goal.nextElementSibling?.textContent?.startsWith(firstAfterGoal)).toBe(true);
    expect(screen.queryByText(OLD_SUMMARY)).toBeNull();
    expect(screen.queryByText(MC_34)).toBeNull();
    if (items === null) {
      expect(screen.queryByText(MC_2)).toBeNull();
      return;
    }
    const caption = screen.getByText(MC_2);
    const list = screen.getAllByRole('list')[0];
    const firstGroup = screen.getAllByRole('heading', { level: 3 })[0];
    expect([follows(goal, caption), follows(caption, list), follows(list, firstGroup)]).toEqual([true, true, true]);
    expect(within(list).getAllByRole('listitem').map((item) => item.textContent)).toEqual(items);
    expect(within(list).queryAllByRole('link')).toHaveLength(0);
  });
});

// U-2. AC-15.1, DC-1, DC-2, UXRD KD-1, KD-4, design-web.md KD-6: the label after a claim's footnotes.
describe("ResearchAnswer — U-2 the label after a claim's footnotes", () => {
  const sources = [
    { number: 1, sourceId: 'logs', toolName: 'search_logs', snapshot: '30.10', truncated: false },
    { number: 2, sourceId: 'metrics', toolName: 'query_metrics', snapshot: '30.10', truncated: false },
  ];

  it.each<{ name: string; answer: AnswerOverrides; claims: Record<string, string> }>([
    {
      name: 'UC-2 the four groups as their words, after the footnotes, no digits or %',
      answer: {
        launchKey: 'k1',
        established: [
          { text: 'Вывод А.', footnotes: [1, 2], verified: true, confidence: 'very_high', causal: false },
          { text: 'Вывод Б.', footnotes: [1, 2], verified: true, confidence: 'high', causal: false },
          { text: 'Вывод В.', footnotes: [1, 2], verified: true, confidence: 'medium', causal: false },
          { text: 'Вывод Г.', footnotes: [1, 2], verified: true, confidence: 'low', causal: false },
        ],
        sources,
      },
      claims: {
        'Вывод А.': 'Вывод А. [1] [2] уверенность очень высокая',
        'Вывод Б.': 'Вывод Б. [1] [2] уверенность высокая',
        'Вывод В.': 'Вывод В. [1] [2] уверенность средняя',
        'Вывод Г.': 'Вывод Г. [1] [2] уверенность низкая',
      },
    },
    {
      name: 'confidence null (old message): no words',
      answer: { launchKey: 'k1', established: [{ text: 'Вывод А.', footnotes: [1], verified: true, confidence: null, causal: false }], sources },
      claims: { 'Вывод А.': 'Вывод А. [1]' },
    },
    {
      name: 'causal: MC-3 and no «не проверено»; unverified and not causal: «не проверено» and no MC-3',
      answer: {
        launchKey: 'k1',
        established: [],
        assumed: [
          { text: 'Релиз вызвал ошибки.', footnotes: [1, 2], verified: true, confidence: null, causal: true },
          { text: 'Рост начался на одном узле.', footnotes: [2], verified: false, confidence: null, causal: false },
        ],
        sources,
      },
      claims: {
        'Релиз вызвал ошибки.': `Релиз вызвал ошибки. [1] [2] ${MC_3}`,
        'Рост начался на одном узле.': 'Рост начался на одном узле. [2] не проверено',
      },
    },
    {
      name: 'without sources: MC-33 only, no labels',
      answer: WITHOUT_SOURCES,
      claims: {
        'Нужен backoff с джиттером.': `Нужен backoff с джиттером. ${MC_33}`,
        'Число попыток ограничивают.': `Число попыток ограничивают. ${MC_33}`,
      },
    },
  ])('$name', ({ answer, claims }) => {
    render(<ResearchAnswer answer={answerOf(answer)} />);

    expect(Object.keys(claims).map((text) => claimItem(text).textContent)).toEqual(Object.values(claims));
    for (const label of screen.queryAllByText(/^(уверенность .+|причинная связь не доказана)$/)) {
      // Visible text read right after the last «Источник N» of its claim: not hidden, no tooltip.
      expect(label.closest('[aria-hidden="true"]')).toBeNull();
      expect(label).not.toHaveAttribute('title');
      const claim = label.closest('li');
      if (claim === null) throw new Error(`label «${label.textContent}» outside a claim`);
      const footnotes = within(claim).getAllByRole('link', { name: /^Источник \d+$/ });
      expect(follows(footnotes[footnotes.length - 1], label)).toBe(true);
    }
  });
});
