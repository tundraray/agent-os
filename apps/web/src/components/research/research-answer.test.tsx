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
const SUMMARY = 'Расходы выросли из-за новых кластеров.';
const MC_32 = 'Источники данных не подключены — ответ опирается только на знания модели и не проверен по данным.';
const MC_33 = 'из знаний модели, без источника';
const MC_34 = 'Краткий пересказ — основания в утверждениях ниже';

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

// AC-20.1 (draw), AC-20.7, MC-23…MC-28, MC-34, DC-10, KD-11: the header, the summary with its caption, the groups, footnotes and the source list follow the metadata.
describe('ResearchAnswer — parts drawn from researchAnswer', () => {
  it.each<{
    name: string;
    answer: AnswerOverrides;
    outcome: string;
    summary: boolean;
    stopReason: string | null;
    groups: string[];
    footnotes: string[];
    unverified: number;
    sourceList: string | null;
  }>([
    { name: 'answered from sources', answer: WITH_SOURCES, outcome: 'Есть ответ', summary: true, stopReason: null, groups: ['Установлено', 'Предположения'], footnotes: ['Источник 1', 'Источник 2', 'Источник 3'], unverified: 1, sourceList: 'Источники (3)' },
    { name: 'partial, stopped by force', answer: { ...WITH_SOURCES, outcome: 'partial', summary: null, stopReason: 'budget_exhausted' }, outcome: 'Частичный ответ', summary: false, stopReason: 'Остановлен: исчерпан бюджет', groups: ['Установлено', 'Предположения'], footnotes: ['Источник 1', 'Источник 2', 'Источник 3'], unverified: 1, sourceList: 'Источники (3)' },
    { name: 'only «Не выяснено» keeps the summary', answer: { launchKey: 'k1', outcome: 'inconclusive', established: [], unknown: [{ text: 'Причина роста не найдена.', footnotes: [], verified: false, confidence: null, causal: false }], sources: [] }, outcome: 'Вывода нет', summary: true, stopReason: null, groups: ['Не выяснено'], footnotes: [], unverified: 1, sourceList: null },
    { name: 'no claim drops a given summary', answer: { launchKey: 'k1', outcome: 'inconclusive', stopReason: 'step_limit', established: [], sources: [] }, outcome: 'Вывода нет', summary: false, stopReason: 'Остановлен: достигнут лимит шагов', groups: [], footnotes: [], unverified: 0, sourceList: null },
  ])('$name', ({ answer, outcome, summary, stopReason, groups, footnotes, unverified, sourceList }) => {
    render(<ResearchAnswer answer={answerOf(answer)} />);

    expect(screen.getByRole('heading', { level: 2, name: 'Ответ ресерча' })).toBeInTheDocument();
    expect(screen.getByText(outcome)).toBeInTheDocument();
    expect(screen.getByText(GOAL)).toBeInTheDocument();
    expect(screen.queryByText(SUMMARY) !== null).toBe(summary);
    expect(screen.queryByText(MC_34) !== null).toBe(summary);
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
  it('claims: MC-32 under the goal, the summary and MC-34, then each claim followed by MC-33 as plain text', () => {
    render(<ResearchAnswer answer={answerOf(WITHOUT_SOURCES)} />);

    const goal = screen.getByText(GOAL);
    const warning = screen.getByText(MC_32);
    const summary = screen.getByText(SUMMARY);
    const caption = screen.getByText(MC_34);
    const marks = screen.getAllByText(MC_33);
    const claims = [screen.getByText(/^Нужен backoff с джиттером\./), screen.getByText(/^Число попыток ограничивают\./)];

    expect([follows(goal, warning), follows(warning, summary), follows(summary, caption), follows(caption, claims[0])]).toEqual([true, true, true, true]);
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
    expect(screen.queryByText(MC_34)).toBeNull();
    expect(screen.queryAllByRole('heading', { level: 3 })).toHaveLength(0);
  });
});
