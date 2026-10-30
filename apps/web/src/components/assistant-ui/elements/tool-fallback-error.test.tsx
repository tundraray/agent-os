import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  AssistantRuntimeProvider,
  useLocalRuntime,
  type ChatModelAdapter,
  type ThreadMessageLike,
} from '@assistant-ui/react';
import { describe, expect, it } from 'vitest';
import { Thread } from '@/components/assistant-ui/elements/thread.aui';
import { TooltipProvider } from '@/components/ui/tooltip';

const adapter: ChatModelAdapter = {
  async run() {
    return { content: [{ type: 'text', text: 'Готово.' }] };
  },
};

type ToolMessageOptions = {
  readonly result?: { readonly error: string };
  readonly isError?: boolean;
  readonly status?: ThreadMessageLike['status'];
};

function toolMessages({ result, isError, status }: ToolMessageOptions): readonly ThreadMessageLike[] {
  return [
    { id: 'u1', role: 'user', content: [{ type: 'text', text: 'Найди отчёт' }] },
    {
      id: 'a1',
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId: 'call-1',
          toolName: 'search',
          args: { query: 'отчёт' },
          ...(result !== undefined && { result }),
          ...(isError !== undefined && { isError }),
        },
      ],
      ...(status !== undefined && { status }),
    },
  ];
}

function ToolThreadHarness({ messages }: { messages: readonly ThreadMessageLike[] }) {
  const runtime = useLocalRuntime(adapter, { initialMessages: messages });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <TooltipProvider>
        <Thread autoFocus={false} />
      </TooltipProvider>
    </AssistantRuntimeProvider>
  );
}

/** Renders the thread, opens the tool group, then expands the tool block by its trigger label. */
async function renderAndExpand(messages: readonly ThreadMessageLike[], triggerLabel: RegExp): Promise<HTMLElement> {
  const user = userEvent.setup();
  const { container } = render(<ToolThreadHarness messages={messages} />);
  await screen.findByText('Найди отчёт');
  const groupTrigger = container.querySelector<HTMLElement>('[data-slot="tool-group-trigger"]');
  if (groupTrigger === null) throw new Error('tool-group-trigger is not rendered');
  await user.click(groupTrigger);
  const trigger = await screen.findByRole('button', { name: triggerLabel });
  await user.click(trigger);
  const root = container.querySelector<HTMLElement>('[data-slot="tool-fallback-root"]');
  if (root === null) throw new Error('tool-fallback-root is not rendered');
  return root;
}

describe('ToolFallback — tool error (AC-14.5 client, D-15)', () => {
  it('shows a failed tool with the fixed error text for an isError part, without the raw error or a result section', async () => {
    await renderAndExpand(toolMessages({ result: { error: 'boom' }, isError: true }), /Сбой инструмента: search/);

    expect(screen.getByRole('button', { name: 'Сбой инструмента: search' })).toBeInTheDocument();
    expect(screen.getByText('Ошибка:')).toBeInTheDocument();
    expect(screen.getByText('Не удалось выполнить инструмент.')).toBeInTheDocument();
    expect(screen.queryByText(/boom/)).toBeNull();
    expect(screen.queryByText(/"error"/)).toBeNull();
    expect(screen.queryByText(/Result:/)).toBeNull();
    expect(screen.queryByText(/Результат:/)).toBeNull();
    expect(screen.queryByText(/Использован инструмент/)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it.each<{ readonly name: string; readonly status: ThreadMessageLike['status'] }>([
    {
      name: 'instead of its "Agent error" text',
      status: { type: 'incomplete', reason: 'error', error: 'Agent error' },
    },
    { name: 'without an error value', status: { type: 'incomplete', reason: 'error' } },
  ])('shows the same fixed text for an incomplete/error status $name', async ({ status }) => {
    const root = await renderAndExpand(toolMessages({ status }), /Сбой инструмента: search/);

    expect(within(root).getByText('Ошибка:')).toBeInTheDocument();
    expect(within(root).getByText('Не удалось выполнить инструмент.')).toBeInTheDocument();
    expect(within(root).queryByText(/Agent error/)).toBeNull();
    expect(within(root).queryByRole('alert')).toBeNull();
  });

  it('shows the fixed cancellation text under «Причина отмены:» for a cancelled tool, without the raw reason', async () => {
    const root = await renderAndExpand(
      toolMessages({ status: { type: 'incomplete', reason: 'cancelled', error: 'Остановлено пользователем' } }),
      /Отменён инструмент: search/,
    );

    expect(within(root).getByText('Причина отмены:')).toBeInTheDocument();
    expect(within(root).getByText('Вызов инструмента отменён.')).toBeInTheDocument();
    expect(within(root).queryByText(/Остановлено пользователем/)).toBeNull();
    expect(within(root).queryByText('Не удалось выполнить инструмент.')).toBeNull();
    expect(within(root).queryByText('Ошибка:')).toBeNull();
  });
});
