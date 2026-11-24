import type { ComponentProps } from 'react';
import { render, within } from '@/test/render';
import userEvent from '@testing-library/user-event';
import type { ThreadMessageLike } from '@assistant-ui/react';
import { describe, expect, it, vi } from 'vitest';
import {
  DecisionCard,
  type DecisionCardProps,
} from '@/components/agents/decision-card';
import { ToolFallback } from '@/components/assistant-ui/elements/tool-fallback.aui';
import {
  FEED_PART,
  feedViewOf,
  toFeed,
  type DecisionPartData,
} from '@/lib/feed/to-feed';
import {
  confirmation,
  conversationView,
  fixtureTime,
  historyEntry,
} from '@/test/fixtures';

// The block reads only the message time from the assistant-ui store; nothing else of the runtime is needed.
vi.mock('@assistant-ui/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@assistant-ui/react')>();
  return {
    ...actual,
    useAuiState: <T,>(
      select: (state: { message: { createdAt: Date } }) => T,
    ): T =>
      select({ message: { createdAt: new Date('2026-10-28T10:00:00.000Z') } }),
  };
});

type LikePart = Exclude<ThreadMessageLike['content'], string>[number];
type ToolCallLikePart = Extract<LikePart, { type: 'tool-call' }>;
type DataLikePart = Extract<LikePart, { type: `data-${string}` }>;

const SCRIPT = [
  'const top = await readResult("r9");',
  'for (const [service] of top.slice(0, 3)) {',
  '  await mcp__backoffice__create_incident_note({ title: `Рост 5xx в ${service}` });',
  '}',
  'return "создано заметок: 3";',
].join('\n');
const READ_ARGS = {
  description: 'Считаю ошибки 5xx по сервисам',
  class: 'read',
  script: SCRIPT,
};
const WRITE_ARGS = {
  description: 'Создаю заметки об инцидентах',
  class: 'write',
  script: SCRIPT,
};
/** The platform's order (KD-10): an alphabetical sort would move `count` above `search_logs`. */
const CAN_CALL = [
  { name: 'mcp__backoffice__create_incident_note', changes: true },
  { name: 'mcp__logs__search_logs', changes: false },
  { name: 'mcp__logs__count', changes: false },
];

/** The feed of a conversation with a successful run that printed, a failed run and an open `write` request. */
function feed(): ThreadMessageLike[] {
  const view = conversationView({
    entries: [
      historyEntry({
        kind: 'model_answer',
        seq: 1,
        content: {
          text: '',
          toolCalls: [
            {
              callId: 'ok',
              tool: 'run_code',
              server: null,
              args: READ_ARGS,
              state: 'done',
            },
            {
              callId: 'bad',
              tool: 'run_code',
              server: null,
              args: READ_ARGS,
              state: 'done',
            },
          ],
        },
      }),
      historyEntry({
        kind: 'tool_result',
        seq: 2,
        content: {
          callId: 'ok',
          tool: 'run_code',
          server: null,
          args: READ_ARGS,
          outcome: 'success',
          text: 'создано заметок: 3',
          output: 'api: 12\nbilling: 7',
        },
      }),
      historyEntry({
        kind: 'tool_result',
        seq: 3,
        content: {
          callId: 'bad',
          tool: 'run_code',
          server: null,
          args: READ_ARGS,
          outcome: 'tool_error',
          text: 'SyntaxError: Unexpected token',
          output: null,
        },
      }),
    ],
    decisions: [writeRequest({ content: { canCall: CAN_CALL } })],
  });
  return toFeed(feedViewOf(view), null, []);
}

/** The open request of a `write` run, asked by the conversation's root. */
function writeRequest(
  overrides: Partial<DecisionCardProps['confirmation']>,
): DecisionCardProps['confirmation'] {
  return confirmation({
    decisionId: 'd-run',
    agentId: 'root',
    tool: 'run_code',
    server: null,
    args: WRITE_ARGS,
    createdAt: fixtureTime(4),
    ...overrides,
  });
}

const partsOf = (messages: ThreadMessageLike[]): LikePart[] =>
  messages.flatMap((message) =>
    typeof message.content === 'string' ? [] : message.content,
  );

function renderBlock(messages: ThreadMessageLike[], callId: string) {
  const part = partsOf(messages).find(
    (candidate): candidate is ToolCallLikePart =>
      candidate.type === 'tool-call' && candidate.toolCallId === callId,
  );
  if (part === undefined)
    throw new Error(`no tool-call part ${callId} in the feed`);
  const props: ComponentProps<typeof ToolFallback> = {
    type: 'tool-call',
    toolCallId: callId,
    toolName: part.toolName,
    args: part.args ?? {},
    argsText: part.argsText ?? '',
    result: part.result,
    isError: part.isError,
    artifact: part.artifact,
    status: { type: 'complete' },
    addResult: vi.fn(),
    resume: vi.fn(),
    respondToApproval: vi.fn<() => Promise<void>>(),
  };
  return within(render(<ToolFallback {...props} />).container);
}

function isDecisionPart(
  part: LikePart,
): part is DataLikePart & { data: DecisionPartData } {
  return part.type === `data-${FEED_PART.decision}`;
}

function renderCard(data: DecisionPartData) {
  const onDecide = vi.fn<DecisionCardProps['onDecide']>();
  return within(
    render(<DecisionCard {...data} onDecide={onDecide} />).container,
  );
}

/** The lines of the opened script block, without their numbers. */
const scriptLines = (block: HTMLElement): string[] =>
  Array.from(
    block.querySelectorAll(':scope > div > span:last-child'),
    (line) => line.textContent ?? '',
  );

const canCallItems = (view: ReturnType<typeof within>): string[] =>
  within(view.getByRole('list', { name: 'Может вызвать' }))
    .getAllByRole('listitem')
    .map((item) => item.textContent ?? '');

describe('run_code in the web (UC-5)', () => {
  // AC-05.2, AC-08.1, UXRD KD-1–KD-7, MC-1–MC-9.
  it('a code run shows its description, class in words, collapsed script, output and the "Может вызвать" list', async () => {
    const user = userEvent.setup();
    const messages = feed();

    // Successful run: the description on the second header line, the rows in KD-2 order, the script
    // collapsed, then its end and «Вывод скрипта».
    const ok = renderBlock(messages, 'ok');
    const okTrigger = ok.getByRole('button', {
      name: /^Выполнить код: готово/,
    });
    expect(okTrigger).toHaveTextContent('Считаю ошибки 5xx по сервисам');
    await user.click(okTrigger);
    const okArgs = ok.getByRole('region', { name: 'Аргументы' });
    expect(
      within(okArgs)
        .getAllByRole('term')
        .map((term) => term.textContent),
    ).toEqual(['Описание', 'Класс запуска', 'Скрипт']);
    expect(within(okArgs).getByText('читающий')).toBeInTheDocument();
    expect(
      within(okArgs).getByRole('button', { name: 'Показать скрипт' }),
    ).toHaveAttribute('aria-expanded', 'false');
    expect(ok.queryByRole('region', { name: 'Скрипт' })).toBeNull();
    expect(ok.getByRole('region', { name: 'Результат' })).toHaveTextContent(
      'создано заметок: 3',
    );
    expect(ok.getByRole('region', { name: 'Вывод скрипта' }).textContent).toBe(
      'api: 12\nbilling: 7',
    );

    // Failed run: only the outcome, neither result nor output.
    const bad = renderBlock(messages, 'bad');
    await user.click(
      bad.getByRole('button', { name: /^Выполнить код: ошибка инструмента/ }),
    );
    expect(bad.getByRole('region', { name: 'Аргументы' })).toBeInTheDocument();
    expect(bad.queryByRole('region', { name: 'Результат' })).toBeNull();
    expect(bad.queryByRole('region', { name: 'Вывод скрипта' })).toBeNull();

    // Open `write` request: MC-1 alone, the class in words, the script collapsed and opening as it went
    // to the tool, the list in the given order with MC-8, right above the actions.
    const decision = partsOf(messages).find(isDecisionPart);
    if (decision === undefined) throw new Error('no decision part in the feed');
    const card = renderCard(decision.data);
    const group = card.getByRole('group', {
      name: 'Нужно решение: Выполнить код',
    });
    expect(within(group).getByText('Чат хочет выполнить:')).toBeInTheDocument();
    expect(within(group).queryByText(/run_code/)).toBeNull();
    expect(
      within(group).getByText(
        'изменяющий: может менять данные во внешних системах',
      ),
    ).toBeInTheDocument();
    const toggle = within(group).getByRole('button', {
      name: 'Показать скрипт',
    });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(within(group).queryByRole('region', { name: 'Скрипт' })).toBeNull();
    await user.click(toggle);
    expect(
      scriptLines(within(group).getByRole('region', { name: 'Скрипт' })),
    ).toEqual(SCRIPT.split('\n'));

    expect(within(group).getByText('Может вызвать')).toBeInTheDocument();
    expect(canCallItems(within(group))).toEqual([
      'mcp__backoffice__create_incident_note — меняет',
      'mcp__logs__search_logs — читает',
      'mcp__logs__count — читает',
    ]);
    expect(
      within(group).getByText(
        'Составила платформа по тексту скрипта: других инструментов запуск не вызовет',
      ),
    ).toBeInTheDocument();
    const list = within(group).getByRole('list', { name: 'Может вызвать' });
    const approve = within(group).getByRole('button', { name: 'Подтвердить' });
    expect(
      list.compareDocumentPosition(approve) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  // KD-7, MC-9, DC-16: the list stays after the decision, an empty one reads MC-9, foreign content gives none.
  it.each([
    {
      name: 'an approved request keeps its list',
      overrides: {
        content: { canCall: CAN_CALL.slice(0, 1) },
        status: 'resolved' as const,
        resolution: { approve: true, args: WRITE_ARGS },
        resolvedAt: fixtureTime(5),
      },
      items: ['mcp__backoffice__create_incident_note — меняет'],
      none: false,
    },
    {
      name: 'a run naming no tool reads MC-9',
      overrides: { content: { canCall: [] } },
      items: null,
      none: true,
    },
    {
      name: 'content outside the contract shows no list',
      overrides: { content: { tools: [] } },
      items: null,
      none: false,
    },
  ])('$name', ({ overrides, items, none }) => {
    const card = renderCard({
      confirmation: writeRequest(overrides),
      byChat: true,
      saved: null,
    });

    if (items === null) {
      expect(card.queryByRole('list', { name: 'Может вызвать' })).toBeNull();
    } else {
      expect(canCallItems(card)).toEqual(items);
    }
    expect(
      card.queryByText(
        'Ни одного инструмента: запуск не обратится к внешним системам',
      ) !== null,
    ).toBe(none);
    expect(card.queryByText('Может вызвать') !== null).toBe(
      items !== null || none,
    );
  });
});
