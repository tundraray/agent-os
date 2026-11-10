import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ResearchLaunchView } from '@agent-os/contracts';
import { researchLaunchView } from '@/test/fixtures';
import { ResearchCard, type ResearchCardAction, type ResearchCardDecisionError, type ResearchCardProps } from './research-card';

const GOAL = 'Почему выросли расходы на облако';
const MC_31 = 'Источники данных не подключены — ответ будет из знаний модели.';
const MC_30 = 'Доступно, когда агент закончит ответ.';
const MC_4 = 'Ресерч ещё запускается. Остановите его через несколько секунд.';
const MC_16 = 'Не удалось остановить ресерч. Попробуйте ещё раз.';

type CardCase = {
  name: string;
  launch: Partial<ResearchLaunchView>;
  pendingDecision?: ResearchCardAction;
  decisionError?: ResearchCardDecisionError;
};

function renderCard(props: Partial<ResearchCardProps> & { launch: ResearchLaunchView }) {
  const onDecision = vi.fn();
  const onShowAnswer = vi.fn();
  render(<ResearchCard replyStreaming={false} onDecision={onDecision} onShowAnswer={onShowAnswer} {...props} />);
  return { onDecision, onShowAnswer, card: screen.getByRole('group', { name: `Ресерч: ${GOAL}` }) };
}

function buttonNames(card: HTMLElement): string[] {
  return within(card)
    .queryAllByRole('button')
    .map((button) => button.textContent ?? '');
}

afterEach(() => {
  vi.useRealTimers();
});

// AC-19.2 (draw), AC-19.3, AC-19.4, AC-21.1 (draw), MC-5…MC-16, MC-29, MC-14: every state of DR-03 draws its status, title, rows,
// buttons and message; a pending decision or an error survives only while the launch is still in the state it was made from.
describe('ResearchCard — states of DR-03', () => {
  const PROPOSED = { mode: 'proposal', state: 'proposed' } as const;
  it.each<CardCase & { status: string; title: boolean; buttons: string[]; message: string | null; alert: string | null; answerLink: boolean }>([
    { name: 'proposal', launch: PROPOSED, status: 'Ждёт подтверждения', title: true, buttons: ['Запустить', 'Не нужно'], message: null, alert: null, answerLink: false },
    { name: 'launching', launch: PROPOSED, pendingDecision: 'confirm', status: 'Ждёт подтверждения', title: true, buttons: ['Запускаем…', 'Не нужно'], message: null, alert: null, answerLink: false },
    { name: 'declining', launch: PROPOSED, pendingDecision: 'decline', status: 'Ждёт подтверждения', title: true, buttons: ['Запустить', 'Отклоняем…'], message: null, alert: null, answerLink: false },
    { name: 'launch error', launch: PROPOSED, decisionError: 'launch_failed', status: 'Ждёт подтверждения', title: true, buttons: ['Запустить', 'Не нужно'], message: null, alert: 'Не удалось запустить ресерч. Попробуйте ещё раз.', answerLink: false },
    { name: 'decline error', launch: PROPOSED, decisionError: 'decline_failed', status: 'Ждёт подтверждения', title: true, buttons: ['Запустить', 'Не нужно'], message: null, alert: 'Не удалось отклонить предложение. Попробуйте ещё раз.', answerLink: false },
    { name: 'running', launch: { state: 'running' }, status: 'Ресерч идёт', title: false, buttons: ['Остановить'], message: null, alert: null, answerLink: false },
    { name: 'stopping', launch: { state: 'running' }, pendingDecision: 'stop', status: 'Останавливаем…', title: false, buttons: [], message: null, alert: null, answerLink: false },
    { name: 'stop error', launch: { state: 'running' }, decisionError: 'stop_failed', status: 'Ресерч идёт', title: false, buttons: ['Остановить'], message: null, alert: 'Не удалось остановить ресерч. Попробуйте ещё раз.', answerLink: false },
    { name: 'completed', launch: { state: 'completed', answerMessageId: 'm-answer' }, status: 'Ресерч завершён', title: false, buttons: [], message: null, alert: null, answerLink: true },
    { name: 'completed, answer written again', launch: { state: 'completed', answerMessageId: null, answerPending: true }, status: 'Ресерч завершён', title: false, buttons: [], message: null, alert: null, answerLink: false },
    { name: 'failed', launch: { state: 'failed' }, status: 'Ресерч не удался', title: false, buttons: [], message: 'Ответа не будет. Чтобы попробовать снова, отправьте вопрос в режиме „Глубокий ресерч“.', alert: null, answerLink: false },
    { name: 'stopped', launch: { state: 'stopped' }, status: 'Ресерч остановлен', title: false, buttons: [], message: 'Ответа не будет.', alert: null, answerLink: false },
    { name: 'not launched, declined', launch: { mode: 'proposal', state: 'not_launched', notLaunchedReason: 'declined' }, status: 'Ресерч не запущен', title: false, buttons: [], message: 'Вы отказались.', alert: null, answerLink: false },
    { name: 'not launched, superseded', launch: { mode: 'proposal', state: 'not_launched', notLaunchedReason: 'superseded' }, status: 'Ресерч не запущен', title: false, buttons: [], message: 'Беседа продолжилась без него.', alert: null, answerLink: false },
    // A stale card: the decision was settled elsewhere, so the card shows the settled state with no error line.
    { name: 'launching, already running', launch: { mode: 'proposal', state: 'running' }, pendingDecision: 'confirm', status: 'Ресерч идёт', title: false, buttons: ['Остановить'], message: null, alert: null, answerLink: false },
    { name: 'launch error, already running', launch: { mode: 'proposal', state: 'running' }, decisionError: 'launch_failed', status: 'Ресерч идёт', title: false, buttons: ['Остановить'], message: null, alert: null, answerLink: false },
    { name: 'stopping, already completed', launch: { state: 'completed', answerMessageId: 'm-answer' }, pendingDecision: 'stop', status: 'Ресерч завершён', title: false, buttons: [], message: null, alert: null, answerLink: true },
  ])('$name', ({ launch, pendingDecision, decisionError, status, title, buttons, message, alert, answerLink }) => {
    const { card } = renderCard({ launch: researchLaunchView({ launchKey: 'k1', ...launch }), pendingDecision, decisionError });

    expect(within(card).getByText(status)).toBeInTheDocument();
    expect(within(card).queryByRole('heading', { name: 'Запустить глубокий ресерч?' }) !== null).toBe(title);
    expect(within(card).getByText(GOAL)).toBeInTheDocument();
    expect(within(card).getByText('до 200 000 токенов')).toBeInTheDocument();
    expect(buttonNames(card)).toEqual(buttons);
    if (message !== null) expect(within(card).getByText(message)).toBeInTheDocument();
    if (alert === null) expect(within(card).queryByRole('alert')).toBeNull();
    else expect(within(card).getByRole('alert')).toHaveTextContent(alert);
    expect(within(card).queryByRole('link', { name: 'К ответу' }) !== null).toBe(answerLink);
  });

  it.each([
    { name: 'today', createdAt: '2026-10-30T13:32:00.000Z', expected: '14:32' },
    { name: 'another day', createdAt: '2026-10-28T13:05:00.000Z', expected: '28 окт., 14:05' },
  ])('time of the launch, $name', ({ createdAt, expected }) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-30T16:00:00.000Z'));
    const { card } = renderCard({ launch: researchLaunchView({ launchKey: 'k1', createdAt }) });
    expect(within(card).getByText(expected).tagName).toBe('TIME');
  });
});

// AC-27.1, AC-27.2, AC-27.4, DC-8 (draw): MC-31 under the budget in every state when the launch's mode is `model_knowledge`, as ordinary text; never with sources.
describe('ResearchCard — MC-31 by the launch mode', () => {
  const STATES: CardCase[] = [
    { name: 'proposal', launch: { mode: 'proposal', state: 'proposed' } },
    { name: 'launching', launch: { mode: 'proposal', state: 'proposed' }, pendingDecision: 'confirm' },
    { name: 'running', launch: { state: 'running' } },
    { name: 'completed', launch: { state: 'completed', answerMessageId: 'm-answer' } },
    { name: 'not launched', launch: { mode: 'proposal', state: 'not_launched', notLaunchedReason: 'superseded' } },
    { name: 'failed', launch: { state: 'failed' } },
    { name: 'stopped', launch: { state: 'stopped' } },
  ];

  it.each(STATES)('model_knowledge, $name: MC-31 follows the budget as plain text', ({ launch, pendingDecision }) => {
    const { card } = renderCard({ launch: researchLaunchView({ launchKey: 'k1', sourceMode: 'model_knowledge', ...launch }), pendingDecision });
    const warning = within(card).getByText(MC_31);
    expect(warning.closest('[role="alert"],[role="status"],[aria-hidden="true"]')).toBeNull();
    const budget = within(card).getByText('до 200 000 токенов');
    expect(budget.compareDocumentPosition(warning) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('sources: no MC-31', () => {
    const { card } = renderCard({ launch: researchLaunchView({ launchKey: 'k1', sourceMode: 'sources', state: 'running' }) });
    expect(within(card).queryByText(MC_31)).toBeNull();
  });
});

// U-3 — DC-7, DC-9 and DC-10 (card side), UC-E10, Invariants 1 and 2 (design-web, Contract «ResearchCard»; UXRD KD-5, KD-6; deep-research
// UXRD KD-8, MC-30). Catches: «Остановить» dead while a reply streams; MC-4 as an alert; MC-4 surviving a press or a change of state.
describe('ResearchCard — U-3: with replyStreaming only «Запустить» and «Не нужно» are unavailable', () => {
  const CONFIRMATION = 'Остановить ресерч? Ответа не будет, потраченный бюджет не вернётся.';

  it('«Запустить» and «Не нужно» stay in the Tab order, are aria-disabled, read MC-30 and do nothing', async () => {
    const user = userEvent.setup();
    const { onDecision } = renderCard({ launch: researchLaunchView({ launchKey: 'k1', mode: 'proposal', state: 'proposed' }), replyStreaming: true });

    for (const name of ['Запустить', 'Не нужно']) {
      await user.tab();
      const target = screen.getByRole('button', { name });
      expect(target).toHaveFocus();
      expect(target).toHaveAttribute('aria-disabled', 'true');
      expect(target).toHaveAccessibleDescription(MC_30);
      await user.click(target);
    }
    expect(onDecision).not.toHaveBeenCalled();
  });

  type User = ReturnType<typeof userEvent.setup>;
  it.each<{ name: string; leave: (user: User) => Promise<void>; decision: ResearchCardAction | null }>([
    { name: '«Продолжить» returns the row and focus to «Остановить»', leave: (user) => user.click(screen.getByRole('button', { name: 'Продолжить' })), decision: null },
    { name: 'Esc returns the row and focus to «Остановить»', leave: (user) => user.keyboard('{Escape}'), decision: null },
    { name: 'the confirmed «Остановить» reports stop and focuses the card', leave: (user) => user.click(screen.getAllByRole('button', { name: 'Остановить' })[0]), decision: 'stop' },
  ])('$name', async ({ leave, decision }) => {
    const user = userEvent.setup();
    const { onDecision, card } = renderCard({ launch: researchLaunchView({ launchKey: 'k1', state: 'running' }), replyStreaming: true });
    const stop = screen.getByRole('button', { name: 'Остановить' });
    expect(stop).not.toHaveAttribute('aria-disabled');
    expect(stop).not.toHaveAccessibleDescription();

    await user.click(stop);
    expect(screen.getByText(CONFIRMATION)).toBeInTheDocument();
    for (const button of within(card).getAllByRole('button')) {
      expect(button).not.toHaveAttribute('aria-disabled');
      expect(button).not.toHaveAccessibleDescription();
    }
    expect(screen.getByRole('button', { name: 'Продолжить' })).toHaveFocus();
    await leave(user);

    if (decision === null) {
      expect(screen.queryByText(CONFIRMATION)).toBeNull();
      expect(screen.getByRole('button', { name: 'Остановить' })).toHaveFocus();
      expect(onDecision).not.toHaveBeenCalled();
    } else {
      expect(onDecision).toHaveBeenCalledExactlyOnceWith(decision);
      expect(card).toHaveFocus();
    }
  });

  it('the confirmed «Остановить» still works when a reply starts streaming while the confirmation is open', async () => {
    const user = userEvent.setup();
    const onDecision = vi.fn();
    const launch = researchLaunchView({ launchKey: 'k1', state: 'running' });
    const { rerender } = render(<ResearchCard launch={launch} replyStreaming={false} onDecision={onDecision} />);
    await user.click(screen.getByRole('button', { name: 'Остановить' }));
    rerender(<ResearchCard launch={launch} replyStreaming onDecision={onDecision} />);

    const confirm = screen.getAllByRole('button', { name: 'Остановить' })[0];
    expect(confirm).not.toHaveAttribute('aria-disabled');
    expect(confirm).not.toHaveAccessibleDescription();
    await user.click(confirm);
    expect(onDecision).toHaveBeenCalledExactlyOnceWith('stop');
  });

  // The line after a stop: MC-4 politely (no alert) and gone after the row's «Остановить» until a new value; MC-16 an alert, as before.
  it.each([
    { error: 'still_launching', text: MC_4, alert: false, survivesPress: false },
    { error: 'stop_failed', text: MC_16, alert: true, survivesPress: true },
  ] as const)('$error: the line, its role, the press and a new value', async ({ error, text, alert, survivesPress }) => {
    const user = userEvent.setup();
    const launch = researchLaunchView({ launchKey: 'k1', state: 'running' });
    const card = (decisionError: ResearchCardDecisionError | null) => (
      <ResearchCard launch={launch} decisionError={decisionError} replyStreaming onDecision={vi.fn()} />
    );
    const { rerender } = render(card(error));

    expect(screen.getByText(text)).toBeInTheDocument();
    expect(screen.getByText(text).closest('[role="alert"]') !== null).toBe(alert);

    await user.click(screen.getByRole('button', { name: 'Остановить' }));
    await user.click(screen.getByRole('button', { name: 'Продолжить' }));
    expect(screen.queryByText(text) !== null).toBe(survivesPress);
    rerender(card(error));
    expect(screen.queryByText(text) !== null).toBe(survivesPress);

    rerender(card(null));
    rerender(card(error));
    expect(screen.getByText(text)).toBeInTheDocument();
  });

  it.each<CardCase>([
    { name: 'still_launching, proposal', launch: { mode: 'proposal', state: 'proposed' }, decisionError: 'still_launching' },
    { name: 'still_launching, stopping', launch: { state: 'running' }, pendingDecision: 'stop', decisionError: 'still_launching' },
    { name: 'still_launching, completed', launch: { state: 'completed', answerMessageId: 'm-answer' }, decisionError: 'still_launching' },
    { name: 'still_launching, stopped', launch: { state: 'stopped' }, decisionError: 'still_launching' },
    { name: 'stop_failed, stopping', launch: { state: 'running' }, pendingDecision: 'stop', decisionError: 'stop_failed' },
    { name: 'stop_failed, stopped', launch: { state: 'stopped' }, decisionError: 'stop_failed' },
  ])('$name: no line outside «Идёт»', ({ launch, pendingDecision, decisionError }) => {
    const { card } = renderCard({ launch: researchLaunchView({ launchKey: 'k1', ...launch }), pendingDecision, decisionError, replyStreaming: true });
    expect(within(card).queryByText(MC_4)).toBeNull();
    expect(within(card).queryByText(MC_16)).toBeNull();
  });
});

// AC-19.3, AC-19.4, AC-21.1 (card side), KD-3, MC-9: a decision reports its action and moves focus to the card; «Остановить» asks first and sends nothing on «Продолжить» or Esc.
describe('ResearchCard — decisions and the stop confirmation', () => {
  it.each([
    { button: 'Запустить', action: 'confirm' },
    { button: 'Не нужно', action: 'decline' },
  ] as const)('«$button» reports $action and focuses the card', async ({ button, action }) => {
    const user = userEvent.setup();
    const { onDecision, card } = renderCard({ launch: researchLaunchView({ launchKey: 'k1', mode: 'proposal', state: 'proposed' }) });
    await user.click(screen.getByRole('button', { name: button }));
    expect(onDecision).toHaveBeenCalledExactlyOnceWith(action);
    expect(card).toHaveFocus();
  });

  it.each([
    { name: '«Продолжить»', leave: async (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByRole('button', { name: 'Продолжить' })) },
    { name: 'Esc', leave: async (user: ReturnType<typeof userEvent.setup>) => user.keyboard('{Escape}') },
  ])('«Остановить» asks, focuses «Продолжить»; $name returns to «Остановить» and sends nothing', async ({ leave }) => {
    const user = userEvent.setup();
    const { onDecision } = renderCard({ launch: researchLaunchView({ launchKey: 'k1', state: 'running' }) });
    await user.click(screen.getByRole('button', { name: 'Остановить' }));

    expect(screen.getByText('Остановить ресерч? Ответа не будет, потраченный бюджет не вернётся.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Продолжить' })).toHaveFocus();
    await leave(user);

    expect(screen.queryByText('Остановить ресерч? Ответа не будет, потраченный бюджет не вернётся.')).toBeNull();
    expect(screen.getByRole('button', { name: 'Остановить' })).toHaveFocus();
    expect(onDecision).not.toHaveBeenCalled();
  });

  it('the confirmed «Остановить» reports stop and focuses the card', async () => {
    const user = userEvent.setup();
    const { onDecision, card } = renderCard({ launch: researchLaunchView({ launchKey: 'k1', state: 'running' }) });
    await user.click(screen.getByRole('button', { name: 'Остановить' }));
    await user.click(screen.getAllByRole('button', { name: 'Остановить' })[0]);
    expect(onDecision).toHaveBeenCalledExactlyOnceWith('stop');
    expect(card).toHaveFocus();
  });

  it('«К ответу» points at the answer message and hands its id over', async () => {
    const user = userEvent.setup();
    const { onShowAnswer } = renderCard({ launch: researchLaunchView({ launchKey: 'k1', state: 'completed', answerMessageId: 'm-answer' }) });
    const link = screen.getByRole('link', { name: 'К ответу' });
    expect(link).toHaveAttribute('href', '#m-answer');
    await user.click(link);
    expect(onShowAnswer).toHaveBeenCalledExactlyOnceWith('m-answer');
  });
});
