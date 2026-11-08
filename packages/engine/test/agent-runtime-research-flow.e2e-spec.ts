// agent-runtime / research-flow E2E Test Skeletons (engine side) - Design Doc: docs/features/agent-runtime/design-research-flow.md (v1.3, approved 2026-11-08)
// PRD: docs/features/agent-runtime/prd.md v1.1 (FR-12, FR-15; NFR-03 for the research forms). Test Strategy: UC-E5 (restart in the middle of the closure). Flow 1 and Flow 2 of the Design Doc ("Failure handling": the process dies after the model's answer).
// Generated: 2026-11-08 | Part: research-flow | Test type: End-to-End (real killed process + built runtime and engine + real Postgres; scripted model program; the shipped v3 configuration), CI job `e2e-engine`
// Implementation timing: after all research-flow slices land (final phase only). Needs the engine child to load the shipped v3 and the crash points around the form closure (test code, never `src`).
// Counterpart in-process file: agent-runtime-research-flow.int.e2e-spec.ts (INT-1..INT-4). The agent-core kill matrix (agent-runtime-agent-core.e2e-spec.ts, E2E-1 K1..K6) proves the agent's turn, its tools and its child runs under a killed process;
// this file proves only what the research forms add on top: the closure of a form and its write are ONE record with the run's result, so a restart neither loses a verification / an answer nor writes it twice.
//
// Generated as `it.todo` skeletons so the file loads under lint, typecheck and `vitest run` (its glob is the e2e config's, `test/**/*.e2e-spec.ts`). Do not convert a todo into a passing stub.
//
// Environment (same as agent-core E2E-1; support in place: test/support/engineChild.ts, engineChildMain.ts, engineDb.ts; the agent additions of agent-core are assumed done):
// - Postgres 16 from infra/docker-compose.yml; the compiled child (`pnpm build && pnpm build:child`, `dist/test-child/`) with `RUNTIME_WORKERS=on`, short `RUNTIME_LEASE_MS`, `RUNTIME_REAPER_MS`, `RUNTIME_POLL_MS`.
// - The only double is the model boundary, as the `fallback` PROGRAM that answers from the call itself (the agent recognised by the leading text of its loaded system prompt, the step from the number of tool-result messages in the prompt), the same
//   program in the dying child and in the restarted one. The program here has to answer six agents of the shipped v3 (the int file's support item 1); a minimal scenario is enough: controller -> planner -> one worker with one claim -> one verifier -> synthesis -> `research_close`.
// - `EngineChildScenario` gains the process id and the version; the child registers the shipped v3 (`deepResearchProcessV3`) and the counting source with the scenario's records; its group table is built from the loaded config (as in the int file).
// - Crash points are test-code hooks in engineChildMain.ts (`ENGINE_CRASH_AT=<point>[:n]`, never read under `NODE_ENV=production`), built as a wrapper over `withAttemptGuard` that sees which form's closure write is about to run or has just returned:
//   `research-flow.close.before-write:<agent>` and `research-flow.close.after-write:<agent>` for `<agent>` = `verifier` | `controller`. "Before" is after the model's answer with the form's `finish` is recorded in the session and before the form's guarded write; "after" is right after that write returned.
// - Isolation (project convention, no truncate): a unique `resourceId` and `launchKey` per row; `fileParallelism: false`. Synchronisation only on proven states: the exit code 137 of the dying child, then rows of the test database. No latency assertions; "continues after restart" is the harness timeout of the wait for the end state.
//
// Budget: E2E 1 of the part's 2 (the other is the api switch journey). One journey - the restart of an investigation on v3 at the two closures that write research state - with four rows. Nothing at a lower level can prove it: the death of the process between the
//   recorded turn and the form's write (or right after it) is not reproducible in-process; a held handler is alive and can write later, a dead one cannot. The agent-core matrix kills the process in the generic points of a turn (before the call, after the answer, after
//   a tool, around a child's `propose`); it does not run a form's closure, so a verification revision written outside the run's result record, or an answer written outside the root's, passes every agent-core row.
//
// AC -> proving test: DC-8 (the revision and the run's result are one record, so the retry after a restart executes the recorded `finish` and writes nothing a second time) = V1, V2; DC-2 and KD-3 (the answer is written once with the root's result) = R1, R2; NFR-03 for the forms = V1..R2.

import { describe, it } from 'vitest';

describe('agent-runtime / research-flow - E2E (killed process, real Postgres, scripted model program, shipped v3)', () => {
  // ---------------------------------------------------------------------------------------------------------------
  // E2E-1  Restart at the closure of the two forms that write: a verification and the answer
  // ---------------------------------------------------------------------------------------------------------------
  // User journey: an employee's research is running on agents -> the server is restarted (deploy, crash) at the moment a verification or the final answer is being stored -> the research still ends with ONE verification of each claim and ONE answer, and the conversation gets one answer.
  // Verification: recovery of a form's closure through a really killed process: the new process continues from the database alone and the recorded `finish` is executed once.
  // Covers (original statements):
  // DC-8 (Flow 1, failure handling): "Процесс упал после ответа модели проверяющего -> повтор попытки исполняет `finish` по записанному ответу; ревизия и результат пишутся одной записью, поэтому второй ревизии нет."
  // DC-2 (Flow 2, failure handling): "Процесс упал до записи ответа -> повтор исполняет `finish` заново по записанному ответу хода; ответ и результат пишутся одной записью, поэтому ответ не появляется без результата корня и не пишется дважды."
  // UC-E5: "Given: процесс убит после ответа модели проверяющего до его закрытия; во втором прогоне - после ответа модели корня до записи ответа. When: сервер поднимается. Then: у утверждения одна ревизия проверки; ответ записан один раз, расследование `completed`, в беседе одно сообщение ответа."
  // Use cases: UC-E5. Flow 1 (verifier), Flow 2 (root).
  //
  // Primary failure mode (turns red when): the closure writes the verification revision or the answer in a record separate from the run's result, so a kill between the two leaves a revision without a finished verifier (the retry writes a second revision) or a finished
  //   verifier without a revision (a claim stays unchecked and the root's gate 2 sees an ended call), or an answer without the root's result (the retry writes it again), or the root's result without an answer (an investigation `completed` with nothing to deliver).
  // Behavior: question -> shipped v3 tree under a program model -> the child exits 137 at a named point of a closure -> a new child starts the same investigation (same `launchKey`) -> the tree ends and the investigation closes `completed`
  // @category: e2e
  // @dependency: full-system (runtime, engine, Postgres, built child process, shipped v3)
  // @complexity: high
  //
  // Common Then of every row (read from the rows the two processes left): the investigation is `completed`; each agent task is `succeeded`; the claim has exactly two revisions - the worker's `unverified` and ONE verification revision, written by the verifier run;
  //   the engine run row holds one answer and one message; the root's result is stored once; every recorded model answer in the sessions has exactly one ledger row (the killed turns were recorded, so they are NOT asked again: the number of model calls for the
  //   killed run's recorded turn is one in total across both processes); the sum of per-run spend equals the investigation's charged total; no reserve stays open.
  //
  // Rows (one table; points are test-code hooks):
  //   V1 - verifier, before the closure's write: the child dies after the verifier's `finish` (the assessment) is recorded, before the form's guarded write.
  //        Then: after restart the retry executes the recorded `finish`: ONE verification revision with the status the assessment gives, written together with the run's result; the verifier is `succeeded`; the worker receives claim number, status and group.
  //   V2 - verifier, right after the closure's write: the child dies after the guarded write returned (revision and result stored), before the run is reported ended.
  //        Then: the retry finds the result and writes NO second revision (one verification revision in total); the worker is woken once with the same result.
  //   R1 - root, before the closure's write: the child dies after the controller's `finish(research_close)` is recorded, before the form's guarded write that stores the answer.
  //        Then: after restart the retry runs the gates and the answer gateway again from the recorded `finish` and writes the answer, the message and the root's result as ONE record; one answer; `completed`.
  //   R2 - root, right after the closure's write: the child dies after the answer was stored with the root's result, before the investigation is closed.
  //        Then: the restarted process closes the investigation `completed` from the stored root result; the answer is NOT written a second time (one answer row, one message); the delivery read (`readAnswerMessage`) returns the one message.
  describe('E2E-1', () => {
    it.todo('E2E-1 V1: a process killed after the verifier\'s answer is recorded and before the closure writes leaves one verification revision, written once with the run\'s result');
    it.todo('E2E-1 V2: a process killed right after the verification closure wrote does not write a second revision and wakes the worker once');
    it.todo('E2E-1 R1: a process killed after the root\'s finish is recorded and before the answer is written ends with one answer, written together with the root\'s result');
    it.todo('E2E-1 R2: a process killed right after the answer was written closes the investigation completed from the stored result and does not write the answer again');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Not observable as an assertion (reported to the caller)
// ---------------------------------------------------------------------------------------------------------------
// - UC-E5 says "в беседе одно сообщение ответа". The conversation message is made by the delivery loop of `chat-entry` in `apps/api`, which this engine child does not run. Here the observable part is the engine's side of it (one answer, one stored message, `readAnswerMessage` returns it once);
//   the delivery of that message exactly once after a kill is already proven by `apps/api/test/deep-research-chat-entry.e2e-spec.ts` (E2E-1, `chat-entry.append.after-save`) and is not repeated.
// - The design's UC-E5 names two kills (after the verifier's model answer, after the root's model answer). "Before the closure's write" (V1, R1) is that wording; V2 and R2 are added because the second defect of the primary failure mode - a second write after the retry - is visible only
//   when the kill is placed AFTER the write. If the plan must drop rows, drop V2 and R2 together (they share the "retry writes nothing twice" claim) and keep V1 and R1.
// - "Before the closure's write" is placed after the model's `finish` is recorded; a kill between the model's answer and the record of the turn is agent-core K2 (the turn is asked again). The two are different states and are not merged.
