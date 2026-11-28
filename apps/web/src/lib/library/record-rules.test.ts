import type {
  AgentContent,
  MissingRight,
  RecordSummary,
} from '@agent-os/contracts';
import { describe, expect, it } from 'vitest';
import { fixtureId, recordSummary } from '@/test/fixtures';
import { testTranslator } from '@/test/intl';
import {
  canUseInChat,
  changedAfterRun,
  changedFieldLabel,
  changedFields,
  recipientNote,
  recordNamed,
  type AgentDefinition,
} from './record-rules';

const t = testTranslator('library');
/** Changed fields as the form names them, from the Russian catalogue. */
const labelsOf = (before: AgentDefinition, after: AgentDefinition): string[] =>
  changedFields(before, after).map((field) => changedFieldLabel(t, field));

const MODEL = 'anthropic/claude-haiku-4-5';

const inChat = (fields: {
  kind?: RecordSummary['kind'];
  builtinKey?: string | null;
  mine?: boolean;
  offerInChat?: boolean;
  missingRights?: MissingRight[];
}) =>
  canUseInChat({
    kind: 'agent',
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
  skills: [],
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

/**
 * The library list of the name rows, in the order of the list: a colleague's deep agent «Отчёт», the viewer's own
 * «отчёт», an agent «Сводка», and the main chat.
 */
const NAMED: ReadonlyMap<string, RecordSummary> = new Map(
  [
    recordSummary({
      id: fixtureId(61),
      kind: 'deep_agent',
      name: 'Отчёт',
      mine: false,
    }),
    recordSummary({ id: fixtureId(62), kind: 'deep_agent', name: 'отчёт' }),
    recordSummary({ id: fixtureId(63), name: 'Сводка', mine: false }),
    recordSummary({
      id: fixtureId(64),
      name: 'Главный чат',
      builtinKey: 'chat',
      author: null,
      mine: false,
    }),
  ].map((record) => [record.id, record]),
);
const namedId = (kind: RecordSummary['kind'], name: string) =>
  recordNamed(NAMED, kind, name)?.id ?? null;

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
      'in chat: an own skill offered in chat → no (agent-guidance DC-9)',
      () => inChat({ kind: 'skill', mine: true, offerInChat: true }),
      false,
    ],
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

    // Запись по имени вызова — data-model KD-5: the card finds the record by name, never by an id; who wins a
    // name is the backend's rule (its row in `packages/contracts/src/library.spec.ts`)
    [
      'record by name: the winner of the name among the records of the kind, whatever the case',
      () => namedId('deep_agent', 'ОТЧЁТ'),
      fixtureId(62),
    ],
    [
      'record by name: an agent’s name asked as a deep agent → none (a temporary deep agent)',
      () => namedId('deep_agent', 'Сводка'),
      null,
    ],
    [
      'record by name: the main chat is never named',
      () => namedId('agent', 'Главный чат'),
      null,
    ],
    [
      'record by name: list not read → unknown',
      () => recordNamed(null, 'agent', 'Сводка'),
      undefined,
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
