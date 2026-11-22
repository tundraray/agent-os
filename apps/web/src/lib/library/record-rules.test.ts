import type { AgentContent, MissingRight } from '@agent-os/contracts';
import { describe, expect, it } from 'vitest';
import { testTranslator } from '@/test/intl';
import {
  briefTitleName,
  canUseInChat,
  changedAfterRun,
  changedFieldLabel,
  changedFields,
  recipientNote,
  type AgentDefinition,
} from './record-rules';

const t = testTranslator('library');
/** Changed fields as the form names them, from the Russian catalogue. */
const labelsOf = (before: AgentDefinition, after: AgentDefinition): string[] =>
  changedFields(before, after).map((field) => changedFieldLabel(t, field));

const MODEL = 'anthropic/claude-haiku-4-5';
const SOURCE_ID = '7f3c1a52-4b8e-4c1d-9a0e-2d6b5f8e1c40';

const inChat = (fields: {
  builtinKey?: string | null;
  mine?: boolean;
  offerInChat?: boolean;
  missingRights?: MissingRight[];
}) =>
  canUseInChat({
    builtinKey: null,
    mine: false,
    offerInChat: false,
    missingRights: [],
    ...fields,
  });

const colleague = {
  mine: false,
  author: {
    id: '0b8f6d2e-1c3a-4e5f-8a7b-9c0d1e2f3a4b',
    name: 'Аня',
    disabled: false,
  },
  audience: {
    roles: [
      { id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d', name: 'SRE', member: true },
      {
        id: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e',
        name: 'Поддержка',
        member: false,
      },
    ],
  },
};

const agentContent: AgentContent = {
  prompt: 'Собери ошибки gateway',
  servers: ['sentry', 'jira'],
  model: MODEL,
  maxTurns: 40,
  agents: [],
  tools: [],
  taskList: true,
};

const agent = (
  content: Partial<AgentContent> = {},
  name = 'Сбор логов',
): AgentDefinition => ({
  name,
  description: 'Ошибки за период',
  kind: 'agent',
  content: { ...agentContent, ...content },
});

const index = {
  summaryOf: (id: string) =>
    id === SOURCE_ID ? { name: 'Разбор инцидента' } : null,
};

// Catches: a rule shows an action where it is forbidden or hides it where it is allowed (AC-26.2, AC-28.1, AC-29.1).
describe('web rules (design-web.md, «Правила веба»)', () => {
  it.each<[string, () => unknown, unknown]>([
    // «Использовать в чате» — AC-26.2, RV-01
    [
      'in chat: the main chat record → no',
      () => inChat({ builtinKey: 'chat', mine: true, offerInChat: true }),
      false,
    ],
    ['in chat: own record → yes', () => inChat({ mine: true }), true],
    [
      "in chat: colleague's record offered in chat → yes",
      () => inChat({ offerInChat: true }),
      true,
    ],
    [
      "in chat: colleague's record not offered in chat → no (AC-26.2)",
      () => inChat({}),
      false,
    ],
    [
      'in chat: the record itself needs a model the viewer lacks → no',
      () =>
        inChat({
          mine: true,
          missingRights: [{ subagent: null, servers: [], model: MODEL }],
        }),
      false,
    ],
    [
      'in chat: only missing servers or a subagent model → yes',
      () =>
        inChat({
          mine: true,
          missingRights: [
            { subagent: null, servers: ['sentry'], model: null },
            { subagent: 'Сбор логов', servers: [], model: MODEL },
          ],
        }),
      true,
    ],

    // «Изменён после запуска» — AC-28.1
    [
      'changed after run: newer version → yes',
      () => changedAfterRun({ version: 1 }, { version: 2 }),
      true,
    ],
    [
      'changed after run: same version → no',
      () => changedAfterRun({ version: 2 }, { version: 2 }),
      false,
    ],
    [
      'changed after run: record not in the list → no',
      () => changedAfterRun({ version: 1 }, null),
      false,
    ],
    [
      'changed after run: list not read → no',
      () => changedAfterRun({ version: 1 }, undefined),
      false,
    ],

    // «Пояснение получателю» — AC-29.1
    [
      "recipient note: colleague's record, on its page and on the first run → roles with member",
      () => [recipientNote(colleague), recipientNote(colleague, true)],
      [{ roles: ['SRE'] }, { roles: ['SRE'] }],
    ],
    [
      'recipient note: not the first run → none',
      () => recipientNote(colleague, false),
      null,
    ],
    [
      'recipient note: the viewer is the author → none',
      () => recipientNote({ ...colleague, mine: true }),
      null,
    ],
    [
      'recipient note: a company record → none',
      () => recipientNote({ ...colleague, author: null }),
      null,
    ],
    [
      'recipient note: record not in the live list → none',
      () => recipientNote(null),
      null,
    ],

    // Заголовок задания — MC-22
    [
      'brief title: record in the list → with its name',
      () => briefTitleName(t, SOURCE_ID, index),
      'Задание · Разбор инцидента',
    ],
    [
      'brief title: record not in the list → «Задание»',
      () => briefTitleName(t, 'c3d4e5f6-a7b8-4c9d-8e0f-1a2b3c4d5e6f', index),
      'Задание',
    ],
    [
      'brief title: list not read → «Задание»',
      () => briefTitleName(t, SOURCE_ID, { summaryOf: () => undefined }),
      'Задание',
    ],

    // Изменённые поля — MC-7, MC-10
    [
      'changed fields: equal definitions, or servers ticked in another order → none',
      () => [
        changedFields(agent(), agent()),
        changedFields(agent(), agent({ servers: ['jira', 'sentry'] })),
      ],
      [[], []],
    ],
    [
      'changed fields: agent name and instruction',
      () =>
        labelsOf(
          agent(),
          agent({ prompt: 'Собери ошибки и тикеты' }, 'Сбор логов и тикетов'),
        ),
      ['Имя', 'Инструкция'],
    ],
  ])('%s', (_, decide, expected) => {
    expect(decide()).toEqual(expected);
  });
});
