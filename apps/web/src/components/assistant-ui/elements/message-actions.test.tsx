import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  AssistantRuntimeProvider,
  useLocalRuntime,
  type ChatModelAdapter,
  type ThreadMessageLike,
} from '@assistant-ui/react';
import { describe, expect, it, vi } from 'vitest';
import { Thread } from '@/components/assistant-ui/elements/thread.aui';
import { TooltipProvider } from '@/components/ui/tooltip';

const COPY = 'Копировать';

const TWO_EXCHANGES: readonly ThreadMessageLike[] = [
  { id: 'u1', role: 'user', content: 'Первый вопрос' },
  { id: 'a1', role: 'assistant', content: 'Первый ответ' },
  { id: 'u2', role: 'user', content: 'Второй вопрос' },
  { id: 'a2', role: 'assistant', content: 'Второй ответ' },
];

const IDLE_ADAPTER: ChatModelAdapter = {
  async run() {
    return { content: [{ type: 'text', text: 'Ответ' }] };
  },
};

function Harness({
  adapter,
  initialMessages,
}: {
  adapter: ChatModelAdapter;
  initialMessages: readonly ThreadMessageLike[];
}) {
  const runtime = useLocalRuntime(adapter, { initialMessages });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <TooltipProvider>
        <Thread autoFocus={false} />
      </TooltipProvider>
    </AssistantRuntimeProvider>
  );
}

function renderThread(initialMessages: readonly ThreadMessageLike[], adapter: ChatModelAdapter = IDLE_ADAPTER) {
  return render(<Harness adapter={adapter} initialMessages={initialMessages} />);
}

/** Message roots of the feed in document order. */
function messageRoots(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-role="user"], [data-role="assistant"]'));
}

/** The message root (role + position among the feed's roots) that holds the element. */
function ownerOf(element: Element, container: HTMLElement): string {
  const root = element.closest<HTMLElement>('[data-role]');
  if (root === null) return 'outside';
  return `${root.dataset.role}#${messageRoots(container).indexOf(root)}`;
}

/** Owners of the «Копировать» buttons the Tab key reaches, in Tab order, until focus reaches the composer. */
async function copyTabStops(user: ReturnType<typeof userEvent.setup>, container: HTMLElement): Promise<string[]> {
  const stops: string[] = [];
  const composer = screen.getByRole('textbox', { name: 'Сообщение' });
  for (let step = 0; step < 40 && document.activeElement !== composer; step += 1) {
    await user.tab();
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.matches('button') && active.textContent?.includes(COPY)) {
      stops.push(ownerOf(active, container));
    }
  }
  return stops;
}

type Gate = { open: () => void; wait: Promise<void> };

function createGate(): Gate {
  let open = () => {};
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, wait };
}

describe('Message action bar — only «Копировать», always reachable (AC-08.6; D-13, TH-10)', () => {
  it('every message has «Копировать» without hovering; edit, reload, more, export and the branch picker are gone', async () => {
    const user = userEvent.setup();
    const { container } = renderThread(TWO_EXCHANGES);

    const roots = messageRoots(container);
    expect(roots.map((root) => root.dataset.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    for (const root of roots) {
      expect(within(root).getAllByRole('button', { name: COPY })).toHaveLength(1);
      expect(within(root).getAllByRole('button')).toHaveLength(1);
    }
    for (const forbidden of [/edit/i, /изменить/i, /refresh/i, /перегенерировать/i, /more/i, /ещё/i, /export/i, /previous/i, /next/i]) {
      expect(screen.queryByRole('button', { name: forbidden })).toBeNull();
    }
    expect(container).not.toHaveTextContent(/\d+\s*\/\s*\d+/);

    await user.dblClick(screen.getByText('Первый вопрос'));
    expect(screen.getAllByRole('textbox')).toEqual([screen.getByRole('textbox', { name: 'Сообщение' })]);
    expect(screen.getByText('Первый вопрос')).toBeInTheDocument();
  });

  it('Tab reaches «Копировать» of the first user message, then of the first reply, then the rest in feed order', async () => {
    const user = userEvent.setup();
    const { container } = renderThread(TWO_EXCHANGES);

    expect(await copyTabStops(user, container)).toEqual(['user#0', 'assistant#1', 'user#2', 'assistant#3']);
  });

  it('during a run the reply being generated has no «Копировать»; earlier messages keep theirs in Tab order; it appears once the run ends', async () => {
    const user = userEvent.setup();
    const gate = createGate();
    const adapter: ChatModelAdapter = {
      async *run() {
        yield { content: [{ type: 'text', text: 'Частичный' }] };
        await gate.wait;
        yield { content: [{ type: 'text', text: 'Частичный ответ' }] };
      },
    };
    const { container } = renderThread(TWO_EXCHANGES.slice(0, 2), adapter);

    await user.type(screen.getByRole('textbox', { name: 'Сообщение' }), 'Новый вопрос{Enter}');
    expect(await screen.findByText('Частичный')).toBeInTheDocument();

    const running = messageRoots(container);
    expect(running.map((root) => root.dataset.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(within(running[0]).getByRole('button', { name: COPY })).toBeInTheDocument();
    expect(within(running[1]).getByRole('button', { name: COPY })).toBeInTheDocument();
    expect(within(running[2]).getByRole('button', { name: COPY })).toBeInTheDocument();
    expect(within(running[3]).queryByRole('button', { name: COPY })).toBeNull();

    screen.getByRole('textbox', { name: 'Сообщение' }).blur();
    expect(await copyTabStops(user, container)).toEqual(['user#0', 'assistant#1', 'user#2']);

    await act(async () => {
      gate.open();
    });
    expect(await screen.findByText('Частичный ответ')).toBeInTheDocument();
    await waitFor(() => {
      expect(within(messageRoots(container)[3]).getByRole('button', { name: COPY })).toBeInTheDocument();
    });
  });

  it.each([
    { name: 'reply', index: 1, text: 'Первый ответ' },
    { name: 'user message', index: 0, text: 'Первый вопрос' },
  ])('«Копировать» writes the $name text to the clipboard and announces «Скопировано»', async ({ index, text }) => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText');
    const { container } = renderThread(TWO_EXCHANGES);
    const message = messageRoots(container)[index];

    const status = within(message).getByRole('status');
    expect(status).toHaveTextContent('');

    await user.click(within(message).getByRole('button', { name: COPY }));

    expect(writeText).toHaveBeenCalledWith(text);
    await waitFor(() => expect(status).toHaveTextContent('Скопировано'));
  });
});

/** Whether the action bar holding the button shows at rest; earlier messages hide it by opacity only (TH-10). */
function showsAtRest(button: HTMLElement): boolean {
  const bar = button.closest('[class*="action-bar-root"]');
  return bar !== null && !bar.classList.contains('opacity-0');
}

describe('Message action bar — the last visible message (web-shell KD-2; design-chat-entry DC-7)', () => {
  it('a reply followed only by a hidden decision pair keeps «Копировать» visible at rest; the pair is not drawn', () => {
    const { container } = renderThread([
      { id: 'u1', role: 'user', content: 'Первый вопрос' },
      { id: 'a1', role: 'assistant', content: 'Первый ответ' },
      {
        id: 'u2',
        role: 'user',
        content: 'Запустить',
        metadata: { custom: { researchDecision: { action: 'confirm', launchKey: 'call-1' } } },
      },
      {
        id: 'a2',
        role: 'assistant',
        content: 'Реплика решения',
        metadata: { custom: { researchDecisionReply: { launchKey: 'call-1' } } },
      },
    ]);

    const roots = messageRoots(container);
    expect(roots.map((root) => root.dataset.role)).toEqual(['user', 'assistant']);
    expect(screen.queryByText('Запустить')).toBeNull();
    expect(screen.queryByText('Реплика решения')).toBeNull();
    expect(showsAtRest(within(roots[1]).getByRole('button', { name: COPY }))).toBe(true);
    expect(showsAtRest(within(roots[0]).getByRole('button', { name: COPY }))).toBe(false);
  });
});

describe('Message action bar — replies without text (TH-10 «Ответ без текста», «Пустой ответ»)', () => {
  it('a reply with only a tool call renders the call but has no «Копировать»', () => {
    const { container } = renderThread([
      { id: 'u1', role: 'user', content: 'Найди' },
      {
        id: 'a1',
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'search', args: { q: 'x' }, result: { ok: true } }],
      },
      { id: 'u2', role: 'user', content: 'Ещё' },
      { id: 'a2', role: 'assistant', content: '   ' },
    ]);

    const roots = messageRoots(container);
    expect(within(roots[1]).getByRole('button', { name: /1 вызов инструмента/ })).toBeInTheDocument();
    expect(within(roots[1]).queryByRole('button', { name: COPY })).toBeNull();
    expect(within(roots[3]).queryByRole('button', { name: COPY })).toBeNull();
    expect(within(roots[0]).getByRole('button', { name: COPY })).toBeInTheDocument();
  });

  it('a reply with only reasoning renders the reasoning but has no «Копировать»', () => {
    const { container } = renderThread([
      { id: 'u1', role: 'user', content: 'Подумай' },
      { id: 'a1', role: 'assistant', content: [{ type: 'reasoning', text: 'Размышляю' }] },
    ]);

    const reply = messageRoots(container)[1];
    expect(within(reply).getByRole('button', { name: /Reasoning|Рассужд/i })).toBeInTheDocument();
    expect(within(reply).queryByRole('button', { name: COPY })).toBeNull();
  });

  it('a finished reply with no parts renders no row: no content and no action bar', () => {
    const { container } = renderThread([
      { id: 'u1', role: 'user', content: 'Вопрос' },
      { id: 'a1', role: 'assistant', content: [], status: { type: 'complete', reason: 'stop' } },
    ]);

    const roots = messageRoots(container);
    expect(within(roots[0]).getByRole('button', { name: COPY })).toBeInTheDocument();
    const reply = roots[1];
    expect(reply).toHaveTextContent('');
    expect(within(reply).queryAllByRole('button')).toHaveLength(0);
    expect(within(reply).queryByRole('status')).toBeNull();
    expect(reply.querySelector('[data-slot="aui_assistant-message-content"]')).toBeNull();
    expect(reply.querySelector('[data-slot="aui_assistant-message-footer"]')).toBeNull();
  });
});
