import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  AssistantRuntimeProvider,
  useLocalRuntime,
  type ChatModelAdapter,
  type ThreadMessageLike,
} from '@assistant-ui/react';
import type { ResearchLaunchViewState } from '@agent-os/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Thread, type ThreadComponents } from '@/components/assistant-ui/elements/thread.aui';
import { ThreadNotice } from '@/components/shell/thread-notice';
import { TooltipProvider } from '@/components/ui/tooltip';
import { researchLaunchView } from '@/test/fixtures';

const flags = vi.hoisted(() => ({ regenerateAfterError: true }));

// Only the emergency switch is replaced; the API origin and the rest of the config stay real.
vi.mock('@/lib/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/config')>();
  return {
    ...actual,
    get regenerateAfterError() {
      return flags.regenerateAfterError;
    },
  };
});

const BLOCK_TEXT = 'Не удалось получить ответ. Попробуйте перегенерировать.';
const ROLLBACK_TEXT = 'Не удалось получить ответ.';
const PROVIDER_ERROR = 'Upstream model provider exploded: rate limit exceeded';
const REGENERATE = 'Перегенерировать';

/** Throws on the listed calls (1-based) with an English provider error; answers «Новый ответ» otherwise. */
function failingAdapter(failingCalls: readonly number[], partial?: string): ChatModelAdapter & { calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    async *run() {
      calls += 1;
      if (failingCalls.includes(calls)) {
        if (partial !== undefined) yield { content: [{ type: 'text', text: partial }] };
        throw new Error(PROVIDER_ERROR);
      }
      yield { content: [{ type: 'text', text: 'Новый ответ' }] };
    },
  };
}

function Harness({
  adapter,
  initialMessages,
  components,
}: {
  adapter: ChatModelAdapter;
  initialMessages: readonly ThreadMessageLike[];
  components: ThreadComponents | undefined;
}) {
  const runtime = useLocalRuntime(adapter, { initialMessages });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <TooltipProvider>
        <Thread autoFocus={false} components={components} />
      </TooltipProvider>
    </AssistantRuntimeProvider>
  );
}

function renderThread({
  adapter = failingAdapter([]),
  initialMessages = [],
  components,
}: {
  adapter?: ChatModelAdapter;
  initialMessages?: readonly ThreadMessageLike[];
  components?: ThreadComponents;
}) {
  return render(<Harness adapter={adapter} initialMessages={initialMessages} components={components} />);
}

async function send(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.type(screen.getByRole('textbox', { name: 'Сообщение' }), `${text}{Enter}`);
}

const assistantRoots = (container: HTMLElement) =>
  Array.from(container.querySelectorAll<HTMLElement>('[data-role="assistant"]'));

afterEach(() => {
  flags.regenerateAfterError = true;
});

describe('MessageError — TH-08 block of a failed reply (AC-08.5, AC-08.5a, AC-08.5c, AC-08.5d; D-14)', () => {
  it('case 1 (AC-08.5): a failed reply shows the fixed text in an alert under it, never the provider error', async () => {
    const user = userEvent.setup();
    const { container } = renderThread({ adapter: failingAdapter([1], 'Частичный') });

    await send(user, 'Вопрос');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(BLOCK_TEXT);
    expect(alert.closest('[data-role="assistant"]')).toBe(assistantRoots(container)[0]);
    expect(screen.getByText('Частичный')).toBeInTheDocument();
    expect(container).not.toHaveTextContent(/rate limit|exploded|provider/i);
  });

  it('case 1a (TH-10 «Пустой ответ»): an error before the first token leaves only the error block — no row, no «Копировать»', async () => {
    const user = userEvent.setup();
    const { container } = renderThread({ adapter: failingAdapter([1]) });

    await send(user, 'Вопрос');

    const alert = await screen.findByRole('alert');
    const reply = assistantRoots(container)[0];
    expect(reply).toContainElement(alert);
    expect(reply.querySelector('[data-slot="aui_assistant-message-content"]')).toBeNull();
    expect(reply.querySelector('[data-slot="aui_assistant-message-footer"]')).toBeNull();
    expect(within(reply).queryByRole('button', { name: 'Копировать' })).toBeNull();
    expect(reply).toHaveTextContent(BLOCK_TEXT);
  });

  it('case 2 (AC-08.5a): «Перегенерировать» sits inside the block, described by its text; the action bar has none', async () => {
    const user = userEvent.setup();
    const { container } = renderThread({ adapter: failingAdapter([1], 'Частичный') });

    await send(user, 'Вопрос');

    const alert = await screen.findByRole('alert');
    const block = alert.closest<HTMLElement>('[data-slot="message-error"]');
    if (block === null) throw new Error('the alert is not inside [data-slot="message-error"]');
    const button = within(block).getByRole('button', { name: REGENERATE });
    expect(alert.id).not.toBe('');
    expect(button).toHaveAttribute('aria-describedby', alert.id);
    expect(button).toHaveAccessibleDescription(BLOCK_TEXT);
    expect(screen.getAllByRole('button', { name: REGENERATE })).toEqual([button]);

    const footer = assistantRoots(container)[0].querySelector<HTMLElement>('[data-slot="aui_assistant-message-footer"]');
    if (footer === null) throw new Error('the failed reply with partial text has no footer');
    expect(within(footer).getByRole('button', { name: 'Копировать' })).toBeInTheDocument();
    expect(within(footer).queryByRole('button', { name: REGENERATE })).toBeNull();
    // Tab order inside the reply: content → «Перегенерировать» → «Копировать» (UXRD 7.3).
    expect(button.compareDocumentPosition(within(footer).getByRole('button', { name: 'Копировать' }))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it.each([
    { key: 'Enter', keys: '{Enter}' },
    { key: 'Space', keys: ' ' },
  ])('case 3 (AC-08.5a): $key on the focused «Перегенерировать» regenerates; one reply, no block, focus in the composer', async ({ keys }) => {
    const user = userEvent.setup();
    const adapter = failingAdapter([1], 'Частичный');
    const { container } = renderThread({ adapter });

    await send(user, 'Вопрос');
    const button = await screen.findByRole('button', { name: REGENERATE });
    button.focus();
    await user.keyboard(keys);

    expect(await screen.findByText('Новый ответ')).toBeInTheDocument();
    expect(adapter.calls()).toBe(2);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: REGENERATE })).toBeNull();
    expect(container.querySelector('[data-slot="message-error"]')).toBeNull();
    expect(assistantRoots(container)).toHaveLength(1);
    expect(screen.queryByText('Частичный')).toBeNull();
    expect(container).not.toHaveTextContent(/\d+\s*\/\s*\d+/);
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Сообщение' })).toHaveFocus());
  });

  it('case 3a (AC-08.5a): only the last reply offers «Перегенерировать»', async () => {
    const user = userEvent.setup();
    const { container } = renderThread({
      adapter: failingAdapter([1]),
      initialMessages: [
        { id: 'u1', role: 'user', content: 'Первый вопрос' },
        {
          id: 'a1',
          role: 'assistant',
          content: 'Первый ответ',
          status: { type: 'incomplete', reason: 'error', error: PROVIDER_ERROR },
        },
      ],
    });
    const earlier = assistantRoots(container)[0];
    expect(within(earlier).getByRole('alert')).toHaveTextContent(BLOCK_TEXT);
    expect(within(earlier).getByRole('button', { name: REGENERATE })).toBeInTheDocument();

    await send(user, 'Второй вопрос');
    await waitFor(() => expect(assistantRoots(container)).toHaveLength(2));
    const last = assistantRoots(container)[1];
    await waitFor(() => expect(within(last).getByRole('button', { name: REGENERATE })).toBeInTheDocument());

    expect(within(earlier).queryByRole('button', { name: REGENERATE })).toBeNull();
    expect(screen.getAllByRole('button', { name: REGENERATE })).toHaveLength(1);
  });

  it('case 4 (AC-08.5d): with regenerateAfterError off the block reads only «Не удалось получить ответ.», no button, no description link', async () => {
    flags.regenerateAfterError = false;
    const user = userEvent.setup();
    const { container } = renderThread({ adapter: failingAdapter([1], 'Частичный') });

    await send(user, 'Вопрос');

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(ROLLBACK_TEXT);
    expect(container).not.toHaveTextContent('Попробуйте перегенерировать');
    expect(screen.queryByRole('button', { name: REGENERATE })).toBeNull();
    const block = alert.closest<HTMLElement>('[data-slot="message-error"]');
    if (block === null) throw new Error('the alert is not inside [data-slot="message-error"]');
    expect(block.querySelector('[aria-describedby]')).toBeNull();
  });

  it('case 5 (AC-08.5c): a restored reply (no error status, as after F5) shows its partial text without the block or the button', () => {
    const { container } = renderThread({
      initialMessages: [
        { id: 'u1', role: 'user', content: 'Вопрос' },
        { id: 'a1', role: 'assistant', content: 'Частичный' },
      ],
    });

    expect(screen.getByText('Частичный')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: REGENERATE })).toBeNull();
    expect(container.querySelector('[data-slot="message-error"]')).toBeNull();
    expect(within(assistantRoots(container)[0]).getByRole('button', { name: 'Копировать' })).toBeInTheDocument();
  });
});

describe('MessageError — DeletedNotice slot (AC-08.5e; UXRD E-8, TH-07 «Deleted while open»)', () => {
  it('case 6: with the slot set the failed reply shows «Беседа удалена» instead of the block, and the composer is gone', async () => {
    const user = userEvent.setup();
    const onNewChat = vi.fn();
    const components: ThreadComponents = {
      DeletedNotice: () => <ThreadNotice variant="deleted" onNewChat={onNewChat} />,
    };
    const { container } = renderThread({
      components,
      initialMessages: [
        { id: 'u1', role: 'user', content: 'Ещё вопрос' },
        {
          id: 'a1',
          role: 'assistant',
          content: [],
          status: { type: 'incomplete', reason: 'error', error: 'Thread not found' },
        },
      ],
    });

    const notice = screen.getByText('Беседа удалена');
    expect(screen.getByText('Ещё вопрос').compareDocumentPosition(notice)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(screen.getByRole('alert')).toHaveTextContent('Её удалили в другой вкладке или окне.');
    expect(container).not.toHaveTextContent(/Не удалось получить ответ|Thread not found/);
    expect(screen.queryByRole('button', { name: REGENERATE })).toBeNull();
    expect(container.querySelector('[data-slot="message-error"]')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Новый чат' }));
    expect(onNewChat).toHaveBeenCalledOnce();
  });
});

describe('MessageError — MC-21 over «Перегенерировать» of a reply with a research card (deep-research AC-22.2, UXRD KD-7)', () => {
  const MC_21 = 'Перегенерация остановит ресерч из этого ответа.';
  const GOAL = 'Почему выросли расходы на облако';

  /** A failed last reply whose only part is a `deepResearch` call with its result. */
  const failedReplyWithCall = ({ toolCallId, launchKey, state }: { toolCallId: string; launchKey: string; state: ResearchLaunchViewState }) => {
    const launch = researchLaunchView({
      launchKey,
      state,
      mode: 'proposal',
      notLaunchedReason: state === 'not_launched' ? 'declined' : null,
      answerMessageId: state === 'completed' ? 'research-answer-inv-1' : null,
    });
    const messages: ThreadMessageLike[] = [
      { id: 'u1', role: 'user', content: 'Вопрос' },
      {
        id: 'a1',
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId, toolName: 'deepResearch', args: { goal: GOAL }, result: { launch } }],
        status: { type: 'incomplete', reason: 'error', error: PROVIDER_ERROR },
      },
    ];
    return messages;
  };

  // The rule: the card the reply carries is `proposed` or `running` — a regeneration would stop it (AC-22.2).
  it.each<{ name: string; state: ResearchLaunchViewState; ownCall: boolean; warned: boolean }>([
    { name: 'a proposal', state: 'proposed', ownCall: true, warned: true },
    { name: 'a running research', state: 'running', ownCall: true, warned: true },
    { name: 'a completed research', state: 'completed', ownCall: true, warned: false },
    { name: 'a failed research', state: 'failed', ownCall: true, warned: false },
    { name: 'a stopped research', state: 'stopped', ownCall: true, warned: false },
    { name: 'a declined proposal', state: 'not_launched', ownCall: true, warned: false },
    { name: 'a call returning another launch (a decision turn)', state: 'running', ownCall: false, warned: false },
  ])('the block over «Перегенерировать» of a reply carrying $name shows MC-21: $warned', ({ state, ownCall, warned }) => {
    renderThread({
      initialMessages: failedReplyWithCall({ toolCallId: 'call-1', launchKey: ownCall ? 'call-1' : 'call-0', state }),
    });

    const button = screen.getByRole('button', { name: REGENERATE });
    expect(screen.queryByText(MC_21) !== null).toBe(warned);
    if (warned) {
      const block = button.closest<HTMLElement>('[data-slot="message-error"]');
      if (block === null) throw new Error('«Перегенерировать» is not inside [data-slot="message-error"]');
      expect(within(block).getByText(MC_21).compareDocumentPosition(button)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
      expect(button).toHaveAccessibleDescription(`${BLOCK_TEXT} ${MC_21}`);
    } else {
      expect(button).toHaveAccessibleDescription(BLOCK_TEXT);
    }
  });

  it('a plain failed reply shows no MC-21', () => {
    renderThread({
      initialMessages: [
        { id: 'u1', role: 'user', content: 'Вопрос' },
        { id: 'a1', role: 'assistant', content: 'Частичный', status: { type: 'incomplete', reason: 'error', error: PROVIDER_ERROR } },
      ],
    });

    expect(screen.getByRole('button', { name: REGENERATE })).toBeInTheDocument();
    expect(screen.queryByText(MC_21)).toBeNull();
  });
});
