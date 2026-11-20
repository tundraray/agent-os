import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import {
  CHAT_BUILTIN_KEY,
  CreateCatalogModelBodySchema,
  RecordDetailSchema,
  RecordSummarySchema,
  type AgentContent,
  type CreateRecordBody,
  type RecordDetail,
  type RecordSummary,
  type UpdateRecordBody,
  type WorkflowContent,
} from '@agent-os/contracts';
import type { DatabaseConnection } from '@agent-os/db';
import type { App } from 'supertest/types.js';
import { z } from 'zod';
import { builtinRecords } from '../../src/library/builtin-records.js';
import { expectBody } from './api.js';
import { apiRequest, type Method, type Session } from './session.js';

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
      ...content,
    },
  };
}

/** The body of a workflow record with one executor, the coordinator and the executor on `model`. */
export function workflowBody(
  name: string,
  model: string,
): Extract<CreateRecordBody, { kind: 'workflow' }> {
  const content: WorkflowContent = {
    coordinator: { rules: '', model, maxTurns: 20 },
    executors: [
      {
        name: 'Аналитик',
        role: 'Разбирает вопрос и пишет отчёт',
        prompt: `Промпт исполнителя ${name}`,
        servers: [],
        model,
        maxTurns: 20,
        maxRuns: 3,
        tools: [],
        source: null,
      },
    ],
    finalExecutor: null,
  };
  return {
    kind: 'workflow',
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

/** A built-in record as the app seeds it (`builtin-records.ts`): its fixed id, its key and its name. */
export interface BuiltinRecord {
  readonly id: string;
  readonly builtinKey: string;
  readonly name: string;
}

/** Ids, keys and names of the built-in records do not depend on the model of the seed; any model id reads them. */
const SEEDED = builtinRecords('anthropic/builtin-record-ids');

function seeded(builtinKey: string): BuiltinRecord {
  const record = SEEDED.find(
    (candidate) => candidate.builtinKey === builtinKey,
  );
  if (record === undefined)
    throw new Error(`No built-in record "${builtinKey}" is seeded`);
  return { id: record.id, builtinKey, name: record.name };
}

/** The three built-in records every employee sees (design-runtime.md, KD-7). */
export const BUILTIN = {
  chat: seeded(CHAT_BUILTIN_KEY),
  generalPurpose: seeded('general-purpose'),
  deepResearch: seeded('deep-research'),
} as const;

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

/** The models of a record by part: the agent's, or the coordinator's followed by each executor's. */
function modelsOf(record: RecordDetail): string[] {
  return record.kind === 'agent'
    ? [record.content.model]
    : [
        record.content.coordinator.model,
        ...record.content.executors.map((executor) => executor.model),
      ];
}

/** The update body of `record` at its version, each part's model replaced by `modelOf(current, part)`. */
function withModels(
  record: RecordDetail,
  modelOf: (current: string, part: number) => string,
): UpdateRecordBody {
  const fields = {
    name: record.name,
    description: record.description,
    version: record.version,
  };
  if (record.kind === 'agent') {
    return {
      ...fields,
      kind: 'agent',
      content: { ...record.content, model: modelOf(record.content.model, 0) },
    };
  }
  const { coordinator, executors } = record.content;
  return {
    ...fields,
    kind: 'workflow',
    content: {
      ...record.content,
      coordinator: { ...coordinator, model: modelOf(coordinator.model, 0) },
      executors: executors.map((executor, index) => ({
        ...executor,
        model: modelOf(executor.model, index + 1),
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

/** `GET /api/admin/models`, 200: the ids of the catalogue. */
async function catalogueModels(
  app: TestApp,
  admin: Session,
): Promise<Set<string>> {
  const models = await expectBody(
    apiRequest(app, admin, 'get', '/admin/models'),
    200,
    z.array(CreateCatalogModelBodySchema),
  );
  return new Set(models.map((model) => model.id));
}

/**
 * Puts the run's `model` into every part of the built-in records through the panel routes: `chat`,
 * `general-purpose`, and the coordinator and each executor of `deep-research`. The root's model is the
 * `chat` record's and a suite's employees are allowed only the run's models, so without it every root start
 * is START_REFUSED. Call it after `addModel(model)`; the returned restore gives each part back the model it
 * had and runs before the run's rows are removed. A part whose former model is no longer in the catalogue (a
 * model an earlier run seeded and then removed, as on a clean CI database) cannot get it back through the
 * panel and keeps `model`: the next suite points it at its own model again.
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
    const catalogue = await catalogueModels(app, admin);
    for (const previous of before) {
      const previousModels = modelsOf(previous);
      const current = await panelRecord(app, admin, previous.id);
      await putSystemRecord(
        app,
        admin,
        previous.id,
        withModels(current, (currentModel, part) => {
          const former = previousModels[part];
          return former !== undefined && catalogue.has(former)
            ? former
            : currentModel;
        }),
      );
    }
  };
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
      { method: 'post', path: `/library/${recordId}/copy` },
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
