import type { AgentContent, MissingRight, WorkflowContent, WorkflowExecutor } from '@agent-os/contracts';
import { describe, expect, it } from 'vitest';
import {
  canUseInChat,
  changedAfterRun,
  changedFields,
  freeName,
  isDraftStale,
  recipientNote,
  taskTitleName,
  type RecordDefinition,
} from './record-rules';

const MODEL = 'anthropic/claude-haiku-4-5';
const SOURCE_ID = '7f3c1a52-4b8e-4c1d-9a0e-2d6b5f8e1c40';

const inChat = (fields: { builtinKey?: string | null; mine?: boolean; offerInChat?: boolean; missingRights?: MissingRight[] }) =>
  canUseInChat({ builtinKey: null, mine: false, offerInChat: false, missingRights: [], ...fields });

const colleague = {
  mine: false,
  author: { id: '0b8f6d2e-1c3a-4e5f-8a7b-9c0d1e2f3a4b', name: 'Аня', disabled: false },
  audience: {
    roles: [
      { id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d', name: 'SRE', member: true },
      { id: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e', name: 'Поддержка', member: false },
    ],
  },
};

const pendingEdit = { state: 'pending' as const, recordId: SOURCE_ID, baseVersion: 3, refusal: null };

const agentContent: AgentContent = {
  prompt: 'Собери ошибки gateway',
  servers: ['sentry', 'jira'],
  model: MODEL,
  maxTurns: 40,
  agents: [],
  tools: [],
};

const agent = (content: Partial<AgentContent> = {}, name = 'Сбор логов'): RecordDefinition => ({
  name,
  description: 'Ошибки за период',
  kind: 'agent',
  content: { ...agentContent, ...content },
});

const executor = (name: string, fields: Partial<WorkflowExecutor> = {}): WorkflowExecutor => ({
  name,
  role: 'Собирает ошибки за период из задания',
  prompt: 'Собери ошибки',
  servers: ['sentry'],
  model: MODEL,
  maxTurns: 40,
  maxRuns: 3,
  tools: [],
  source: null,
  ...fields,
});

const workflow = (content: Partial<WorkflowContent> = {}, name = 'Разбор инцидента'): RecordDefinition => ({
  name,
  description: 'Сводка по инциденту',
  kind: 'workflow',
  content: {
    coordinator: { rules: '', model: MODEL, maxTurns: 40 },
    executors: [executor('Сбор логов'), executor('Ответ')],
    finalExecutor: 'Ответ',
    ...content,
  },
});

const index = { summaryOf: (id: string) => (id === SOURCE_ID ? { name: 'Разбор инцидента' } : null) };

// Catches: a rule shows an action where it is forbidden or hides it where it is allowed (AC-26.2, AC-28.1, AC-29.1, DC-01).
describe('web rules (design-web.md, «Правила веба»)', () => {
  it.each<[string, () => unknown, unknown]>([
    // «Использовать в чате» — AC-26.2, RV-01
    ['in chat: the main chat record → no', () => inChat({ builtinKey: 'chat', mine: true, offerInChat: true }), false],
    ['in chat: own record → yes', () => inChat({ mine: true }), true],
    ["in chat: colleague's record offered in chat → yes", () => inChat({ offerInChat: true }), true],
    ["in chat: colleague's record not offered in chat → no (AC-26.2)", () => inChat({}), false],
    [
      'in chat: the record itself needs a model the viewer lacks → no',
      () => inChat({ mine: true, missingRights: [{ executor: null, servers: [], model: MODEL }] }),
      false,
    ],
    [
      'in chat: only missing servers or an executor model → yes',
      () =>
        inChat({
          mine: true,
          missingRights: [
            { executor: null, servers: ['sentry'], model: null },
            { executor: 'Сбор логов', servers: [], model: MODEL },
          ],
        }),
      true,
    ],

    // «Изменён после запуска» — AC-28.1
    ['changed after run: newer version → yes', () => changedAfterRun({ version: 1 }, { version: 2 }), true],
    ['changed after run: same version → no', () => changedAfterRun({ version: 2 }, { version: 2 }), false],
    ['changed after run: record not in the list → no', () => changedAfterRun({ version: 1 }, null), false],
    ['changed after run: list not read → no', () => changedAfterRun({ version: 1 }, undefined), false],

    // «Пояснение получателю» — AC-29.1
    [
      "recipient note: colleague's record, on its page and on the first run → roles with member",
      () => [recipientNote(colleague), recipientNote(colleague, true)],
      [{ roles: ['SRE'] }, { roles: ['SRE'] }],
    ],
    ['recipient note: not the first run → none', () => recipientNote(colleague, false), null],
    ['recipient note: the viewer is the author → none', () => recipientNote({ ...colleague, mine: true }), null],
    ['recipient note: a company record → none', () => recipientNote({ ...colleague, author: null }), null],
    ['recipient note: record not in the live list → none', () => recipientNote(null), null],

    // «Черновик устарел» — DC-01
    ['stale draft: record version above baseVersion → yes', () => isDraftStale(pendingEdit, { version: 4 }), true],
    ['stale draft: record still at baseVersion → no', () => isDraftStale(pendingEdit, { version: 3 }), false],
    [
      'stale draft: last refusal version_conflict → yes',
      () => isDraftStale({ ...pendingEdit, refusal: 'version_conflict' }, { version: 3 }),
      true,
    ],
    ['stale draft: an already saved draft → no', () => isDraftStale({ ...pendingEdit, state: 'saved' }, { version: 4 }), false],
    [
      'stale draft: a draft of a new record → no',
      () => isDraftStale({ ...pendingEdit, recordId: null, baseVersion: null }, undefined),
      false,
    ],

    // Заголовок задания — MC-21
    ['task title: record in the list → with its name', () => taskTitleName(SOURCE_ID, index), 'Задание · Разбор инцидента'],
    ['task title: record not in the list → «Задание»', () => taskTitleName('c3d4e5f6-a7b8-4c9d-8e0f-1a2b3c4d5e6f', index), 'Задание'],
    ['task title: list not read → «Задание»', () => taskTitleName(SOURCE_ID, { summaryOf: () => undefined }), 'Задание'],

    // Свободное имя
    ['free name: nothing taken → «{имя} 2»', () => freeName('Сбор логов', ['Сбор логов']), 'Сбор логов 2'],
    [
      'free name: «{имя} 2» taken, any case → «{имя} 3»',
      () => freeName('Сбор логов', ['Сбор логов', 'сбор логов 2']),
      'Сбор логов 3',
    ],

    // Изменённые поля — MC-7, MC-10, MC-15
    [
      'changed fields: equal definitions, or servers ticked in another order → none',
      () => [changedFields(agent(), agent()), changedFields(agent(), agent({ servers: ['jira', 'sentry'] }))],
      [[], []],
    ],
    [
      'changed fields: agent name and instruction',
      () => changedFields(agent(), agent({ prompt: 'Собери ошибки и тикеты' }, 'Сбор логов и тикетов')),
      [
        { field: 'name', label: 'Имя' },
        { field: 'prompt', label: 'Инструкция' },
      ],
    ],
    [
      'changed fields: workflow executor changed, added and removed',
      () =>
        changedFields(
          workflow(),
          workflow({
            executors: [executor('Сбор логов', { role: 'Собирает ошибки gateway' }), executor('Сбор тикетов')],
            finalExecutor: null,
          }),
        ),
      [
        { field: 'executor', executor: 'Сбор логов', label: 'Исполнитель «Сбор логов»' },
        { field: 'executor', executor: 'Сбор тикетов', label: 'Исполнитель «Сбор тикетов»' },
        { field: 'executor', executor: 'Ответ', label: 'Исполнитель «Ответ»' },
        { field: 'finalExecutor', label: 'Кто пишет ответ' },
      ],
    ],
    [
      'changed fields: workflow name and coordinator rules',
      () => changedFields(workflow(), workflow({ coordinator: { rules: 'Ответ ждёт сбор', model: MODEL, maxTurns: 40 } }, 'Инцидент')),
      [
        { field: 'name', label: 'Имя' },
        { field: 'rules', label: 'Как работает команда' },
      ],
    ],
  ])('%s', (_, decide, expected) => {
    expect(decide()).toEqual(expected);
  });
});
