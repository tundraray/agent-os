// runtime-fixes / steps - agents-package integration skeletons (in-process `RuntimeModule` + `createAgents` over real Postgres, scripted model)
// Design Doc: docs/features/runtime-fixes/design-steps.md (v1.3), KD-1, KD-2, KD-4, KD-5, Flow 1, Flow 2
// PRD: docs/features/runtime-fixes/prd.md FR-01 (AC-01.1 .. AC-01.7), FR-02 (AC-02.1 .. AC-02.5)
// Generated: 2026-11-28 | Part: steps | Test type: Integration (no E2E file: see "Budget")
// Implementation timing: written alongside the slice each test names, run once at the end of the part (project rule "Tests only at the end"):
//   INT-1 with the partial-answer function in `agents` and the `ModelClient` text holder;
//   INT-2 with the step's debt written before the model call (phase 1a; it is also the "no write" half of KD-1 for phase 1b);
//   INT-3 with the overflow mark: the column, the model step, the compaction step with the preview.
// File name follows the convention of the package: `<feature>-<part>.int.e2e-spec.ts` under packages/agents/test (`vitest.config.e2e.ts`, `pnpm --filter @agent-os/agents test:e2e`,
// DATABASE_URL on a test database only). Every test is `it.todo`: the comments above it are its specification; the implementing task replaces `it.todo` by `it` and fills the body.
//
// Harness: `createAgentsHarness` of support/agentsHarness.ts and the scripted model of `@agent-os/agents/testing`. Support the implementation tasks add (no test of their own):
//   - scripted answer: a hold AFTER the text parts (`latchAfterText`; `latch` is passed before the parts stream), so a step is held with its text already streamed; and a `model_error` answer
//     that carries a provider body (today `modelError(statusCode)` has none), to make the adapter rule see an overflow.
//
// Budget: Integration 3 of 3 here (+1 in packages/runtime, see below), E2E 0 of 1-2.
//   E2E: none. The only journey the employee notices (interrupt, text stays on screen) ends in the web's re-read of the history, whose rule does not change (KD-3); what it reads is
//   the committed record that INT-1 asserts through `agents.history`.
//   The fourth integration test (packages/runtime/test/runtime-fixes-steps.int.e2e-spec.ts) uses the "up to 5" allowance: the interrupt hook registry is new engine code, and no other test
//   catches a throwing hook that blocks an interrupt (the existing end-hook test in data-model-runtime.int.e2e-spec.ts UC-4 covers the end registry only).
//
// Proven elsewhere (the plan reads this to avoid a second test for an AC already proven):
// - unit, packages/agents/src/providers/context-overflow.spec.ts (new): the adapter rule, one recorded body per provider row of the table + one other 400 per kind - AC-02.5, AC-02.4 (rule), KD-4
// - unit, packages/agents/src/model/provider-messages-preview.spec.ts (new): the preview cut of tool results with the mark set - AC-02.2 (rule), KD-5
// - unit, packages/agents/src/model/model-client-partial-text.spec.ts (new): what `ModelClient` holds per task - AC-01.6 (rule), KD-2
// - existing, test/agent-platform-agents.int.e2e-spec.ts INT-2 A: an interrupt closes open calls, writes `interrupted`, calls no model until a message comes - the order "text, then
//   closures, then the event" is the only new thing and is INT-1 row A
// - existing, test/agent-platform-agents.int.e2e-spec.ts INT-1 E: compaction by the threshold (`AGENT_COMPACT_AT_TOKENS`) over the real database; INT-3 here reuses it only as the step
//   that follows an overflow
// - existing, test/agent-harness-core.int.e2e-spec.ts INT-4: empty summary resets `last_input_tokens`, the next step is a model call - INT-3 row B relies on it, not repeated
// - not automated: the error texts `failureReason.context_overflow` (ru, en) in errors.json - a literal; the web rule for the draft (unchanged, KD-3)
//
// acProof:
// - AC-01.1, AC-01.2, AC-01.4, AC-01.5, AC-01.6: INT-1 row A (A1 text, A2 no text, A3 text then a started tool call); AC-01.6 rule: unit
// - AC-01.3: INT-1 row B (stop of a tree)
// - AC-01.7: INT-2
// - AC-02.1, AC-02.2 (wiring; the cut rule is unit): INT-3 row A
// - AC-02.3: INT-3 row B
// - AC-02.4: INT-3 row C (wiring; the recognition rule is unit)
// - AC-02.5: unit

import type { AgentHistoryEntry, AgentTurnMessage } from '@agent-os/agents';
import {
  createLatch,
  createLibraryDouble,
  createScriptedModel,
  inputLines,
  modelError,
  type ScriptedReply,
} from '@agent-os/agents/testing';
import { parseSettingsValue } from '@agent-os/contracts';
import { conversations, settings as settingsTable } from '@agent-os/db';
import { newUser, waitFor } from '@agent-os/db/testing';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  type AgentsHarness,
  closeAll,
  createAgentsHarness,
  historyLines,
  historyOf,
  ledgerRowsOf,
  testRecord,
  toolCallRowsOf,
  waitForTaskStatus,
  ZOMBIE_RUNTIME,
} from './support/agentsHarness';
import { SEARCH_LOGS, WINDOW } from './support/logs-reader';
import { LOGS_SERVER } from './support/mcp-servers';

/** Bound of one in-process test; the rows settle far sooner. */
const TEST_TIMEOUT_MS = 120_000;

/** `AGENT_COMPACT_AT_TOKENS` of INT-3: far above the default usage of a scripted answer. */
const COMPACT_AT_TOKENS = 5_000;

/** A recorded OpenAI overflow body (the harness provider is `openai_compatible`): code `context_length_exceeded`. */
const OVERFLOW_BODY = JSON.stringify({
  error: {
    message:
      "This model's maximum context length is 128000 tokens. However, your messages resulted in 131072 tokens.",
    type: 'invalid_request_error',
    param: 'messages',
    code: 'context_length_exceeded',
  },
});

/** Another 400 of the same provider: not an overflow. */
const OTHER_400_BODY = JSON.stringify({
  error: {
    message: 'Unrecognized request argument supplied: foo',
    type: 'invalid_request_error',
    param: null,
    code: null,
  },
});

/** The text of a data envelope as the model reads it. */
function escaped(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** The outputs of every tool result in a model input, in order. */
function toolOutputs(messages: readonly AgentTurnMessage[]): string[] {
  return messages.flatMap((message) =>
    message.role === 'tool'
      ? message.results.map((result) =>
          typeof result.output === 'string'
            ? result.output
            : JSON.stringify(result.output),
        )
      : [],
  );
}

/** The texts of the tool results of a history, in order. */
function resultTexts(history: readonly AgentHistoryEntry[]): string[] {
  return history.flatMap((entry) =>
    entry.kind === 'tool_result' ? [entry.content.text ?? ''] : [],
  );
}

describe('runtime-fixes / steps - an interrupted answer stays in the history, and an overflowing history is compacted once', () => {
  // INT-1  The transaction that interrupts or stops writes the partial answer, once, before the mark
  // AC-01.1: "Given модель написала половину ответа, when сотрудник жмёт «Прервать», then в ленте стоит этот текст обычным ответом агента, под ним строка «прервано», и после перезагрузки страницы порядок тот же."
  // AC-01.2: "Given ход прерван посреди ответа, when сотрудник пишет следующее сообщение, then модель получает в истории свой частичный ответ, а за ним отметку прерывания."
  // AC-01.3: "Given агент пишет ответ, when остановка заканчивает его работу — «Стоп» на нём или на его предке, сбой родителя или исчерпанный бюджет обучения, — then написанный текст остаётся в истории этого агента перед отметкой остановки."
  // AC-01.4: "Given модель пишет ответ, when сотрудник жмёт «Прервать», then текст на экране не пропадает: он стоит на месте и после прихода отметки прерывания." (the part of it the server owns: the record is already readable when the command answers)
  // AC-01.5: "Given модель не успела написать ни слова, when ход прерван, then в историю пишется только отметка прерывания, как сегодня."
  // AC-01.6: "Given в оборванном ответе модель начала вызов инструмента, но не дописала его, when ход прерван, then этого вызова нет ни в истории, ни в аудите, а текст до него сохранён."
  // Behavior: «Прервать» / «Стоп» while the scripted answer is held after its text parts -> the interrupt or stop transaction fences the task, the hook reads the text from `ModelClient` and writes one
  //   `model_answer` through `History.append` -> after the command answers `agents.history` already holds it, before `interrupted` / the stop mark; the model's next input has it in that order.
  // Rows (table, one scripted run each; design v1.3: every row cuts off the answer to the employee's SECOND message, after the agent answered its task):
  //   A1 "interrupt, text": the answer streams 'Начало ответа' in two parts and is held; `agents.interrupt`; at once after it history holds the question, then `model_answer: Начало ответа []`,
  //      and at most the `event: interrupted` the next step writes after it; that step calls no model until a message comes; the employee then sends a message -> the model double's next input
  //      lists the question, the partial answer, the interrupted mark, then the message (AC-01.2). Exactly one `model_answer` for that call; one ledger row for the aborted call by its estimate (unchanged).
  //   A2 "interrupt, no text": the answer is held before any part; the interrupt writes no `model_answer` at all (history is the question, then the event) - AC-01.5
  //   A3 "interrupt, text then a started tool call": the answer streams text, then a tool call that is never finished, then is held; after the interrupt the history holds the text only: no
  //      tool call in the answer, no `tool_result` line, no row in the tool-call audit - AC-01.6
  //   B  "stop of a tree": root R with a child C, each held mid-answer with text (R on the employee's question, C on its task); `agents.stop` on R: the history of R and of C each ends
  //      `model_answer: <its text>` followed by the stop mark (`stopped` for R, `stopped_with_parent` for C); the order holds after a reload of the history - AC-01.3
  // Catches: (1) the text written AFTER the mark or by the next step, so a re-read right after the command misses it and the screen loses the draft (the original defect); (2) the text lost
  //   because the hook is not called for one of the two paths (interrupt vs end `stopped`) or not for a descendant of a stopped tree; (3) an empty `model_answer` written for an empty text;
  //   (4) a half-written tool call that leaks into the history or the audit; (5) the question standing after the partial answer, or answered again after the interrupt. No unit test sees the
  //   transaction order or the descendant walk.
  // @category: core-functionality
  // @dependency: RuntimeModule (TaskControl, interrupt hook, TaskEndHooks), createAgents (interrupt, stop, history, send), ModelClient text holder, History.append, ScriptedModel (hold after parts), Postgres
  // @complexity: high
  it(
    'INT-1: interrupt and stop write the text the model had already written as one model_answer before the interrupted or stop mark; no text writes nothing; a half-written tool call is not kept',
    async () => {
      const ownerId = await newUser();
      const question = 'INT-1: second question';
      const questionLine = `user_message: ${question}`;

      // Rows A - Given: three agents, each answered its task and waits; the answer to the question is held
      // after its text (A1), before any part (A2), after its text with a tool call never finished (A3)
      const interruptModel = createScriptedModel();
      const textHeld = createLatch();
      const silentHeld = createLatch();
      const callHeld = createLatch();
      const rows = [
        {
          task: 'INT-1 A1: interrupted with text',
          held: textHeld,
          cut: { text: ['Начало ', 'ответа'], latchAfterText: textHeld },
          partial: ['model_answer: Начало ответа []'],
        },
        {
          task: 'INT-1 A2: interrupted before any text',
          held: silentHeld,
          cut: { text: 'never streamed', latch: silentHeld },
          partial: [],
        },
        {
          task: 'INT-1 A3: interrupted with a started tool call',
          held: callHeld,
          cut: {
            text: ['Looking ', 'it up'],
            calls: [{ tool: 'list_agents', args: {} }],
            latchAfterText: callHeld,
          },
          partial: ['model_answer: Looking it up []'],
        },
      ];
      const scripts = rows.map((row) =>
        interruptModel.script({ task: row.task }, [
          { text: 'First answer.' },
          row.cut,
          { text: 'Answer after the interrupt.' },
        ]),
      );
      const interrupting = await createAgentsHarness({
        model: interruptModel,
        library: createLibraryDouble(),
        access: {},
        root: testRecord('int-1 interrupt'),
      });
      try {
        for (const [index, row] of rows.entries()) {
          const script = scripts[index];
          const { agentId } = await interrupting.sessions.start({
            ownerId,
            prompt: row.task,
            description: `interrupted agent ${index + 1}`,
          });
          await waitForTaskStatus(interrupting, agentId, ownerId, 'waiting');
          await interrupting.sessions.send({
            agentId,
            ownerId,
            text: question,
          });
          await row.held.reached();

          // When: the employee interrupts the held answer
          expect(
            await interrupting.sessions.interrupt({ agentId, ownerId }),
          ).toBe('interrupted');

          // Then: at once after the command the question and the partial answer are in the history, before the mark
          const before = [
            `task: ${row.task}`,
            'model_answer: First answer. []',
            questionLine,
            ...row.partial,
          ];
          const atOnce = historyLines(
            await historyOf(interrupting, agentId, ownerId),
          );
          expect(atOnce.slice(0, before.length)).toEqual(before);
          expect(atOnce.slice(before.length)).toEqual(
            atOnce.length > before.length ? ['event: interrupted'] : [],
          );

          // Then: the step that took the interrupt writes the mark after it and calls no model
          await waitFor(
            () => historyOf(interrupting, agentId, ownerId),
            (entries) => historyLines(entries).at(-1) === 'event: interrupted',
            `the interrupted event of row ${index + 1}`,
          );
          await waitForTaskStatus(interrupting, agentId, ownerId, 'waiting');
          expect(
            historyLines(await historyOf(interrupting, agentId, ownerId)),
          ).toEqual([...before, 'event: interrupted']);
          expect(script.calls).toHaveLength(2);
          // Then: the tool call the model never finished is neither in the history nor in the audit
          expect(await toolCallRowsOf(interrupting.db, agentId)).toEqual([]);

          // When: the employee writes again
          row.held.open();
          await interrupting.sessions.send({ agentId, ownerId, text: 'go on' });
          await script.called(3);
          await waitForTaskStatus(interrupting, agentId, ownerId, 'waiting');

          // Then: the model reads the question, its partial answer, the mark and the message, in that order
          const partialInput = row.partial.map((line) =>
            line.replace('model_answer: ', 'assistant: '),
          );
          expect(
            inputLines(script.calls[2]?.messages ?? []).slice(
              -(3 + partialInput.length),
            ),
          ).toEqual([
            `user: ${question}`,
            ...partialInput,
            'user: [event] interrupted',
            'user: go on',
          ]);
          expect(
            historyLines(await historyOf(interrupting, agentId, ownerId)),
          ).toEqual([
            ...before,
            'event: interrupted',
            'user_message: go on',
            'model_answer: Answer after the interrupt. []',
          ]);
          // Then: the aborted call is one ledger row, as before: three calls, three rows
          expect(
            await ledgerRowsOf(interrupting.db, ownerId, agentId),
          ).toHaveLength(3);
        }
      } finally {
        for (const row of rows) row.held.open();
        await interrupting.close();
      }

      // Row B - Given: root R started child C, answered and waits; C is held mid-answer on its task, and R mid-answer
      // on the employee's question
      const library = createLibraryDouble();
      const childRecord = library.add(testRecord('int1-child'));
      const rootHeld = createLatch();
      const childHeld = createLatch();
      const stopModel = createScriptedModel();
      const rootTask = 'INT-1 B: root of the stopped tree';
      const childTask = 'INT-1 B: child of the stopped tree';
      const rootScript = stopModel.script({ task: rootTask }, [
        {
          calls: [
            {
              tool: 'start_agent',
              args: {
                agent: 'int1-child',
                description: 'stopped child',
                prompt: childTask,
              },
            },
          ],
        },
        { text: 'Child started.' },
        { text: ['Root ', 'partial'], latchAfterText: rootHeld },
      ]);
      stopModel.script({ task: childTask }, [
        { text: ['Child ', 'partial'], latchAfterText: childHeld },
      ]);
      const stopping = await createAgentsHarness({
        model: stopModel,
        library,
        access: {},
        root: testRecord('int-1 root', {
          tools: ['start_agent'],
          agents: [childRecord],
        }),
      });
      try {
        const { agentId: rootId } = await stopping.sessions.start({
          ownerId,
          prompt: rootTask,
          description: 'stopped root',
        });
        await rootScript.called(2);
        await waitForTaskStatus(stopping, rootId, ownerId, 'waiting');
        await childHeld.reached();
        const [childId] = (await toolCallRowsOf(stopping.db, rootId)).flatMap(
          (call) => (call.childTaskId === null ? [] : [call.childTaskId]),
        );
        if (childId === undefined) throw new Error('the root started no child');
        await stopping.sessions.send({
          agentId: rootId,
          ownerId,
          text: question,
        });
        await rootHeld.reached();

        // When: the employee stops R
        const stoppedIds = await stopping.sessions.stop({
          agentId: rootId,
          ownerId,
        });

        // Then: R and C are stopped, and each history holds its text before its stop mark
        expect(stoppedIds.slice(0, 2)).toEqual([rootId, childId]);
        const expectedRoot = [
          `task: ${rootTask}`,
          'model_answer:  [start_agent]',
          'tool_result: start_agent success',
          'model_answer: Child started. []',
          questionLine,
          'model_answer: Root partial []',
          'event: stopped',
        ];
        const expectedChild = [
          `task: ${childTask}`,
          'model_answer: Child partial []',
          'event: stopped_with_parent',
        ];
        expect(
          historyLines(await historyOf(stopping, rootId, ownerId)),
        ).toEqual(expectedRoot);
        expect(
          historyLines(await historyOf(stopping, childId, ownerId)),
        ).toEqual(expectedChild);

        // Then: after the cut-off calls end, a reload of the history shows the same order
        rootHeld.open();
        childHeld.open();
        expect(rootScript.calls).toHaveLength(3);
        expect(
          historyLines(await historyOf(stopping, rootId, ownerId)),
        ).toEqual(expectedRoot);
        expect(
          historyLines(await historyOf(stopping, childId, ownerId)),
        ).toEqual(expectedChild);
      } finally {
        rootHeld.open();
        childHeld.open();
        await stopping.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  // INT-2  A restart repeats the step and a step time limit fails it; the employee's question is in the history once, with no copy of the cut text
  // AC-01.7: "Given модель пишет ответ, when сервер перезапускается или шаг превышает лимит времени, then шаг повторяется, и в истории один ответ без копии оборванного текста."
  // KD-1 (design v1.3): the model step writes its debt (prelude, delivered messages, their session fields) by the guarded write with delivery before the call, so a step repeated after a
  //   restart gets no delivered message and writes no second copy of the question.
  // Behavior: the agent answered its task and waits; the employee's second message starts a model step held after its text parts.
  // Rows:
  //   A "restart": the step is held on a zombie instance ("the server died"); a second harness over the same database starts, requeues the lost step and repeats it (as INT-3 row E of
  //     agent-platform-agents) -> the repeated step answers the script's third answer; then the zombie's held call answers and its late result is rejected.
  //   B "step time limit": the runtime's step limit is the lowest (1 s); the held step is cut off by it, and the runtime fails the task with `step_timeout` (the limit fails, it does not repeat).
  // Verification: in both rows the question stands in the history exactly once, the cut answer's streamed text nowhere, no `interrupted` event (the step was not interrupted). Row A: the
  //   history is task, first answer, question, the repeated step's answer; the repeated call's input holds the question once, after the first answer; the zombie's late result changes
  //   nothing. Row B: the task is `failed` with `step_timeout`, and the history holds the question (before KD-1 the failed step's message was marked delivered and lost).
  // Catches: (1) the repeated step getting the delivered messages again and writing the question a second time (the guarded write without delivery that KD-1 rejects); (2) the partial-answer
  //   function wired to the restart / limit abort too, so the repeated step writes its answer next to a copy of the cut one (phase 1b: the guard for the hook).
  // @category: edge-case
  // @dependency: RuntimeModule (recovery sweeper, step time limit), createAgents x2 (second instance), StepContext.guardWithDelivery, ScriptedModel (hold after parts), Postgres
  // @complexity: high
  it(
    'INT-2: a step cut off by a restart or by the step time limit is repeated and the history keeps one answer, with no copy of the cut text',
    async () => {
      const ownerId = await newUser();
      const question = 'INT-2: second question';
      const questionLine = `user_message: ${question}`;

      // Row A - Given: on the zombie the agent answered its task and waits; the question's model step is held
      // after its text parts
      const restartTask = 'INT-2 A: answer, then lose the step';
      const restartHeld = createLatch();
      const restartModel = createScriptedModel();
      const restartScript = restartModel.script({ task: restartTask }, [
        { text: 'First answer.' },
        { text: ['Cut ', 'by the restart'], latchAfterText: restartHeld },
        { text: 'Answer after the restart.' },
      ]);
      const restartOptions = {
        model: restartModel,
        library: createLibraryDouble(),
        access: {},
        root: testRecord('int-2 restart'),
      };
      const harnesses: AgentsHarness[] = [];
      try {
        const zombie = await createAgentsHarness({
          ...restartOptions,
          runtimeConfig: ZOMBIE_RUNTIME,
        });
        harnesses.push(zombie);
        const { agentId } = await zombie.sessions.start({
          ownerId,
          prompt: restartTask,
          description: 'restarted agent',
        });
        await waitForTaskStatus(zombie, agentId, ownerId, 'waiting');
        await zombie.sessions.send({ agentId, ownerId, text: question });
        await restartHeld.reached();

        // When: the second instance starts, requeues the lost step and repeats it
        const restarted = await createAgentsHarness(restartOptions);
        harnesses.push(restarted);
        await restartScript.called(3);
        await waitForTaskStatus(restarted, agentId, ownerId, 'waiting');

        // Then: the question once, before the repeated step's answer; no copy of the cut text, no interrupt
        const expectedHistory = [
          `task: ${restartTask}`,
          'model_answer: First answer. []',
          questionLine,
          'model_answer: Answer after the restart. []',
        ];
        expect(
          historyLines(await historyOf(restarted, agentId, ownerId)),
        ).toEqual(expectedHistory);
        const repeatedInput = inputLines(
          restartScript.calls[2]?.messages ?? [],
        );
        expect(repeatedInput.slice(-2)).toEqual([
          'assistant: First answer. []',
          `user: ${question}`,
        ]);
        expect(
          repeatedInput.filter((line) => line === `user: ${question}`),
        ).toHaveLength(1);

        // When: the zombie's held call answers; Then: its result is rejected and the history is the same
        restartHeld.open();
        await waitFor(
          async () =>
            zombie.logs.filter(
              (record) =>
                record.message ===
                  'step result rejected: the attempt is no longer current' &&
                record.fields.taskId === agentId,
            ),
          (records) => records.length === 1,
          'the zombie step result to be rejected',
        );
        expect(
          historyLines(await historyOf(restarted, agentId, ownerId)),
        ).toEqual(expectedHistory);
      } finally {
        restartHeld.open();
        await closeAll(harnesses);
      }

      // Row B - Given: a step limit of 1 s; the agent answered its task and waits; the question's model step is
      // held after its text parts past the limit
      const limitTask = 'INT-2 B: answer, then run past the step limit';
      const limitHeld = createLatch();
      const limitModel = createScriptedModel();
      limitModel.script({ task: limitTask }, [
        { text: 'First answer.' },
        { text: ['Cut ', 'by the limit'], latchAfterText: limitHeld },
      ]);
      const limited = await createAgentsHarness({
        model: limitModel,
        library: createLibraryDouble(),
        access: {},
        root: testRecord('int-2 limit'),
        runtimeConfig: { stepMs: 1_000 },
      });
      try {
        const { agentId } = await limited.sessions.start({
          ownerId,
          prompt: limitTask,
          description: 'limited agent',
        });
        await waitForTaskStatus(limited, agentId, ownerId, 'waiting');

        // When: the question's step runs past the limit
        await limited.sessions.send({ agentId, ownerId, text: question });
        const failed = await waitForTaskStatus(
          limited,
          agentId,
          ownerId,
          'failed',
        );

        // Then: the task failed by the limit; the question is in the history once, the cut text nowhere
        expect(failed.failure?.reason).toBe('step_timeout');
        const lines = historyLines(await historyOf(limited, agentId, ownerId));
        expect(lines.slice(0, 3)).toEqual([
          `task: ${limitTask}`,
          'model_answer: First answer. []',
          questionLine,
        ]);
        expect(lines.filter((line) => line === questionLine)).toHaveLength(1);
        expect(lines.filter((line) => line.includes('by the limit'))).toEqual(
          [],
        );
        expect(lines).not.toContain('event: interrupted');
      } finally {
        limitHeld.open();
        await limited.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  // INT-3  Overflow: the step commits with the mark, the next step compacts with previews and calls the model once more; the second overflow fails the agent
  // AC-02.1: "Given провайдер ответил на вызов модели переполнением, when ход обрабатывает ответ, then история сжата, в ленте видна отметка сжатия, следующий вызов модели идёт со сжатой историей, и ход продолжается."
  // AC-02.2: "Given переполнение вызвали результаты инструментов меньше порога превью, сложенные вместе, ..., when идёт принудительное сжатие, then сжатие не переполняется, потому что модель видит большие из этих результатов превью, а сотрудник в ленте видит их целиком."
  // AC-02.3: "Given принудительное сжатие прошло, when новый вызов модели снова получает переполнение, then ход заканчивается статусом «сбой» с причиной о том, что история не помещается в окно модели даже после сжатия"
  // AC-02.4: "Given провайдер ответил ошибкой, которая не говорит о переполнении, when ход её обрабатывает, then сжатия нет, и ход заканчивается так же, как сегодня"
  // Behavior: the scripted provider answers 400 with a recorded overflow body -> adapter rule -> `model_error context_overflow` -> the model step commits what it owed, sets the session mark and
  //   raises `last_input_tokens` to the threshold -> the next step is the compaction call, whose input shows every tool result longer than `previewChars` as its start with the cut count ->
  //   `compacted` event, `last_input_tokens` reset -> the next step calls the model with the summary.
  // Rows (table, one scripted run each):
  //   A "recovers": history of several tool results each above `previewChars` and below `storeFromChars` -> overflow -> compaction input holds the preview of each (length `previewChars` + the
  //      cut note) while `agents.history` still shows the results whole; the history has a `compaction` entry and `event: compacted`; the new model call input is the summary; the agent
  //      answers and the mark is clear afterwards (a later overflow is again a first one, not a failure)
  //   B "second overflow": same start, the call after the compaction also overflows -> the agent is `failed` with `failureReason` `context_overflow`, event `failed`, exactly two compaction-
  //      or-model calls after the first overflow, no third compaction; and a variant where the compaction call itself overflows with the mark set -> the same failure
  //   C "another 400": the provider answers 400 with a body that is not an overflow (the `otherBody` of the kind) -> `model_error` as today: no compaction call, no mark, the agent ends as before
  // Catches: (1) the overflow failing the conversation (the original defect); (2) the compaction call overflowing because it carries the same long results (the second trap in the PRD);
  //   (3) a mark that is never cleared, so a later healthy overflow fails at once; or never set, so the agent loops on compaction; (4) preview cutting the stored history instead of the
  //   model's view; (5) any 400 starting a compaction. The mark, the threshold raise and the preview are only visible across the model step, the compaction step and the real column.
  // @category: core-functionality
  // @dependency: ProviderAdapter overflow rule, ModelClient, model step, compaction step, BaseAgent.step (compactionDue), conversations repository (overflow mark, last_input_tokens), ScriptedModel (model_error with body), Postgres
  // @complexity: high
  it(
    'INT-3: a provider overflow compacts the history once with previews of long tool results and the agent goes on; a second overflow fails it with context_overflow; another 400 does not compact',
    async () => {
      const ownerId = await newUser();
      const overflow = () => modelError(400, undefined, OVERFLOW_BODY);
      // Three direct reads, each above `previewChars` and below `storeFromChars` (checked below): they come whole.
      const reads = {
        calls: [20, 25, 30].map((pageSize) => ({
          tool: SEARCH_LOGS,
          args: { ...WINDOW, pageSize },
        })),
      };
      const compactionHeld = createLatch();
      const model = createScriptedModel();
      const recoverTask = 'INT-3 A: overflow, then recover';
      const recovering = model.script({ task: recoverTask }, [
        reads,
        overflow(),
        { text: 'summary A', latch: compactionHeld },
        { text: 'answer after the overflow' },
        overflow(),
        { text: 'summary A2' },
        { text: 'answer after the second overflow' },
      ]);
      const rowB: readonly {
        readonly task: string;
        readonly replies: readonly ScriptedReply[];
        readonly calls: number;
        readonly compactions: number;
      }[] = [
        {
          task: 'INT-3 B1: the call after the compaction overflows',
          replies: [reads, overflow(), { text: 'summary B1' }, overflow()],
          calls: 4,
          compactions: 1,
        },
        {
          task: 'INT-3 B2: the compaction with the mark overflows',
          replies: [reads, overflow(), overflow()],
          calls: 3,
          compactions: 0,
        },
      ];
      const failingScripts = rowB.map((row) =>
        model.script({ task: row.task }, row.replies),
      );
      const otherTask = 'INT-3 C: another 400';
      const other = model.script({ task: otherTask }, [
        reads,
        modelError(400, undefined, OTHER_400_BODY),
      ]);
      const harness = await createAgentsHarness({
        model,
        access: { [ownerId]: [LOGS_SERVER] },
        variables: { AGENT_COMPACT_AT_TOKENS: String(COMPACT_AT_TOKENS) },
        root: testRecord('int-3 overflow', { servers: [LOGS_SERVER] }),
      });
      const markOf = async (agentId: string) => {
        const [row] = await harness.db
          .select({
            overflowed: conversations.overflowed,
            lastInputTokens: conversations.lastInputTokens,
          })
          .from(conversations)
          .where(eq(conversations.id, agentId));
        return row;
      };
      const start = async (task: string) =>
        (
          await harness.sessions.start({
            ownerId,
            prompt: task,
            description: 'overflowing agent',
          })
        ).agentId;
      try {
        const [settingsRow] = await harness.db
          .select({ value: settingsTable.value })
          .from(settingsTable)
          .where(eq(settingsTable.key, 'tool_result_settings'));
        const { previewChars, storeFromChars } = parseSettingsValue(
          'tool_result_settings',
          settingsRow?.value,
        );

        // Row A - When: the call after three long direct results overflows
        const recoverId = await start(recoverTask);
        await compactionHeld.reached();

        // Then: the step committed with the mark and the threshold; the conversation goes on
        expect(await markOf(recoverId)).toEqual({
          overflowed: true,
          lastInputTokens: COMPACT_AT_TOKENS,
        });
        const texts = resultTexts(await historyOf(harness, recoverId, ownerId));
        expect(texts).toHaveLength(3);
        for (const text of texts) {
          expect(text.length).toBeGreaterThan(previewChars);
          expect(text.length).toBeLessThanOrEqual(storeFromChars);
        }
        compactionHeld.open();
        await recovering.called(4);
        await waitForTaskStatus(harness, recoverId, ownerId, 'waiting');

        // Then: the overflowing call carried the results whole, the compaction call their starts with the cut
        // count, and the history keeps them whole for the employee
        const [, overflowed, compacting, afterCompaction] = recovering.calls;
        expect(toolOutputs(overflowed?.messages ?? [])).toEqual(
          texts.map((text) => expect.stringContaining(escaped(text))),
        );
        const previews = toolOutputs(compacting?.messages ?? []);
        expect(previews).toEqual(
          texts.map((text) =>
            expect.stringContaining(
              escaped(
                `${text.slice(0, previewChars)}\nresult cut by ${text.length - previewChars} characters`,
              ),
            ),
          ),
        );
        previews.forEach((preview, index) =>
          expect(preview).not.toContain(escaped(texts[index] ?? '')),
        );
        expect(
          resultTexts(await historyOf(harness, recoverId, ownerId)),
        ).toEqual(texts);
        // Then: the next model call reads the summary, and the answer clears the mark
        expect(inputLines(afterCompaction?.messages ?? []).slice(0, 2)).toEqual(
          [
            'user: <data source="summary of the earlier history" author="agents">\nsummary A\n</data>',
            'user: [event] compacted',
          ],
        );
        expect(
          historyLines(await historyOf(harness, recoverId, ownerId)).slice(-3),
        ).toEqual([
          'compaction: summary A',
          'event: compacted',
          'model_answer: answer after the overflow []',
        ]);
        expect((await markOf(recoverId))?.overflowed).toBe(false);

        // When: a later call overflows again; Then: it is a first overflow again, compacted, not a failure
        await harness.sessions.send({
          agentId: recoverId,
          ownerId,
          text: 'one more question',
        });
        await recovering.called(7);
        await waitForTaskStatus(harness, recoverId, ownerId, 'waiting');
        expect(
          historyLines(await historyOf(harness, recoverId, ownerId)).slice(-4),
        ).toEqual([
          'user_message: one more question',
          'compaction: summary A2',
          'event: compacted',
          'model_answer: answer after the second overflow []',
        ]);
        expect((await markOf(recoverId))?.overflowed).toBe(false);

        // Row B - When: the overflow comes back after the compaction, or the compaction itself overflows
        for (const [index, row] of rowB.entries()) {
          const agentId = await start(row.task);
          const failed = await waitForTaskStatus(
            harness,
            agentId,
            ownerId,
            'failed',
          );

          // Then: the agent fails with context_overflow after at most one compaction
          expect(failed.failure?.reason).toBe('context_overflow');
          expect(failingScripts[index]?.calls).toHaveLength(row.calls);
          const lines = historyLines(
            await historyOf(harness, agentId, ownerId),
          );
          expect(
            lines.filter((line) => line.startsWith('compaction: ')),
          ).toHaveLength(row.compactions);
          expect(lines.at(-1)).toBe('event: failed context_overflow');
        }

        // Row C - When: another 400 answers the call after the reads
        const otherId = await start(otherTask);
        const ended = await waitForTaskStatus(
          harness,
          otherId,
          ownerId,
          'failed',
        );

        // Then: the agent fails as today: no compaction call, no mark
        expect(ended.failure?.reason).toBe('model_error');
        expect(other.calls).toHaveLength(2);
        const otherLines = historyLines(
          await historyOf(harness, otherId, ownerId),
        );
        expect(
          otherLines.filter((line) => line.startsWith('compaction: ')),
        ).toEqual([]);
        expect(otherLines.at(-1)).toBe('event: failed model_error');
        expect((await markOf(otherId))?.overflowed).toBe(false);
      } finally {
        compactionHeld.open();
        await harness.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
