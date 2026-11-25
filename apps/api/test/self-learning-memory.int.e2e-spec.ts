// self-learning / memory - API integration (real AppModule + real Postgres, workers on, scripted model)
// Design Doc: docs/features/self-learning/design-memory.md, Test Strategy UC-2 (an employee's memory reaches nobody else), UC-3
//   (rights on the two screens).
//
// Harness: one `createTestApp({ workers: true })`; each run is a deep agent started from the employee's chat (`runAgent`), its
//   answers scripted by its brief. Two employees share one self-learning deep agent of Аня's through a role they both hold.
//
// Not repeated here: versions, the check of a write, history, revert and erase, and another employee's «Моя память» record by id
//   (memory-hygiene MH-1 – MH-4); the memory of a training tree (training TR-1: the trainer's reads leave out the employee's memory,
//   a replay's `remember` writes nothing); a default agent with the flag (unit `save-rules.spec.ts`). The size and order rule of the
//   memory index has no test.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runModel } from './support/access';
import { expectError } from './support/api';
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
import { apiRequest, createEmployee } from './support/session';

const TEST_TIMEOUT_MS = 300_000;

const HOW = 'Как искать заказы';
const HOW_TEXT = 'Сначала search_orders, потом get_order';
const ANYA_PREFERENCE = 'Аня просит отчёт таблицей';
const ANYA_PREFERENCE_TEXT = 'Таблица: заказ, сумма, статус';
const TEMPORARY = 'Временная заметка';

let world: MemoryWorld | undefined;

function theWorld(): MemoryWorld {
  if (world === undefined) throw new Error('the world is not set up');
  return world;
}

describe('self-learning / memory - a run keeps the agent memory for everyone and the employee memory for its owner only', () => {
  beforeAll(async () => {
    world = await openMemoryWorld(runModel('haiku-memory'));
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    await world?.close();
  }, TEST_TIMEOUT_MS);

  // UC-1, UC-2. Catches: a record of scope user written where another employee's run reads it (index or read_memory) or lists it
  //   («Моя память»); an agent record that does not reach the next employee's run; a record the agent forgot that leaves the list
  //   instead of staying there as deleted.
  it(
    "MEM-1: Аня's run remembers in both scopes and forgets; Борис's run of the same agent sees the agent record and never Аня's; each employee lists only their own records",
    async () => {
      const w = theWorld();
      const anya = await employee(w);
      const boris = await employee(w);
      const record = await sharedAgent(w, anya);

      await runAgent(w, {
        session: anya,
        record,
        question: `Заказы Ани ${record.id}`,
        answers: [
          {
            calls: [
              memoryCall('remember', 'agent', HOW, { text: HOW_TEXT }),
              memoryCall('remember', 'user', ANYA_PREFERENCE, {
                text: ANYA_PREFERENCE_TEXT,
              }),
              memoryCall('remember', 'user', TEMPORARY, {
                text: 'скоро уйдёт',
              }),
            ],
          },
          { calls: [memoryCall('forget', 'user', TEMPORARY, { version: 1 })] },
          { text: 'Запомнил.' },
        ],
      });

      const borisRun = await runAgent(w, {
        session: boris,
        record,
        question: `Заказы Бориса ${record.id}`,
        answers: [
          {
            calls: [
              memoryCall('read_memory', 'agent', HOW),
              memoryCall('read_memory', 'user', ANYA_PREFERENCE),
            ],
          },
          { text: 'Прочитал.' },
        ],
      });

      // Борис's index names the agent record and nothing of Аня's
      const instructions = borisRun.instructions[0] ?? '';
      expect(instructions).toContain(HOW);
      expect(instructions).not.toContain(ANYA_PREFERENCE);
      expect(instructions).not.toContain(TEMPORARY);
      expect(
        borisRun.results
          .filter((result) => result.tool === 'read_memory')
          .map((result) => [result.outcome, result.text]),
      ).toEqual([
        ['success', expect.stringContaining(HOW_TEXT)],
        ['empty', 'There is no such record'],
      ]);

      // «Моя память»: the forgotten record marked deleted (changed last, so first) and the live one, Борис's none; the agent's
      //   memory holds the agent record only
      expect(
        (await myMemory(w, anya)).records.map(({ description, deleted }) => [
          description,
          deleted,
        ]),
      ).toEqual([
        [TEMPORARY, true],
        [ANYA_PREFERENCE, false],
      ]);
      expect((await myMemory(w, boris)).records).toEqual([]);
      expect(
        (await agentMemory(w, anya, record.id)).records.map(
          ({ description }) => description,
        ),
      ).toEqual([HOW]);
    },
    TEST_TIMEOUT_MS,
  );

  // UC-3. Catches: the agent's memory open to an employee who only runs the agent, or closed to the admin who sees it in the panel;
  //   an agent the employee does not see answered as forbidden instead of missing.
  it(
    "MEM-2: an agent's memory is open to its author and to an admin, 403 to an employee who only uses it, 404 to one who does not see it",
    async () => {
      const w = theWorld();
      const anya = await employee(w);
      const boris = await employee(w);
      const outsider = await createEmployee(w.harness.app, w.admin);
      w.made.users.push(outsider.id);
      const record = await sharedAgent(w, anya);
      const path = `/library/${record.id}/memory`;

      for (const session of [anya, w.admin])
        await agentMemory(w, session, record.id);
      expect(
        (await expectError(apiRequest(w.harness.app, boris, 'get', path), 403))
          .errorCode,
      ).toBe('MEMORY_FORBIDDEN');
      expect(
        (
          await expectError(
            apiRequest(w.harness.app, outsider, 'get', path),
            404,
          )
        ).errorCode,
      ).toBe('RECORD_NOT_FOUND');
    },
    TEST_TIMEOUT_MS,
  );
});
