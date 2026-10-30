import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  AssistantRuntimeProvider,
  AuiConfig,
  Suggestions,
  useLocalRuntime,
  type ChatModelAdapter,
  type ChatModelRunOptions,
} from '@assistant-ui/react';
import { describe, expect, it, vi } from 'vitest';
import { Thread } from '@/components/assistant-ui/elements/thread.aui';
import { TooltipProvider } from '@/components/ui/tooltip';
import { WELCOME_SUGGESTIONS } from '@/lib/welcome-suggestions';
import { ShellWelcome } from './shell-welcome';

const config = AuiConfig({ suggestions: Suggestions(WELCOME_SUGGESTIONS) });

function WelcomeHarness({ adapter }: { adapter: ChatModelAdapter }) {
  const runtime = useLocalRuntime(adapter);
  return (
    <AssistantRuntimeProvider runtime={runtime} config={config}>
      <TooltipProvider>
        <Thread autoFocus={false} components={{ Welcome: ShellWelcome }} />
      </TooltipProvider>
    </AssistantRuntimeProvider>
  );
}

/** Text of the last user message the model adapter received. */
function lastUserText(options: ChatModelRunOptions): string {
  const last = options.messages.at(-1);
  if (last === undefined || last.role !== 'user') return '';
  return last.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

describe('ShellWelcome + welcome suggestions — TH-02 / TH-03 (AC-08.2, S-9)', () => {
  it('shows the greeting and four suggestions; clicking one sends its joined text at once', async () => {
    const user = userEvent.setup();
    const run = vi.fn<(options: ChatModelRunOptions) => void>();
    const adapter: ChatModelAdapter = {
      async run(options) {
        run(options);
        return { content: [{ type: 'text', text: 'Готово.' }] };
      },
    };
    render(<WelcomeHarness adapter={adapter} />);

    expect(screen.getByText('Чем могу помочь?')).toBeInTheDocument();
    expect(screen.getByText('Задайте вопрос, попросите текст или разбор задачи.')).toBeInTheDocument();
    const suggestions = screen.getByRole('group', { name: 'Подсказки' });
    const cards = within(suggestions).getAllByRole('button');
    expect(cards.map((card) => card.textContent)).toEqual([
      'Составь план встречи по запуску нового проекта',
      'Напиши письмо клиенту о переносе сроков',
      'Объясни простыми словами что такое OKR и как их ставить',
      'Предложи идеи для тимбилдинга команды из 15 человек',
    ]);
    expect(suggestions).not.toHaveTextContent('>');

    await user.click(within(suggestions).getByRole('button', { name: /Объясни простыми словами/ }));

    expect(await screen.findByText('Готово.')).toBeInTheDocument();
    expect(run).toHaveBeenCalledOnce();
    expect(lastUserText(run.mock.calls[0][0])).toBe('Объясни простыми словами, что такое OKR и как их ставить');
    expect(screen.queryByText('Чем могу помочь?')).toBeNull();
  });
});
