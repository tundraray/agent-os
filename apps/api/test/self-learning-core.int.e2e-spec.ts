// self-learning / core - API integration (real AppModule + real Postgres, no model call)
// Design Doc: docs/features/self-learning/design-core.md (v1.3), Test Strategy UC-8, KD-7, Flow 3, Contract `KnowledgeView`; PRD: docs/features/self-learning/prd.md v1.3 FR-09.
// Generated: 2026-11-19; updated 2026-11-20 for Design Doc v1.2 (`state`, `placement`, `selection`, `counts` in the response); implemented 2026-11-20 (Task 8.5).
// Part: core. THE PART'S BUDGET, THE FULL acProof AND THE LIST OF UNIT TABLES ARE IN `packages/agents/test/self-learning-core.int.e2e-spec.ts`
//   (one place; this file holds INT-9 of 12).
// Test Type: Integration. Run with the api e2e config (`*.e2e-spec.ts`), like the other `*.int.e2e-spec.ts` files of this folder.
//
// Harness (follows custom-agents-library.int.e2e-spec.ts and enterprise-access-identity.int.e2e-spec.ts):
//   one `createTestApp()` against the docker-compose Postgres, the real AppModule with the real SessionGuard, `LibraryService`, `Agents.knowledge`
//   and `AuditLog`; the model is never called, the workers are off. Employees from `insertEmployee` + `signInWithPassword`, the administrator
//   from `seedSuperAdmin`, a role and its members through the existing admin routes (`allowRole`); the run's default chat model from
//   `useRunModels`, the default embedding model set to `null` for the file (`clearEmbeddingModel`) and put back by the `useRunModels` restore
//   in `afterAll`. Responses parsed with the `KnowledgeView` schema of `@agent-os/contracts`; the raw body is compared too, because the schema
//   drops unknown fields.
//   Support (`test/support/knowledge.ts`): `seedKnowledge(pool, recordId)` writes two entities and a fact relation between them, with the run
//   source columns set, straight into `app.agent_knowledge_*` (the extraction pipeline is not exercised here); `removeKnowledgeTasks` deletes
//   the platform's vector passes the deletions queue. The `knowledge_delete` rows are read with `auditOfRecord` of `support/library.ts`.
//   The graph rows go with their workflows, the workflows with their authors (`removeRunRows`).
//   v1.2: the test database image must carry pgvector (`pgvector/pgvector:pg16`, the migration requires the extension) - the same gap as in the
//   agents file's header; no embedding double is needed here, the file runs with no embedding model selected and no model call is made.
//
// Proven elsewhere: the 401 and `ADMIN_REQUIRED` of the settings routes (route walk of enterprise-access-identity INT-1); the settings bounds
//   (contract schema row); the `LibraryService.knowledgeTarget` rule rows are exercised only through this file's rows - one proof; the
//   computation of `placement`, `state`, `counts` and `selection` values (`selectKnowledge` unit table of the agents file) - row 1 here
//   proves only that the route returns the fields the contract schema names, with the values of a graph that fits and no embedding model.

import { randomUUID } from 'node:crypto';
import { KnowledgeViewSchema, type KnowledgeView } from '@agent-os/contracts';
import type { Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  allowRole,
  HAIKU_TEST_PRICES,
  removeRunRows,
  runModel,
  type RunRole,
  useRunModels,
} from './support/access';
import { expectBody, expectError } from './support/api';
import { createTestApp, type TestApp } from './support/createTestApp';
import {
  clearEmbeddingModel,
  removeKnowledgeTasks,
  seedKnowledge,
  type SeededGraph,
} from './support/knowledge';
import {
  auditOfRecord,
  createRecord,
  recordName,
  shareWith,
  workflowBody,
  type LibraryAuditEvent,
} from './support/library';
import {
  apiRequest,
  insertEmployee,
  seedSuperAdmin,
  signInWithPassword,
  type Session,
} from './support/session';

/** Bound of one test; the requests settle far sooner. */
const TEST_TIMEOUT_MS = 180_000;

/** The platform's default chat model while the file runs (`useRunModels`): the model of every workflow of the file. */
const DEFAULT_MODEL = runModel('haiku');

/** The password of every employee the file inserts. */
const PASSWORD = 'e2e-knowledge-password-12';

let harness: TestApp;
let admin: Session;
/** Gives the platform back its default models, the embedding model included; run in `afterAll` before the run's rows go. */
let restoreModels: (() => Promise<void>) | undefined;

/** What this file created; `afterAll` deletes exactly these rows (the workflows go with their authors). */
const createdUserIds = new Set<string>();
const createdRoleIds = new Set<string>();
const workflowIds = new Set<string>();

/** A new employee of the run, signed in and remembered for the cleanup. */
async function newEmployee(tag: string, name: string): Promise<Session> {
  const login = `e2e-knowledge-${tag}-${randomUUID()}`;
  const id = await insertEmployee(harness.pool, {
    login,
    name,
    password: PASSWORD,
  });
  createdUserIds.add(id);
  return signInWithPassword(harness.app, login, PASSWORD);
}

/** A role of the run allowed the default model, remembered for the cleanup. */
async function newRole(name: string): Promise<RunRole> {
  const role = await allowRole(harness.app, admin, {
    name,
    models: [DEFAULT_MODEL],
    servers: [],
  });
  createdRoleIds.add(role.id);
  return role;
}

/** A personal self-learning workflow of `author` with its graph seeded. */
async function newWorkflow(
  author: Session,
  base: string,
): Promise<{ id: string; graph: SeededGraph }> {
  const body = workflowBody(recordName(base), DEFAULT_MODEL);
  const record = await createRecord(harness.app, author, {
    ...body,
    content: { ...body.content, selfLearning: true },
  });
  workflowIds.add(record.id);
  return { id: record.id, graph: await seedKnowledge(harness.pool, record.id) };
}

const knowledgePath = (recordId: string) => `/library/${recordId}/knowledge`;
const entityPath = (recordId: string, entityId: number) =>
  `${knowledgePath(recordId)}/entities/${entityId}`;
const relationPath = (recordId: string, relationId: number) =>
  `${knowledgePath(recordId)}/relations/${relationId}`;

function getKnowledge(session: Session, recordId: string): Promise<Response> {
  return apiRequest(harness.app, session, 'get', knowledgePath(recordId));
}

/** `GET .../knowledge`, 200: the raw body (unknown fields kept), checked against the contract schema. */
async function viewOf(
  session: Session,
  recordId: string,
): Promise<KnowledgeView> {
  const response = await getKnowledge(session, recordId);
  await expectBody(response, 200, KnowledgeViewSchema);
  return response.body;
}

/** `DELETE` of a graph item: 204 with no body. */
async function expectDeleted(session: Session, path: string): Promise<void> {
  const response = await apiRequest(harness.app, session, 'delete', path);
  expect(response.status, `DELETE ${path}`).toBe(204);
  expect(response.text, `DELETE ${path}`).toBe('');
}

/** Fails unless the response is `status` with `errorCode`; returns the raw body text. */
async function expectRefusal(
  response: Promise<Response> | Response,
  status: number,
  errorCode: string,
): Promise<string> {
  const answered = await response;
  const body = await expectError(answered, status);
  expect(body.errorCode).toBe(errorCode);
  return answered.text;
}

/** The GET and both DELETEs of `recordId` (on its own seeded items), each answered `status` with `errorCode`; the raw bodies. */
async function expectAllRefused(
  session: Session,
  workflow: { id: string; graph: SeededGraph },
  status: number,
  errorCode: string,
): Promise<string[]> {
  return [
    await expectRefusal(getKnowledge(session, workflow.id), status, errorCode),
    await expectRefusal(
      apiRequest(
        harness.app,
        session,
        'delete',
        entityPath(workflow.id, workflow.graph.from.id),
      ),
      status,
      errorCode,
    ),
    await expectRefusal(
      apiRequest(
        harness.app,
        session,
        'delete',
        relationPath(workflow.id, workflow.graph.relation.id),
      ),
      status,
      errorCode,
    ),
  ];
}

/** The view's items as the contract shows them for the seeded graph: active, no placement, no run or employee field. */
function entityItem(entity: SeededGraph['from']) {
  return {
    type: 'entity',
    kind: 'fact',
    id: entity.id,
    confirmations: entity.confirmations,
    date: entity.date,
    state: 'active',
    placement: null,
    name: entity.name,
    description: entity.description,
  };
}

function relationItem(graph: SeededGraph) {
  return {
    type: 'relation',
    kind: 'fact',
    id: graph.relation.id,
    confirmations: graph.relation.confirmations,
    date: graph.relation.date,
    state: 'active',
    placement: null,
    from: { id: graph.from.id, name: graph.from.name },
    to: { id: graph.to.id, name: graph.to.name },
    label: graph.relation.label,
  };
}

/** The whole seeded graph in the common order: `from` (2 confirmations), the relation (newer), `to`. */
function seededItems(graph: SeededGraph) {
  return [entityItem(graph.from), relationItem(graph), entityItem(graph.to)];
}

/** The `knowledge_delete` audit rows of a workflow, in the order written. */
async function knowledgeDeletes(
  recordId: string,
): Promise<LibraryAuditEvent[]> {
  return (await auditOfRecord(harness.pool, recordId)).filter(
    (event) => event.kind === 'knowledge_delete',
  );
}

describe('self-learning / core - API integration (real AppModule + real Postgres, no model)', () => {
  beforeAll(async () => {
    harness = await createTestApp();
    admin = await seedSuperAdmin(
      harness.app,
      `e2e-knowledge-admin-${randomUUID()}`,
    );
    createdUserIds.add(admin.id);
    restoreModels = await useRunModels(harness.app, admin, {
      chat: { id: DEFAULT_MODEL, ...HAIKU_TEST_PRICES },
    });
    // Row 1 expects selection `off` / `model_not_selected`: the restore above puts the embedding model back.
    await clearEmbeddingModel(harness.app, admin);
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    if (harness !== undefined) {
      await restoreModels?.();
      await removeKnowledgeTasks(harness.pool, [...workflowIds]);
      await removeRunRows(harness.pool, {
        models: [DEFAULT_MODEL],
        roles: [...createdRoleIds],
        users: [...createdUserIds],
      });
    }
    await harness?.close();
  }, TEST_TIMEOUT_MS);

  // ---------------------------------------------------------------------------------------------------------------
  // INT-9: who may read and clean the graph - one route family, four actors
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-09.1 "Given сотрудник может запускать ролевой workflow, но не его автор, when он запрашивает граф этого workflow, then получает
  //   отказ и не видит ни одной записи"; AC-09.3 "Given workflow сотрудника открыт роли, when администратор запрашивает его граф, then видит
  //   записи; given workflow личный, не открытый ни одной роли, then администратор получает отказ"; AC-09.2 (delete entity -> its fact
  //   relations are gone). Design: UC-8, KD-7, DC-2, DC-10, auth-boundary pattern.
  // Behavior: the actor calls `GET /api/library/:id/knowledge` and the two `DELETE .../knowledge/entities/:entityId` and
  //   `.../relations/:relationId` routes -> `LibraryService.knowledgeTarget` (author, or administrator when the workflow is in the panel) ->
  //   status and body.
  // Rows (literal status and `errorCode`; the refused rows run GET and both DELETEs; the administrator's 200 row runs GET only, so the graph
  //   stays whole for row 5):
  //   1. Аня (author) of a role-shared workflow whose graph fits the limit, no embedding model selected: GET 200 parsed by the `KnowledgeView`
  //      schema; `selection` = `off` / `model_not_selected` / model `null`; `counts` for the seeded graph (`active` 3, `always` = all
  //      `active` because all fit, `beyond` 0, `outdated` 0, `percent` 1..100 - its value depends on the developer's limit); each item has
  //      `state` `active`, `placement` `null`, `confirmations`, a date, and no run or employee field (the raw body equals the literal items).
  //   2. Борис (runs it through the role, not the author): 403 `KNOWLEDGE_FORBIDDEN`, no item in the body; the graph is unchanged after his
  //      DELETEs and no `knowledge_delete` row is written.
  //   3. the administrator on the role-shared workflow (it is in the panel): GET 200 with the items.
  //   4. the administrator on Борис's personal workflow, shared with no role: 404 `RECORD_NOT_FOUND` on GET and both DELETEs, byte-for-byte
  //      the body of a missing record; Борис himself: GET 200 with his whole graph.
  //   5. Аня deletes an entity: 204, its fact relation is gone from the next GET, one `knowledge_delete` audit row holding the record number,
  //      kind, entry id and relation count and none of the entries' text; the same DELETE again: 204 and still one audit row. Item numbers of
  //      Борис's workflow through Аня's route: 204, his graph unchanged, no audit row on either workflow (DC-10).
  // Catches: any employee who may merely run a workflow reading or deleting its shared graph, an administrator reaching a workflow that is not in
  //   the panel (the 404 vs 403 split leaking that a private workflow exists), or the audit keeping the very text the delete removes (secrets, personal data).
  // @category: core-functionality
  // @dependency: KnowledgeController, LibraryService.knowledgeTarget, Agents.knowledge, AuditLog, SessionGuard, Postgres
  // @complexity: medium
  it(
    'INT-9: the author and the administrator of a panel-visible workflow read and clean the graph; other runners get 403, invisible workflows 404, the audit holds no text',
    async () => {
      const team = await newRole('Платежи');
      const anya = await newEmployee('anya', 'Аня');
      const boris = await newEmployee('boris', 'Борис');
      await team.add(anya);
      await team.add(boris);
      const shared = await newWorkflow(anya, 'Разбор платежей');
      await shareWith(harness.app, anya, shared.id, [team.id]);
      const personal = await newWorkflow(boris, 'Личный разбор');

      // Row 1: the author reads the graph.
      const anyaView = await viewOf(anya, shared.id);
      expect(Object.keys(anyaView).sort()).toEqual([
        'counts',
        'items',
        'lastExtraction',
        'lessonsEnabled',
        'selection',
        'selfLearning',
      ]);
      expect(anyaView.selfLearning).toBe(true);
      expect(anyaView.selection).toEqual({
        state: 'off',
        reason: 'model_not_selected',
        model: null,
      });
      expect(anyaView.counts).toMatchObject({
        active: 3,
        always: 3,
        beyond: 0,
        outdated: 0,
      });
      expect(anyaView.counts.percent).toBeGreaterThanOrEqual(1);
      expect(anyaView.counts.percent).toBeLessThanOrEqual(100);
      expect(anyaView.items).toEqual(seededItems(shared.graph));
      expect(anyaView.lastExtraction).toBeNull();

      // Row 2: a runner who is not the author gets 403 on every route, sees no item and deletes nothing.
      const refusedBodies = await expectAllRefused(
        boris,
        shared,
        403,
        'KNOWLEDGE_FORBIDDEN',
      );
      for (const body of refusedBodies) {
        expect(body).not.toContain(shared.graph.from.name);
        expect(body).not.toContain(shared.graph.relation.label);
      }
      expect((await viewOf(anya, shared.id)).items).toEqual(
        seededItems(shared.graph),
      );
      expect(await knowledgeDeletes(shared.id)).toEqual([]);

      // Row 3: the administrator reads a workflow that is in the panel.
      expect(await viewOf(admin, shared.id)).toEqual(anyaView);

      // Row 4: a personal workflow shared with no role is missing for the administrator, byte for byte.
      const missing = await expectRefusal(
        getKnowledge(admin, randomUUID()),
        404,
        'RECORD_NOT_FOUND',
      );
      for (const body of await expectAllRefused(
        admin,
        personal,
        404,
        'RECORD_NOT_FOUND',
      ))
        expect(body).toBe(missing);
      expect((await viewOf(boris, personal.id)).items).toEqual(
        seededItems(personal.graph),
      );
      expect(await knowledgeDeletes(personal.id)).toEqual([]);

      // Row 5: the author deletes an entity; its fact relation goes with it; the audit names the entry, not its text.
      const deletedEntity = entityPath(shared.id, shared.graph.from.id);
      await expectDeleted(anya, deletedEntity);
      const afterDelete = await viewOf(anya, shared.id);
      expect(afterDelete.items).toEqual([entityItem(shared.graph.to)]);
      expect(afterDelete.counts).toMatchObject({
        active: 1,
        always: 1,
        beyond: 0,
        outdated: 0,
      });
      const deletes = await knowledgeDeletes(shared.id);
      expect(deletes).toEqual([
        {
          kind: 'knowledge_delete',
          actor: anya.id,
          objectId: shared.id,
          before: null,
          after: { type: 'entity', id: shared.graph.from.id, relations: 1 },
          outcome: 'ok',
        },
      ]);
      const storedRow = JSON.stringify(deletes);
      for (const text of [
        shared.graph.from.name,
        shared.graph.from.description,
        shared.graph.relation.label,
      ])
        expect(storedRow).not.toContain(text);

      // The same delete again: nothing is there, 204 and no second audit row.
      await expectDeleted(anya, deletedEntity);
      expect(await knowledgeDeletes(shared.id)).toHaveLength(1);

      // Item numbers of another workflow through this workflow's route: 204, nothing deleted, no audit row.
      await expectDeleted(anya, entityPath(shared.id, personal.graph.from.id));
      await expectDeleted(
        anya,
        relationPath(shared.id, personal.graph.relation.id),
      );
      expect((await viewOf(boris, personal.id)).items).toEqual(
        seededItems(personal.graph),
      );
      expect(await knowledgeDeletes(shared.id)).toHaveLength(1);
      expect(await knowledgeDeletes(personal.id)).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );
});
