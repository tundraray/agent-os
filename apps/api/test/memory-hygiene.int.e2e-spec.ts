// schedules-search-memory / memory-hygiene - API integration (real AppModule + real Postgres, workers on, scripted model)
// Design Doc: docs/features/schedules-search-memory/design-memory-hygiene.md, Test Strategy UC-1 (an agent writes through the check
//   and the versions), UC-2 (two edits from one version), UC-3 (rights and isolation on the screens), UC-4 (revert, conflict, erase).
//
// Harness (`./support/memory.ts`, shared with self-learning-memory.int.e2e-spec.ts): one `createTestApp({ workers: true })`; each run
//   is a deep agent with `selfLearning: true` started from the employee's chat (`runAgent`), its answers scripted by its brief;
//   employees share one deep agent of Аня's through a role they hold. Routes are called through `apiRequest` and parsed with the
//   schemas of `@agent-os/contracts`. The scripts are deterministic, so the version numbers in them are constants.
//
// Not repeated here (one defect, one test):
//   - the patterns of the check (secret, order) and every variant of them: the unit table UC-6 (`memory-check.spec.ts`); here
//     one call with `API_KEY=sk-...` in the text and one with an `sk-` token in the description prove that `remember` checks
//     both (UC-1);
//   - the dialog on the screen and its 409 text: web UC-5 (`memory-hygiene-web.int.test.tsx`);
//   - the 403 / 404 of GET /library/:id/memory: self-learning-memory MEM-2; the history, revert and erase routes get their rights
//     proof in MH-3 below;
//   - the training tree's `recorded` outcome for `remember` and `forget`: self-learning-training TR-1 (unchanged by this part).
//
// Budget: 4 integration tests here + 1 in the web file = 5, the cap. Each names its own defect (Catches lines):
//   MH-1 the tool path, MH-2 the stale-number refusal of a second run, MH-3 the rights/isolation of the new routes, MH-4 the
//   revert/erase path.
//
// Not tested anywhere: the concurrent insert path of `MemoryRecords.advance` — two writers from one version that both pass the
//   number check and meet on `ON CONFLICT (memory_id, version) DO NOTHING`. MH-2's latch holds the model calls, not the tool
//   steps, so its two edits may commit one after the other and take the early stale-number branch.
//
// acProof (for the plan):
//   AC-16.1, AC-16.2 -> unit UC-6 (table, both reasons); `remember` checks both the description and the text (the secret
//     reason, one call each) -> MH-1
//   AC-16.3, AC-17.1, AC-17.2 (+ DC-2, DC-3, DC-6) -> MH-1
//   AC-17.2 on the screen (deleted row, history link) -> web UC-5
//   AC-17.3, AC-18.2, DC-4 -> MH-3
//   AC-17.4, AC-18.1, AC-19.2 (+ DC-5) -> MH-4
//   AC-19.1 -> MH-2, the stale-number refusal only (the concurrent insert path has no test, see above)
//   NFR-05 (360 px) -> not automated: checked in a browser when the screen is built (design, NFR-05)

import { createLatch, type ScriptedReply } from '@agent-os/agents/testing';
import {
  MEMORY_TOOLS,
  MemoryHistoryViewSchema,
  type MemoryHistoryView,
  type RecordDetail,
  type RevertMemoryBody,
} from '@agent-os/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runModel } from './support/access';
import { expectBody, expectError } from './support/api';
import {
  agentMemory,
  employee,
  memoryCall,
  type MemoryWorld,
  myMemory,
  openMemoryWorld,
  runAgent,
  sharedAgent,
} from './support/memory';
import type { ToolResult } from './support/record-tools';
import { apiRequest, createEmployee, type Session } from './support/session';

const TEST_TIMEOUT_MS = 300_000;

const DESCRIPTION = 'Где лежат логи оплаты';
const GOOD = 'Логи оплаты — в billing-api';
const SECRET = 'API_KEY=sk-test0123456789abcdefghijklmn';
const SECRET_DESCRIPTION = 'Ключ sk-test0123456789abcdefghij';
const DONE: ScriptedReply = { text: 'Готово.' };

let world: MemoryWorld | undefined;

function theWorld(): MemoryWorld {
  if (world === undefined) throw new Error('the world is not set up');
  return world;
}

/** The results of the memory tools of a run, in order: outcome, refusal reason, text. */
function memoryResults(results: readonly ToolResult[]) {
  return results
    .filter((result) =>
      (MEMORY_TOOLS as readonly string[]).includes(result.tool),
    )
    .map(({ outcome, refusalReason, text }) => ({
      outcome,
      refusalReason,
      text,
    }));
}

/** The id of the agent's record of `DESCRIPTION` on the author's screen. */
async function recordIdOf(
  w: MemoryWorld,
  author: Session,
  record: RecordDetail,
): Promise<string> {
  const listed = (await agentMemory(w, author, record.id)).records.filter(
    ({ description }) => description === DESCRIPTION,
  );
  expect(listed).toHaveLength(1);
  return listed[0]?.id ?? '';
}

function history(
  w: MemoryWorld,
  session: Session,
  path: string,
): Promise<MemoryHistoryView> {
  return expectBody(
    apiRequest(w.harness.app, session, 'get', `${path}/history`),
    200,
    MemoryHistoryViewSchema,
  );
}

function revert(
  w: MemoryWorld,
  session: Session,
  path: string,
  body: RevertMemoryBody,
) {
  return apiRequest(w.harness.app, session, 'post', `${path}/revert`, body);
}

async function errorCodeOf(
  response: ReturnType<typeof apiRequest>,
  status: number,
): Promise<string | undefined> {
  return (await expectError(response, status)).errorCode;
}

/** The name and email of an employee, as the history could name them. */
async function userOf(
  w: MemoryWorld,
  userId: string,
): Promise<{ readonly name: string | null; readonly email: string }> {
  const { rows } = await w.harness.pool.query<{
    name: string | null;
    email: string;
  }>('SELECT name, email FROM app.identity_users WHERE id = $1', [userId]);
  const [user] = rows;
  if (user === undefined) throw new Error(`no user ${userId}`);
  return user;
}

describe('schedules-search-memory / memory-hygiene - a memory record keeps its versions, refuses what looks like a secret or an order, and answers to the one who may see it', () => {
  beforeAll(async () => {
    world = await openMemoryWorld(runModel('haiku-memory-hygiene'));
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    await world?.close();
  }, TEST_TIMEOUT_MS);

  // AC-16.1, AC-16.3, AC-17.1, AC-17.2, DC-2, DC-3, DC-6.
  // Catches: a check that is not wired into `remember`, or checks only the text (a secret in the text or in the description
  //   lands in memory); an edit by a stale number that overwrites a newer
  //   text (the lost update); a refused call that still adds a version or moves the pointer; `forget` that deletes the row so the
  //   history is lost; a deleted record that stays in the next step's index; a re-created record that makes a second row instead of
  //   returning the first.
  it(
    'MH-1: a run creates, edits by number, is refused a secret in the text and in the description, a taken description and a stale number, forgets and re-creates a record; the history shows five versions by the agent and every refusal changed nothing',
    async () => {
      const w = theWorld();
      const anya = await employee(w);
      const record = await sharedAgent(w, anya);
      const remember = (text: string, version?: number) =>
        memoryCall('remember', 'agent', DESCRIPTION, {
          text,
          ...(version === undefined ? {} : { version }),
        });
      const forget = (version: number) =>
        memoryCall('forget', 'agent', DESCRIPTION, { version });

      const run = await runAgent(w, {
        session: anya,
        record,
        question: `Запись с версиями ${record.id}`,
        answers: [
          { calls: [remember('первый текст')] },
          { calls: [remember('второй текст', 1)] },
          { calls: [remember('третий текст', 2)] },
          { calls: [remember(SECRET, 3)] },
          {
            calls: [
              memoryCall('remember', 'agent', SECRET_DESCRIPTION, {
                text: 'безобидный текст',
              }),
            ],
          },
          { calls: [remember('занятое описание')] },
          { calls: [forget(2)] },
          { calls: [forget(3)] },
          { calls: [memoryCall('read_memory', 'agent', DESCRIPTION)] },
          { calls: [remember('снова создан')] },
          DONE,
        ],
      });

      const results = memoryResults(run.results);
      expect(
        results.map(({ outcome, refusalReason }) => [outcome, refusalReason]),
      ).toEqual([
        ['success', null],
        ['success', null],
        ['success', null],
        ['refused', 'looks_like_secret'],
        ['refused', 'looks_like_secret'],
        ['refused', 'memory_changed'],
        ['refused', 'memory_changed'],
        ['success', null],
        ['empty', null],
        ['success', null],
      ]);
      // each `memory_changed` carries the current number and text: the refusals before it changed nothing
      for (const refusal of [results[5], results[6]]) {
        expect(refusal?.text).toContain('version 3');
        expect(refusal?.text).toContain('третий текст');
      }
      // the step after `forget` does not list the record; the step after re-creating it does again
      expect(run.instructions[8]).not.toContain(DESCRIPTION);
      expect(run.instructions[10]).toContain(DESCRIPTION);

      // the refused secret description made no record of its own
      expect(
        (await agentMemory(w, anya, record.id)).records.map(
          ({ description }) => description,
        ),
      ).toEqual([DESCRIPTION]);
      const memoryId = await recordIdOf(w, anya, record);
      const view = await history(
        w,
        anya,
        `/library/${record.id}/memory/${memoryId}`,
      );
      expect(view.description).toBe(DESCRIPTION);
      expect(
        view.versions.map(({ version, kind, text, changedBy }) => [
          version,
          kind,
          text,
          changedBy,
        ]),
      ).toEqual([
        [5, 'created', 'снова создан', null],
        [4, 'deleted', null, null],
        [3, 'changed', 'третий текст', null],
        [2, 'changed', 'второй текст', null],
        [1, 'created', 'первый текст', null],
      ]);
    },
    TEST_TIMEOUT_MS,
  );

  // AC-19.1.
  // Catches: a `remember` from a stale version number that overwrites the newer text instead of being refused, or a refusal without
  //   the current number and text. Not caught: the concurrent insert path (see the header) — the latch holds the model calls, so
  //   the two edits may commit one after the other.
  it(
    "MH-2: two runs of one agent that both read version 1 and then edit from it give exactly one new version; the other run's `remember` from the stale number is refused with memory_changed and the current text",
    async () => {
      const w = theWorld();
      const anya = await employee(w);
      const boris = await employee(w);
      const record = await sharedAgent(w, anya);
      await runAgent(w, {
        session: anya,
        record,
        question: `Первая версия ${record.id}`,
        answers: [
          {
            calls: [
              memoryCall('remember', 'agent', DESCRIPTION, { text: GOOD }),
            ],
          },
          DONE,
        ],
      });

      // both runs have read version 1 before either edits from it; their edit steps may still commit one after the other
      const latch = createLatch();
      const editRun = (session: Session, text: string) =>
        runAgent(w, {
          session,
          record,
          question: `Правка «${text}» ${record.id}`,
          answers: [
            { calls: [memoryCall('read_memory', 'agent', DESCRIPTION)] },
            {
              latch,
              calls: [
                memoryCall('remember', 'agent', DESCRIPTION, {
                  text,
                  version: 1,
                }),
              ],
            },
            DONE,
          ],
        });
      const edits = [
        { text: 'правка Ани', run: editRun(anya, 'правка Ани') },
        { text: 'правка Бориса', run: editRun(boris, 'правка Бориса') },
      ];
      await latch.reached(2);
      latch.open();
      const outcomes = await Promise.all(
        edits.map(async ({ text, run }) => {
          const [read, edit] = memoryResults((await run).results);
          expect(read?.text).toContain(GOOD);
          return { text, edit };
        }),
      );

      const winners = outcomes.filter(
        ({ edit }) => edit?.outcome === 'success',
      );
      const losers = outcomes.filter(
        ({ edit }) => edit?.refusalReason === 'memory_changed',
      );
      expect([winners.length, losers.length]).toEqual([1, 1]);
      const winnerText = winners[0]?.text ?? '';
      expect(losers[0]?.edit?.text).toContain('version 2');
      expect(losers[0]?.edit?.text).toContain(winnerText);

      const memoryId = await recordIdOf(w, anya, record);
      const view = await history(
        w,
        anya,
        `/library/${record.id}/memory/${memoryId}`,
      );
      expect(view.versions.map(({ version, text }) => [version, text])).toEqual(
        [
          [2, winnerText],
          [1, GOOD],
        ],
      );
    },
    TEST_TIMEOUT_MS,
  );

  // AC-17.3, AC-18.2, DC-4.
  // Catches: a history that names the employee in whose run the agent edited (a privacy leak the schema must make impossible); a
  //   revert or erase route that skips `LibraryService.memoryTarget` and lets a user of the agent or another employee act on a
  //   record; an erase of someone else's «Моя память» record that actually erases.
  it(
    "MH-3: the author's history never names the employee whose run edited; an employee who only runs the agent gets 403 on history and revert; another employee's «Моя память» record answers 404 / 404 / 204 and stays untouched",
    async () => {
      const w = theWorld();
      const anya = await employee(w);
      const boris = await employee(w);
      const outsider = await createEmployee(w.harness.app, w.admin);
      w.made.users.push(outsider.id);
      const record = await sharedAgent(w, anya);
      await runAgent(w, {
        session: anya,
        record,
        question: `Запись Ани ${record.id}`,
        answers: [
          {
            calls: [
              memoryCall('remember', 'agent', DESCRIPTION, { text: GOOD }),
            ],
          },
          DONE,
        ],
      });
      await runAgent(w, {
        session: boris,
        record,
        question: `Правка Бориса ${record.id}`,
        answers: [
          { calls: [memoryCall('read_memory', 'agent', DESCRIPTION)] },
          {
            calls: [
              memoryCall('remember', 'agent', DESCRIPTION, {
                text: 'текст из запуска Бориса',
                version: 1,
              }),
              memoryCall('remember', 'user', 'Борис любит краткость', {
                text: 'Отвечать коротко',
              }),
            ],
          },
          DONE,
        ],
      });

      // the author's history: the edit of Борис's run, and nothing of Борис anywhere in the body
      const memoryId = await recordIdOf(w, anya, record);
      const agentPath = `/library/${record.id}/memory/${memoryId}`;
      const before = await history(w, anya, agentPath);
      expect(before.versions.map(({ version }) => version)).toEqual([2, 1]);
      expect(before.versions.every(({ changedBy }) => changedBy === null)).toBe(
        true,
      );
      const borisUser = await userOf(w, boris.id);
      const body = JSON.stringify(before);
      for (const trace of [boris.id, borisUser.name, borisUser.email])
        if (trace) expect(body).not.toContain(trace);

      // Борис only runs the agent: 403 on its record's history and revert, and nothing changes
      expect(
        await errorCodeOf(
          apiRequest(w.harness.app, boris, 'get', `${agentPath}/history`),
          403,
        ),
      ).toBe('MEMORY_FORBIDDEN');
      expect(
        await errorCodeOf(
          revert(w, boris, agentPath, { version: 1, expectedVersion: 2 }),
          403,
        ),
      ).toBe('MEMORY_FORBIDDEN');
      expect(
        await errorCodeOf(
          apiRequest(w.harness.app, boris, 'delete', agentPath),
          403,
        ),
      ).toBe('MEMORY_FORBIDDEN');
      expect(await history(w, anya, agentPath)).toEqual(before);
      // the admin sees the agent in the panel; an employee who does not see it gets 404
      await history(w, w.admin, agentPath);
      expect(
        await errorCodeOf(
          apiRequest(w.harness.app, outsider, 'get', `${agentPath}/history`),
          404,
        ),
      ).toBe('RECORD_NOT_FOUND');
      expect(
        await errorCodeOf(
          apiRequest(w.harness.app, outsider, 'delete', agentPath),
          404,
        ),
      ).toBe('RECORD_NOT_FOUND');
      expect(await history(w, anya, agentPath)).toEqual(before);

      // Аня on Борис's «Моя память» record: 404, 404, 204, and it stays as it was
      const borisMemory = await myMemory(w, boris);
      const [borisRecord] = borisMemory.records;
      const mine = `/memory/${borisRecord?.id}`;
      const borisHistory = await history(w, boris, mine);
      expect(
        await errorCodeOf(
          apiRequest(w.harness.app, anya, 'get', `${mine}/history`),
          404,
        ),
      ).toBe('RECORD_NOT_FOUND');
      expect(
        await errorCodeOf(
          revert(w, anya, mine, { version: 1, expectedVersion: 1 }),
          404,
        ),
      ).toBe('RECORD_NOT_FOUND');
      await apiRequest(w.harness.app, anya, 'delete', mine).expect(204);
      expect(await myMemory(w, boris)).toEqual(borisMemory);
      expect(await history(w, boris, mine)).toEqual(borisHistory);
    },
    TEST_TIMEOUT_MS,
  );

  // AC-17.4, AC-18.1, AC-19.2, DC-5.
  // Catches: a revert that ignores `expectedVersion` and overwrites the agent's newer change; a revert that adds a version of an
  //   impossible source (current or text-less); a deleted record a revert cannot bring back; an erase that leaves the version rows
  //   (the secret stays in the database) or a foreign key that blocks the erase.
  it(
    'MH-4: a revert by a stale number is 409, the same revert after re-reading adds «reverted» and the next run reads the good text; reverting the current, a deleted or an unknown version is 400; erase leaves no record and no version rows',
    async () => {
      const w = theWorld();
      const anya = await employee(w);
      const record = await sharedAgent(w, anya);
      const remember = (text: string, version?: number) =>
        memoryCall('remember', 'agent', DESCRIPTION, {
          text,
          ...(version === undefined ? {} : { version }),
        });
      await runAgent(w, {
        session: anya,
        record,
        question: `Хорошая и плохая ${record.id}`,
        answers: [
          { calls: [remember(GOOD)] },
          { calls: [remember('испорченный текст', 1)] },
          DONE,
        ],
      });
      const memoryId = await recordIdOf(w, anya, record);
      const path = `/library/${record.id}/memory/${memoryId}`;
      const versionCount = async () =>
        (await history(w, anya, path)).versions.length;

      // the author opened the history at version 2; the agent changes the record after that
      expect((await history(w, anya, path)).versions[0]?.version).toBe(2);
      await runAgent(w, {
        session: anya,
        record,
        question: `Новая правка агента ${record.id}`,
        answers: [{ calls: [remember('новая правка агента', 2)] }, DONE],
      });
      expect(
        await errorCodeOf(
          revert(w, anya, path, { version: 1, expectedVersion: 2 }),
          409,
        ),
      ).toBe('RECORD_VERSION_CONFLICT');
      const reread = await history(w, anya, path);
      expect(reread.versions[0]).toMatchObject({
        version: 3,
        kind: 'changed',
        text: 'новая правка агента',
        changedBy: null,
      });

      const reverted = await expectBody(
        revert(w, anya, path, { version: 1, expectedVersion: 3 }),
        200,
        MemoryHistoryViewSchema,
      );
      // a person's version names them: by name, without one by email (KD-6)
      const anyaUser = await userOf(w, anya.id);
      const anyaName = anyaUser.name || anyaUser.email;
      expect(reverted.versions[0]).toMatchObject({
        version: 4,
        kind: 'reverted',
        text: GOOD,
        changedBy: anyaName,
      });

      // the next run lists the description and reads the good text; then it deletes the record
      const next = await runAgent(w, {
        session: anya,
        record,
        question: `Чтение после возврата ${record.id}`,
        answers: [
          { calls: [memoryCall('read_memory', 'agent', DESCRIPTION)] },
          {
            calls: [memoryCall('forget', 'agent', DESCRIPTION, { version: 4 })],
          },
          DONE,
        ],
      });
      expect(next.instructions[0]).toContain(DESCRIPTION);
      expect(memoryResults(next.results)).toEqual([
        expect.objectContaining({
          outcome: 'success',
          text: expect.stringContaining(GOOD),
        }),
        expect.objectContaining({ outcome: 'success' }),
      ]);

      // the current version (deleted), an unknown number: 400 and no new version
      for (const body of [
        { version: 5, expectedVersion: 5 },
        { version: 99, expectedVersion: 5 },
      ])
        expect(await errorCodeOf(revert(w, anya, path, body), 400)).toBe(
          'VALIDATION_FAILED',
        );
      expect(await versionCount()).toBe(5);

      // a revert brings the deleted record back live
      await expectBody(
        revert(w, anya, path, { version: 1, expectedVersion: 5 }),
        200,
        MemoryHistoryViewSchema,
      );
      const listed = (await agentMemory(w, anya, record.id)).records;
      expect(listed.map(({ id, deleted }) => [id, deleted])).toEqual([
        [memoryId, false],
      ]);
      // a deleted version that is not current, the live current one: 400
      for (const body of [
        { version: 5, expectedVersion: 6 },
        { version: 6, expectedVersion: 6 },
      ])
        expect(await errorCodeOf(revert(w, anya, path, body), 400)).toBe(
          'VALIDATION_FAILED',
        );
      expect(await versionCount()).toBe(6);

      // erase: the record and every version row leave the database, and the next run's index
      await apiRequest(w.harness.app, anya, 'delete', path).expect(204);
      expect(
        await errorCodeOf(
          apiRequest(w.harness.app, anya, 'get', `${path}/history`),
          404,
        ),
      ).toBe('RECORD_NOT_FOUND');
      expect((await agentMemory(w, anya, record.id)).records).toEqual([]);
      const { rows } = await w.harness.pool.query<{ count: string }>(
        'SELECT count(*) AS count FROM app.memory_versions WHERE memory_id = $1',
        [memoryId],
      );
      expect(rows[0]?.count).toBe('0');
      const after = await runAgent(w, {
        session: anya,
        record,
        question: `После стирания ${record.id}`,
        answers: [DONE],
      });
      expect(after.instructions[0]).not.toContain(DESCRIPTION);
    },
    TEST_TIMEOUT_MS,
  );
});
