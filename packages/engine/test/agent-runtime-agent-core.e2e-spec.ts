// agent-runtime / agent-core E2E Test Skeletons - Design Doc: docs/features/agent-runtime/design-agent-core.md (v1.2, approved 2026-11-08)
// PRD: docs/features/agent-runtime/prd.md v1.1 (FR-02, FR-05, NFR-03). Test Strategy: UC-E3 (restart at each point of a turn), UC-E4 (restart while the parent waits). Flows 1 and 2 of the Design Doc.
// Generated: 2026-11-08 | Part: agent-core | Test type: End-to-End (real killed process + built runtime and engine + real Postgres; scripted model program), CI job `e2e-engine`
// Implementation timing: after all agent-core slices land (final phase only). Needs the engine child to load the probe process and the agent crash points (test code, never `src`).
// Counterpart in-process file: agent-runtime-agent-core.int.e2e-spec.ts (INT-1..INT-4). The runtime's own kill matrix proves the primitives; this file proves the agent's turn and its tool calls on top of them, as
// `deep-research-engine.e2e-spec.ts` E2E-2 does for v2.
//
// Generated as `it.todo` skeletons so the file loads under lint, typecheck and `vitest run` (its glob is the e2e config's, `test/**/*.e2e-spec.ts`). Do not convert a todo into a passing stub.
//
// Environment (same as deep-research E2E-2; support in place: test/support/engineChild.ts, engineChildMain.ts, engineDb.ts):
// - Postgres 16 from infra/docker-compose.yml; the compiled child (`pnpm build && pnpm build:child`, `dist/test-child/`) with `RUNTIME_CRASH_AT` for runtime points, `RUNTIME_WORKERS=on`, short `RUNTIME_LEASE_MS`, `RUNTIME_REAPER_MS`, `RUNTIME_POLL_MS`.
// - The only double is the model boundary. A dead process cannot hand its remaining script to the next one, so the double runs as the existing `fallback` PROGRAM: it answers from the call itself (the agent recognised by its prompt marker, the step from
//   the number of tool-result messages in the prompt), the same program in the dying child and in the restarted one. It lives in test code (scriptedModel.ts gains the agent role, see the int file's support list).
// - The probe process (`agent-probe`, data in test/support/test-configs.ts) is selected by the scenario: `EngineChildScenario` gains the process id, and the child registers that config instead of `deepResearchProcessV2`. No fixture source is needed.
// - Support to add (not created by this skeleton set): engineChildMain.ts - the agent crash points below in `CRASH_POINTS` (`ENGINE_CRASH_AT=<point>[:n]`, never read under `NODE_ENV=production`), built as test-code hooks: a wrapper of the model double (K2) and a hook before the reserve of a turn (K1), a `handlerHold`-style wrapper over `withAttemptGuard` (points after a guarded write) and a wrapper over the `TaskScheduler` handed to `createEngine` (points around `propose`). engineChild.ts - a scenario runner for the probe
//   (start with the same `launchKey`, kill, read what the dead child left, start a fresh child, wait for the closed investigation). engineDb.ts - snapshots of the agent tables (see the int file's support list).
// - Isolation (project convention, no truncate): a unique `resourceId` and `launchKey` per row; `fileParallelism: false`. Synchronisation only on proven states: the exit code 137 of the dying child, then rows of the test database. No latency assertions; "continues
//   after restart" is the harness timeout of the wait for the end state.
//
// Budget: E2E 1 of 2 (the second slot is left free). E2E-1 is one journey, the restart matrix of NFR-03, with the rows below; nothing at a lower level can prove it - the death of the process between two writes is not reproducible in-process (a held handler is still alive and
// can write later; a dead one cannot). The in-process zombie-attempt cases of v2 (INT-4 Z1, Z2) prove the fence, not the recovery of an agent turn.
//
// AC -> proving test: AC-02.1 = K1; AC-02.2, DC-3 = K2, K3; AC-05.4 = K4, K5, K6; NFR-03 = K1..K4 (the four points of the PRD: before the model call, after its answer, after the tool, before the write that records the wait).

import { describe, it } from 'vitest';

describe('agent-runtime / agent-core - E2E (killed process, real Postgres, scripted model program, probe process)', () => {
  // ---------------------------------------------------------------------------------------------------------------
  // E2E-1  Restart matrix: the server dies at each point of an agent turn and of a parent's wait, and the tree continues without a lost turn or a doubled effect
  // ---------------------------------------------------------------------------------------------------------------
  // User journey: an employee's investigation is running on agents -> the server is restarted (deploy, crash) at an unlucky moment -> the investigation still ends with its result, its notes are not doubled, and its children are not started twice.
  // Verification: end-to-end recovery of the agent's session, tool calls and child runs through a really killed process, with the new process continuing from the database alone.
  // Covers (original statements):
  // AC-02.1: "Given сервер остановлен между ходами агента, When сервер перезапущен, Then агент продолжает со следующего хода, и ни один сохранённый ход не выполнен заново."
  // AC-02.2: "Given сервер остановлен посреди хода, после того как инструмент этого хода уже исполнен, When ход повторяется после рестарта, Then инструмент не исполнен второй раз, а агент получает его прежний результат."
  // AC-05.4: "Given сервер перезапущен, пока родитель ждёт дочернего агента, Then после рестарта дочерний агент продолжает свою работу, родитель получает его результат, и второго запуска по тому же вызову нет."
  // NFR-03: "остановка сервера в любой точке хода агента - до вызова модели, после её ответа, после исполнения инструмента, до записи хода - не теряет ход и не исполняет инструмент дважды."
  // DC-3: "Если процесс упал после ответа модели, но до записи хода, ход выполняется заново новым вызовом модели: резерв потерянного вызова списывается полностью, как сейчас, а инструменты этого хода ещё не исполнялись."
  // Use cases: UC-E3, UC-E4. Flow 1 (whole), Flow 2 (failure handling).
  //
  // Primary failure mode (turns red when): a turn the process had already recorded is run again (a second model call and a second ledger row for the same turn); the tool of a turn whose answer was recorded runs twice (two notes); a model call lost to the crash
  //   stays an open reserve that blocks the pool or is charged half; the retry of a `call_agent` after the crash creates a second child task for the same call (two `agent.run` rows for one call), or loses a child that had already failed so the parent waits forever.
  // Behavior: question -> probe tree under a program model -> the child process exits 137 at a named point -> a new child process starts the same investigation (same `launchKey`) -> the tree ends and the investigation closes `completed`
  // @category: e2e
  // @dependency: full-system (runtime, engine, Postgres, built child process)
  // @complexity: high
  //
  // Common Then of every row (read from the rows the two processes left): the investigation is `completed`; each agent task is `succeeded`; every recorded turn appears once in the session (message numbers gap-free); every model response in the session has exactly
  //   one ledger row of the run's task; the note count is the count the program writes (one per scripted `memory_write`); the sum of per-run spend equals the investigation's charged total.
  //
  // Rows (one table; points are test-code hooks; scenario `lead` unless stated):
  //   K1 - between turns (before the reserve of turn 2): lead has recorded turn 1 (answer + tool result) and the child dies before the reserve of the next model call.
  //        Then: turn 1 is not run again (one ledger row and one model call for it in total across both processes); the run continues from turn 2 (AC-02.1); no abandoned row.
  //   K2 - after the model answered, before the turn is recorded: the double exits after producing the answer of lead's turn that asks `memory_write`, before the gateway returns it.
  //        Then: the reserve of the lost call is `abandoned` and charged in full (the whole reserve, not half); the turn is run again with ONE new model call; the note is written once (no tool of that turn ran before the crash); total model calls for the turn = 2 (DC-3).
  //        Note: "before the model call" and "after the model answered" differ only if "before" is placed BEFORE the reserve (K1) - an exit between the reserve and the double's answer leaves the same state as K2, so K2 is the single row for the lost-call case.
  //   K3 - after the tool ran, before the next step: the child dies right after the guarded write that stored the `memory_write` note and its result (the hook after that `withAttemptGuard` returns).
  //        Then: the note exists once; the tool call has its result; the restarted run does not run the tool again and the model's next view carries the first result (AC-02.2); the turn that asked for the tool is not run again.
  //   K4 - after the parent started a child, before the child's task id is recorded on the call (Flow 2 failure): the child dies after `TaskScheduler.propose` returned for the call, before the guarded write that moves the call to `waiting`.
  //        Then: after restart the parent finds the child's task by the deduplication key (any status) and records it; exactly ONE `agent.run` task and one run row exist for that call; the child finishes, the parent gets its result (AC-05.4).
  //   K5 - as K4, and the child had already failed before the process died: the child's model program ends its run with a failure (its model unavailable after the gateway's retries) in the same process, and the child process exits only after the database shows that
  //        task `failed` (the hook polls the task row; the dead process runs no worker, so the failure must happen BEFORE the kill).
  //        Then: after restart the parent finds the FAILED task by key, does NOT propose a new one (the runtime's own deduplication would not return a failed task - this is the defect), records it, is woken and gets `child_failed` (reason `model_unavailable`); there is one task for the call.
  //   K6 - restart while the parent waits: lead is `waiting` for a running helper (no write is in flight) and the child dies.
  //        Then: lead stays waiting; the helper continues from its last recorded turn; lead is woken once and receives the helper's result; one helper run for the call.
  describe('E2E-1', () => {
    it.todo('E2E-1 K1: a process killed between two turns continues with the next turn and runs no recorded turn again');
    it.todo('E2E-1 K2: a process killed after the model answered but before the turn was recorded repeats the turn with one new call, charges the lost reserve in full and writes the turn\'s note once');
    it.todo('E2E-1 K3: a process killed right after a memory write keeps one note and does not run the tool again; the next view carries its first result');
    it.todo('E2E-1 K4: a process killed after the child task was proposed and before it was recorded continues with the one child task of that call');
    it.todo('E2E-1 K5: as K4 with the child already failed, the parent receives child_failed and no second child task is created');
    it.todo('E2E-1 K6: a process killed while the parent waits resumes the child and wakes the parent once with its result');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Not observable as an assertion (reported to the caller)
// ---------------------------------------------------------------------------------------------------------------
// - Design wording of UC-E3 lists "до записи ожидания" as the fourth point; that is the K4 point (between `propose` and the write that records the task id), so the four points of the PRD map to K1 (before the call), K2 (after the answer, before the turn is recorded),
//   K3 (after the tool) and K4 (before the wait record). UC-E4 adds K5 and K6.
// - K1 can differ from K2 only by where the kill is placed relative to the reserve; the Design Doc does not say which side "before the model call" means. Chosen here: before the reserve.
// - K5 needs the child to FAIL while its parent's process is still alive and to be killed afterwards; the Design Doc's wording "helper успел провалиться до подъёма" ("before the rise") cannot happen with no worker running. The hook that waits for the failed task row before exiting makes it testable.
