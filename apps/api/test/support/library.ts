import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import {
  CHAT_BUILTIN_KEY,
  RecordDetailSchema,
  RecordSummarySchema,
  type AgentContent,
  type CreateRecordBody,
  type DeepAgentContent,
  type RecordDetail,
  type RecordSummary,
  type Subagent,
  type ThreadSummary,
  type UpdateRecordBody,
} from '@agent-os/contracts';
import type { DatabaseConnection } from '@agent-os/db';
import type { App } from 'supertest/types.js';
import { z } from 'zod';
import {
  allowRole,
  catalogueModelIds,
  HAIKU_TEST_PRICES,
  runModel,
  useRunModels,
} from './access';
import { type ChatApi, chatApi, expectBody } from './api';
import {
  apiRequest,
  createEmployee,
  type Method,
  type Session,
} from './session';

/**
 * The library of the tests (custom-agents/design-library.md, Contract Definitions): record bodies, the
 * employee's and the panel's calls with their bodies parsed by `@agent-os/contracts`, the walk over every
 * route with a record number, and the audit trail of one record. Record names carry a random suffix, so a
 * suite never collides with the developer's own records.
 */

type TestApp = INestApplication<App>;

/** A record name no other record has: `<base> <8 hex>`. */
export function recordName(base: string): string {
  return `${base} ${randomUUID().slice(0, 8)}`;
}

/** The body of an agent record: no servers, agents or tools unless given. */
export function agentBody(
  name: string,
  content: Partial<AgentContent> & Pick<AgentContent, 'model'>,
): Extract<CreateRecordBody, { kind: 'agent' }> {
  return {
    kind: 'agent',
    name,
    description: `Описание: ${name}`,
    content: {
      prompt: `Промпт агента ${name}`,
      servers: [],
      maxTurns: 20,
      agents: [],
      tools: [],
      taskList: false,
      skills: [],
      ...content,
    },
  };
}

/**
 * The body of a deep agent record on `model`, without servers of its own: one subagent «Аналитик» unless
 * `subagents` are given, each subagent's fields over the defaults.
 */
export function deepAgentBody(
  name: string,
  model: string,
  subagents: readonly Partial<Subagent>[] = [{}],
): Extract<CreateRecordBody, { kind: 'deep_agent' }> {
  const content: DeepAgentContent = {
    prompt: `Промпт глубокого агента ${name}`,
    servers: [],
    model,
    maxTurns: 20,
    subagents: subagents.map((fields, index) => ({
      name: index === 0 ? 'Аналитик' : `Аналитик ${index + 1}`,
      description: 'Разбирает вопрос и пишет отчёт',
      prompt: `Промпт сабагента ${name}`,
      servers: [],
      model,
      maxTurns: 20,
      maxRuns: 3,
      taskList: false,
      ...fields,
    })),
    finalSubagent: null,
    taskList: true,
    listDelegation: true,
    selfLearning: false,
    scripts: [],
    skills: [],
  };
  return {
    kind: 'deep_agent',
    name,
    description: `Описание: ${name}`,
    content,
  };
}

/** `POST /api/library`, 201: a personal record of `session`. */
export function createRecord(
  app: TestApp,
  session: Session,
  body: CreateRecordBody,
): Promise<RecordDetail> {
  return expectBody(
    apiRequest(app, session, 'post', '/library', body),
    201,
    RecordDetailSchema,
  );
}

/** `GET /api/library/:id`, 200. */
export function getRecord(
  app: TestApp,
  session: Session,
  id: string,
): Promise<RecordDetail> {
  return expectBody(
    apiRequest(app, session, 'get', `/library/${id}`),
    200,
    RecordDetailSchema,
  );
}

/** `PUT /api/library/:id`, 200. */
export function putRecord(
  app: TestApp,
  session: Session,
  id: string,
  body: UpdateRecordBody,
): Promise<RecordDetail> {
  return expectBody(
    apiRequest(app, session, 'put', `/library/${id}`, body),
    200,
    RecordDetailSchema,
  );
}

/** `PUT /api/library/:id/audience`, 200: the record is open to exactly `roleIds`, offered in the chat. */
export function shareWith(
  app: TestApp,
  session: Session,
  id: string,
  roleIds: readonly string[],
): Promise<RecordDetail> {
  return expectBody(
    apiRequest(app, session, 'put', `/library/${id}/audience`, {
      roleIds,
      offerInChat: true,
    }),
    200,
    RecordDetailSchema,
  );
}

/** `GET /api/library`, 200: the records `session` sees. */
export function listLibrary(
  app: TestApp,
  session: Session,
): Promise<RecordSummary[]> {
  return expectBody(
    apiRequest(app, session, 'get', '/library'),
    200,
    z.array(RecordSummarySchema),
  );
}

/** `POST /api/admin/library`, 201: a system record without holders. */
export function createSystemRecord(
  app: TestApp,
  admin: Session,
  body: CreateRecordBody,
): Promise<RecordDetail> {
  return expectBody(
    apiRequest(app, admin, 'post', '/admin/library', body),
    201,
    RecordDetailSchema,
  );
}

/** `PUT /api/admin/library/:id/audience`, 200: the system record's holders. */
export function setSystemAudience(
  app: TestApp,
  admin: Session,
  id: string,
  audience: {
    readonly everyone: boolean;
    readonly roleIds?: readonly string[];
    readonly userIds?: readonly string[];
  },
): Promise<RecordDetail> {
  return expectBody(
    apiRequest(app, admin, 'put', `/admin/library/${id}/audience`, {
      everyone: audience.everyone,
      roleIds: audience.roleIds ?? [],
      userIds: audience.userIds ?? [],
      offerInChat: true,
    }),
    200,
    RecordDetailSchema,
  );
}

/** An agent of the built-in rows migration: its constant id, its key and its name. */
export interface BuiltinRecord {
  readonly id: string;
  /** `null` — an ordinary system agent (`deep-research`, data-model design-agents.md KD-4). */
  readonly builtinKey: string | null;
  readonly name: string;
}

/**
 * The agents of the built-in rows migration (`packages/db/src/migrations/0001_builtin_rows.sql`, data-model
 * design-agents.md KD-4): the three default agents every employee sees and `deep-research`, shown to everyone.
 */
export const BUILTIN = {
  chat: {
    id: '6a74a70b-e4b9-4b01-9750-20fa789b3b6c',
    builtinKey: CHAT_BUILTIN_KEY,
    name: 'Главный чат',
  },
  generalPurpose: {
    id: 'd8992d6d-6ff0-4dc6-9b33-df4f88f00b7d',
    builtinKey: 'agent',
    name: 'general-purpose',
  },
  deepAgent: {
    id: 'b7bfc31a-4fc4-4a8c-a968-05273c54de7c',
    builtinKey: 'deep_agent',
    name: 'Глубокий агент',
  },
  deepResearch: {
    id: 'fb06f3c1-a1be-4167-9896-f0d0fba21a89',
    builtinKey: null,
    name: 'Глубокий ресерч',
  },
} as const satisfies Record<string, BuiltinRecord>;

/** `GET /api/admin/library/:id`, 200. */
function panelRecord(
  app: TestApp,
  admin: Session,
  id: string,
): Promise<RecordDetail> {
  return expectBody(
    apiRequest(app, admin, 'get', `/admin/library/${id}`),
    200,
    RecordDetailSchema,
  );
}

/**
 * The models of a record by part: the agent's, or the deep agent's followed by each subagent's; `null` — the
 * default chat model.
 */
function modelsOf(record: RecordDetail): (string | null)[] {
  if (record.kind === 'skill') return [];
  return record.kind === 'agent'
    ? [record.content.model]
    : [
        record.content.model,
        ...record.content.subagents.map((subagent) => subagent.model),
      ];
}

/** The update body of `record` at its version, each part's model replaced by `modelOf(part)`. */
function withModels(
  record: RecordDetail,
  modelOf: (part: number) => string | null,
): UpdateRecordBody {
  const fields = {
    name: record.name,
    description: record.description,
    version: record.version,
  };
  if (record.kind === 'skill')
    throw new Error(`Record ${record.id} is a skill, which has no model`);
  if (record.kind === 'agent') {
    return {
      ...fields,
      kind: 'agent',
      content: { ...record.content, model: modelOf(0) },
    };
  }
  return {
    ...fields,
    kind: 'deep_agent',
    content: {
      ...record.content,
      model: modelOf(0),
      subagents: record.content.subagents.map((subagent, index) => ({
        ...subagent,
        model: modelOf(index + 1),
      })),
    },
  };
}

/** `PUT /api/admin/library/:id`, 200. */
function putSystemRecord(
  app: TestApp,
  admin: Session,
  id: string,
  body: UpdateRecordBody,
): Promise<RecordDetail> {
  return expectBody(
    apiRequest(app, admin, 'put', `/admin/library/${id}`, body),
    200,
    RecordDetailSchema,
  );
}

/**
 * Puts the run's `model` into every part of the agents of the built-in rows migration through the panel
 * routes: `chat`, `general-purpose`, the default deep agent and `deep-research`, each deep agent with every
 * subagent. A part whose model is `null` runs on the default chat model, but the developer may have given a part
 * a model of his own (the migration gives the `deep-research` deep agent one), and a suite's employees are allowed only the run's models, so without it a start
 * may be START_REFUSED. Call it after `useRunModels`; the returned restore gives each part back the model it had
 * (`null` included) and runs before the run's rows are removed. A part whose former model is no longer in the
 * catalogue cannot get it back through the panel and gets `null` (the default chat model).
 */
export async function pointBuiltinsAt(
  app: TestApp,
  admin: Session,
  model: string,
): Promise<() => Promise<void>> {
  const before: RecordDetail[] = [];
  for (const { id } of Object.values(BUILTIN)) {
    const record = await panelRecord(app, admin, id);
    before.push(record);
    await putSystemRecord(
      app,
      admin,
      id,
      withModels(record, () => model),
    );
  }
  return async () => {
    const catalogue = await catalogueModelIds(app, admin);
    for (const previous of before) {
      const previousModels = modelsOf(previous);
      const current = await panelRecord(app, admin, previous.id);
      await putSystemRecord(
        app,
        admin,
        previous.id,
        withModels(current, (part) => {
          const former = previousModels[part] ?? null;
          return former !== null && catalogue.has(former) ? former : null;
        }),
      );
    }
  };
}

/** What a suite that only needs conversations to exist gets from {@link conversationsSetup}. */
export interface ConversationsSetup {
  /** The run's default chat model: pass it to `removeRunRows`. */
  readonly model: string;
  /** The run's role, allowed the model: pass it to `removeRunRows`. */
  readonly roleId: string;
  /** The API as a new employee who may start a conversation. */
  newEmployee(): Promise<ChatApi>;
  /** Gives the platform back its default models and the built-in records theirs; run before `removeRunRows`. */
  restore(): Promise<void>;
}

/**
 * The least a first message needs to start its root (a conversation exists only from its first message): the
 * run's default chat model, the built-in records on it and a role allowed the model.
 */
export async function conversationsSetup(
  app: TestApp,
  admin: Session,
): Promise<ConversationsSetup> {
  const model = runModel('claude-haiku-5-5');
  const restoreModels = await useRunModels(app, admin, {
    chat: { id: model, ...HAIKU_TEST_PRICES },
  });
  const restoreBuiltins = await pointBuiltinsAt(app, admin, model);
  const role = await allowRole(app, admin, {
    name: 'conversations',
    models: [model],
    servers: [],
  });
  return {
    model,
    roleId: role.id,
    newEmployee: async () => {
      const session = await createEmployee(app, admin);
      await role.add(session);
      return chatApi(app, session);
    },
    restore: async () => {
      await restoreBuiltins();
      await restoreModels();
    },
  };
}

/**
 * A conversation of the employee: the id `POST /threads` hands out and its first message, which creates it.
 * Returns it as `GET /threads/:id` reads it.
 */
export async function startConversation(api: ChatApi): Promise<ThreadSummary> {
  const { id } = await api.createThread();
  await api.send(id, 'Первое сообщение беседы');
  return api.getThread(id);
}

/** One route with a record number: its method, its path under `/api` and a body that passes its schema. */
export interface LibraryRoute {
  readonly method: Method;
  readonly path: string;
  readonly body?: object;
}

/**
 * A model id that passes the body schema; no route of the walk reaches the model check, because the
 * record is looked up first.
 */
const WALK_MODEL = 'anthropic/library-route-walk';

/**
 * Every route of the library that takes a record number, with `recordId` in it (INT-1): the employee's
 * (`/api/library/:id...`) and the panel's (`/api/admin/library/:id...`). A route added to either controller
 * with a record number belongs here.
 */
export function libraryRoutes(recordId: string): {
  readonly employee: readonly LibraryRoute[];
  readonly panel: readonly LibraryRoute[];
} {
  const update = {
    ...agentBody('Обход маршрутов', { model: WALK_MODEL }),
    version: 1,
  };
  return {
    employee: [
      { method: 'get', path: `/library/${recordId}` },
      { method: 'put', path: `/library/${recordId}`, body: update },
      {
        method: 'put',
        path: `/library/${recordId}/audience`,
        body: { roleIds: [], offerInChat: false },
      },
      {
        method: 'post',
        path: `/library/${recordId}/copy`,
        body: { language: 'ru' },
      },
      { method: 'delete', path: `/library/${recordId}` },
    ],
    panel: [
      { method: 'get', path: `/admin/library/${recordId}` },
      { method: 'put', path: `/admin/library/${recordId}`, body: update },
      {
        method: 'put',
        path: `/admin/library/${recordId}/audience`,
        body: { everyone: false, roleIds: [], userIds: [], offerInChat: false },
      },
      { method: 'delete', path: `/admin/library/${recordId}` },
      { method: 'post', path: `/admin/library/${recordId}/close` },
      { method: 'delete', path: `/admin/library/${recordId}/ban` },
    ],
  };
}

/** One audit event of a library record as the assertions read it. */
export interface LibraryAuditEvent {
  readonly kind: string;
  readonly actor: string;
  readonly objectId: string;
  readonly before: Record<string, unknown> | null;
  readonly after: Record<string, unknown> | null;
  readonly outcome: string;
}

/**
 * The `app.audit_events` rows of the object type `library_record` about `recordId`, in the order written
 * (a copy's event is about the copy; the original is its `copiedFrom`).
 */
export async function auditOfRecord(
  pool: DatabaseConnection['pool'],
  recordId: string,
): Promise<LibraryAuditEvent[]> {
  const { rows } = await pool.query<LibraryAuditEvent>(
    `SELECT kind, actor, object_id AS "objectId", before, after, outcome FROM app.audit_events
      WHERE object_type = 'library_record' AND object_id = $1 ORDER BY at, id`,
    [recordId],
  );
  return rows;
}
