// UXRD 10.2 / DD «Локализация»: key screens rendered in the shell carry no English scaffold strings —
// neither in visible text nor in what a screen reader announces (aria-label, title, placeholder, alt, aria-valuetext).
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  AssistantRuntimeProvider,
  useLocalRuntime,
  type ChatModelAdapter,
  type ThreadMessageLike,
} from '@assistant-ui/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { ReasoningRoot, ReasoningTrigger } from '@/components/assistant-ui/elements/reasoning';
import { Thread } from '@/components/assistant-ui/elements/thread.aui';
import { Dialog, DialogContent, DialogFooter, DialogTitle } from '@/components/ui/dialog';
import { TooltipProvider } from '@/components/ui/tooltip';
import { threadList, threadSummary } from '@/test/fixtures';
import { server } from '@/test/msw-server';
import { renderWithRuntime } from '@/test/render-with-runtime';

const API = 'http://api.test';

/** DD «Локализация» stop-list. */
const STOP_LIST = ['Send', 'Copy', 'Close', 'Toggle', 'Loading', 'Reasoning', 'tool call'] as const;

/** Further scaffold words the translated files used to render (UXRD 14.4, DD «Локализация»). */
const SCAFFOLD_WORDS = [
  'Stop',
  'Scroll',
  'Assistant',
  'Resume',
  'Play',
  'Pause',
  'Seek',
  'Download',
  'Preview',
  'Image',
  'Audio',
  'Unnamed',
  'attachment',
] as const;

const ANNOUNCED_ATTRIBUTES = ['aria-label', 'title', 'placeholder', 'alt', 'aria-valuetext'] as const;

/** Stop-list words found in the rendered document: visible/sr-only text and announced attributes. */
function englishLeaks(words: readonly string[] = [...STOP_LIST, ...SCAFFOLD_WORDS]): string[] {
  const texts = [document.body.textContent ?? ''];
  for (const element of document.body.querySelectorAll('*')) {
    for (const attribute of ANNOUNCED_ATTRIBUTES) {
      const value = element.getAttribute(attribute);
      if (value) texts.push(value);
    }
  }
  return words.filter((word) => texts.some((text) => new RegExp(`\\b${word}\\b`).test(text)));
}

// A one-second silent WAV header is enough for <audio>; jsdom never decodes it.
const AUDIO_BASE64 = 'UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=';
const PIXEL_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

/** A conversation with every scaffold part the feed renders: reasoning, a tool group with an error, text, file, image. */
const TOOL_CONVERSATION: readonly ThreadMessageLike[] = [
  { id: 'u1', role: 'user', content: 'Найди отчёт и посчитай итог' },
  {
    id: 'a1',
    role: 'assistant',
    content: [
      { type: 'reasoning', text: 'Сначала найду отчёт.' },
      { type: 'tool-call', toolCallId: 'call-1', toolName: 'search', args: { q: 'отчёт' }, result: { found: 1 } },
      {
        type: 'tool-call',
        toolCallId: 'call-2',
        toolName: 'sum',
        args: { column: 'итог' },
        result: { message: 'internal failure' },
        isError: true,
      },
      { type: 'text', text: 'Итог — 42.' },
      { type: 'file', data: AUDIO_BASE64, mimeType: 'audio/wav' },
      { type: 'image', image: PIXEL_PNG },
    ],
  },
];

type Gate = { open: () => void; wait: Promise<void> };

function createGate(): Gate {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { open: () => resolve(), wait: promise };
}

function ThreadHarness({ adapter, messages }: { adapter: ChatModelAdapter; messages: readonly ThreadMessageLike[] }) {
  const runtime = useLocalRuntime(adapter, { initialMessages: messages });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <TooltipProvider>
        <Thread autoFocus={false} />
      </TooltipProvider>
    </AssistantRuntimeProvider>
  );
}

describe('Scaffold localisation (UXRD 10.2): key screens carry no English strings', () => {
  it('new chat and the conversation menus', async () => {
    const user = userEvent.setup();
    server.use(
      http.get(`${API}/api/threads`, () => HttpResponse.json(threadList([threadSummary({ id: 'a', title: 'Беседа A' })]))),
    );

    renderWithRuntime({ pathname: '/' });
    const history = await screen.findByRole('navigation', { name: 'История бесед' });
    await within(history).findByRole('link', { name: /Беседа A/ });
    expect(screen.getByRole('textbox', { name: 'Сообщение' })).toBeInTheDocument();
    expect(englishLeaks()).toEqual([]);

    await user.click(within(history).getByRole('button', { name: 'Действия с беседой «Беседа A»' }));
    expect(await screen.findByRole('menuitem', { name: 'Удалить' })).toBeInTheDocument();
    expect(englishLeaks()).toEqual([]);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());

    await user.click(screen.getByRole('button', { name: 'Меню пользователя dev-user' }));
    expect(await screen.findByRole('menuitemradio', { name: 'Системная' })).toBeInTheDocument();
    expect(englishLeaks()).toEqual([]);
  });

  it('a conversation with reasoning, tools, a tool error, a file and an image — at rest and while a reply streams', async () => {
    const user = userEvent.setup();
    const gate = createGate();
    const adapter: ChatModelAdapter = {
      async run() {
        await gate.wait;
        return { content: [{ type: 'text', text: 'Готово' }] };
      },
    };

    render(<ThreadHarness adapter={adapter} messages={TOOL_CONVERSATION} />);

    const reply = screen.getByText('Итог — 42.').closest<HTMLElement>('[data-role="assistant"]');
    expect(reply).not.toBeNull();
    if (reply === null) return;
    expect(within(reply).getByRole('button', { name: /^Рассуждения/ })).toBeInTheDocument();
    expect(within(reply).getByRole('button', { name: '2 вызова инструментов' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'К последнему сообщению' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Отправить' })).toBeInTheDocument();
    expect(within(reply).getByRole('button', { name: 'Воспроизвести аудио' })).toBeInTheDocument();
    expect(within(reply).getByRole('slider', { name: 'Перемотка' })).toBeInTheDocument();
    expect(within(reply).getByRole('button', { name: 'Увеличить изображение' })).toBeInTheDocument();
    expect(englishLeaks()).toEqual([]);

    await user.click(within(reply).getByRole('button', { name: '2 вызова инструментов' }));
    await user.click(await within(reply).findByRole('button', { name: 'Сбой инструмента: sum' }));
    expect(await within(reply).findByText('Не удалось выполнить инструмент.')).toBeInTheDocument();
    expect(englishLeaks()).toEqual([]);

    await user.type(screen.getByRole('textbox', { name: 'Сообщение' }), 'Ещё раз{Enter}');
    expect(await screen.findByRole('button', { name: 'Остановить' })).toBeInTheDocument();
    expect(englishLeaks()).toEqual([]);

    gate.open();
    expect(await screen.findByText('Готово')).toBeInTheDocument();
  });

  it('reasoning trigger with its duration reads «Рассуждения (N с)»', () => {
    render(
      <ReasoningRoot>
        <ReasoningTrigger duration={4} />
      </ReasoningRoot>,
    );

    expect(screen.getByRole('button', { name: 'Рассуждения (4 с)' })).toBeInTheDocument();
  });

  it('dialog close controls', () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Просмотр</DialogTitle>
          <DialogFooter showCloseButton />
        </DialogContent>
      </Dialog>,
    );

    expect(screen.getAllByRole('button', { name: 'Закрыть' })).toHaveLength(2);
    expect(englishLeaks()).toEqual([]);
  });
});
