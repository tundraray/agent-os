// data-model / runtime - agents-package integration test (in-process `RuntimeModule` + `createAgents` over real Postgres, scripted model)
// Design Doc: docs/features/data-model/design-runtime.md, Test Strategy UC-6; KD-6; DC-44
// Test type: Integration, run with `pnpm --filter @agent-os/agents test:e2e`.
//
// Harness: `createAgentsHarness` of support/agentsHarness.ts. The `run_code` row substitutes the `CodeRunner` with a double that throws,
// so the tool's own code throws an unexpected exception. A unique owner `newUser()` per run; no sleeps, the waits order the steps.
//
// Proven elsewhere (not restated here):
// - integration, deep-agents-task.int.e2e-spec.ts, and unit, packages/agents/src/deep/delegation-rules.spec.ts, agent/deliver.spec.ts,
//   model/provider-messages.spec.ts - the text of a failed subagent in the `task` result, in `child_report` and in the model's input, cut
//   to 1 000 characters.
// - unit, packages/runtime/src/tasks/transaction-retry.spec.ts - a savepoint never swallows an error after which the transaction cannot go on.

import type { CodeRunner } from '@agent-os/code-runner';
import { createScriptedModel } from '@agent-os/agents/testing';
import { newUser } from '@agent-os/db/testing';
import { describe, expect, it } from 'vitest';
import {
  createAgentsHarness,
  historyOf,
  testRecord,
  toolOutputOf,
  waitForTaskStatus,
} from './support/agentsHarness';
import { runCode, toolCallIdOf } from './support/logs-reader';
import { LOGS_SERVER } from './support/mcp-servers';

/** Bound of one in-process test; the rows settle far sooner. */
const TEST_TIMEOUT_MS = 120_000;

/** What the substituted executor throws: an exception the tool does not expect. */
const THROWN = 'executor exploded: socket closed';

describe('data-model / runtime - a failure reaches the model as text, and a throwing tool is a call error', () => {
  // ---------------------------------------------------------------------------------------------------------------
  // UC-6: the exception of a tool
  // ---------------------------------------------------------------------------------------------------------------
  // DC-44: "`child_report` упавшего ребёнка и текст ошибки инструмента `task` содержат текст сбоя ...; инструмент, который бросил
  //   исключение, закрывает вызов исходом `tool_error` с текстом ошибки, и агент делает следующий шаг."
  // Catches: (1) a tool's exception fails the agent instead of closing its call; (2) the call error lacks the exception's text, or the
  //   exception is not logged with the call's id.
  it(
    'UC-6 (tool exception): a run_code whose executor throws is closed tool_error with the text, logged with the call id, and the model is called next',
    async () => {
      // Given: an agent that may read `logs` and runs code on an executor that throws
      const ownerId = await newUser();
      const model = createScriptedModel();
      const throwing: CodeRunner = {
        run: () => Promise.reject(new Error(THROWN)),
      };
      const harness = await createAgentsHarness({
        model,
        access: { [ownerId]: [LOGS_SERVER] },
        root: testRecord('reader', { servers: [LOGS_SERVER] }),
        codeRunner: throwing,
      });
      const prompt = 'Count the errors in the logs';
      const script = model.script({ task: prompt }, [
        { calls: [runCode('Подсчёт ошибок', 'return 1;')] },
        { text: 'The executor failed; I will try another way.' },
      ]);
      try {
        // When: the agent runs the code
        const { agentId } = await harness.sessions.start({
          ownerId,
          prompt,
          description: 'reader',
        });
        await script.called(2);
        await waitForTaskStatus(harness, agentId, ownerId, 'waiting');

        // Then: the call is closed tool_error with the exception's text, and the next step was the model's, which saw it
        const results = (await historyOf(harness, agentId, ownerId)).flatMap(
          (entry) =>
            entry.kind === 'tool_result' && entry.content.tool === 'run_code'
              ? [{ outcome: entry.content.outcome, text: entry.content.text }]
              : [],
        );
        expect(results).toEqual([
          { outcome: 'tool_error', text: expect.stringContaining(THROWN) },
        ]);
        const callId = toolCallIdOf(script, 0);
        expect(toolOutputOf(script.calls[1]?.messages ?? [], callId)).toContain(
          THROWN,
        );

        // Then: the exception is logged as an error with the call's id
        expect(
          harness.logs.filter(
            (record) =>
              record.level === 'error' &&
              record.message === 'tool threw; the call ends as a tool error' &&
              record.fields.callId === callId,
          ),
        ).toHaveLength(1);
      } finally {
        await harness.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
