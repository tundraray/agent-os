// data-model / schema - integration skeleton (in-process agents harness + real Postgres, scripted model)
// Design Doc: docs/features/data-model/design-schema.md, Test Strategy UC-1 (covers DC-1 and DC-2).
// No PRD and no UXRD for this feature (owner's decision): the Design Doc's acceptance criteria are the source.
// Test Type: Integration. Budget of the part: 4 of 3 integration skeletons (packages/db 1, this file 1, apps/api 2), 0 E2E.
// Implementation timing: with step 3 of the Design Doc's build order (conversation columns, start call id).
// First run: the feature's full run, after the last part.
//
// File name and place follow the package convention: `test/*.e2e-spec.ts` with the `.int.` infix, picked up by
// `vitest.config.e2e.ts`; the harness is `test/support/agentsHarness.ts` (as in `agent-platform-agents.int.e2e-spec.ts`).
//
// Already proven elsewhere and NOT repeated here (these suites are adapted by the build, not duplicated):
// - the first message creating one root conversation of the employee, first in the list, and the list's cursor pages without
//   repeats (DC-1, DC-3): INT-1 A and INT-2 A of `apps/api/test/agent-platform-chat.int.e2e-spec.ts` and `apps/api/test/threads.e2e-spec.ts`.
//   The stored root row (its owner, no parent, no starting call) is asserted here, not there.
// - fork point, parent report routing, restart keeping the definition (INT-1 A, C, E of `agent-platform-agents.int.e2e-spec.ts`);
//   only the new `start_call_id` assertion is missing there, which is this file's one case.
// - the foreign-key order of the child insert (task before conversation, parent conversation before child) is exercised by every
//   suite that starts a child; this case reads the stored columns and does not repeat those runs.
//
// Mock boundary: the model is the scripted double of the harness. Repositories, the engine, the step handler and Postgres are real.

import { conversations } from '@agent-os/db';
import {
  createLibraryDouble,
  createScriptedModel,
} from '@agent-os/agents/testing';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  type AgentsHarness,
  createAgentsHarness,
  START_TEST_DEEP_AGENT,
  taskCall,
  testDeepAgent,
  testRecord,
  testSubagent,
  TEST_MODEL_DEFAULT,
  toolCallRowsOf,
  waitForTaskStatus,
} from './support/agentsHarness';
import { newUser, waitFor } from '@agent-os/db/testing';

/** Bound of one in-process test; the rows settle far sooner. */
const TEST_TIMEOUT_MS = 120_000;

/** The columns of a conversation this file asserts. */
interface Link {
  readonly id: string;
  readonly ownerId: string;
  readonly parentId: string | null;
  readonly startCallId: string | null;
}

const LINK_COLUMNS = {
  id: conversations.id,
  ownerId: conversations.ownerId,
  parentId: conversations.parentId,
  startCallId: conversations.startCallId,
};

/** The conversation row of an agent. */
async function linkOf(harness: AgentsHarness, id: string): Promise<Link> {
  const [row] = await harness.db
    .select(LINK_COLUMNS)
    .from(conversations)
    .where(eq(conversations.id, id));
  if (row === undefined) throw new Error(`agent ${id} has no conversation`);
  return row;
}

/** The agent's call of `tool` that started a child, once its result names the child. */
async function startingCallOf(
  harness: AgentsHarness,
  agentId: string,
  tool: string,
): Promise<{ callId: string; childId: string }> {
  const calls = await waitFor(
    () => toolCallRowsOf(harness.db, agentId),
    (rows) => rows.some((row) => row.tool === tool && row.childTaskId !== null),
    `the ${tool} call of agent ${agentId} with its child`,
  );
  const call = calls.find((row) => row.tool === tool);
  if (call?.childTaskId == null)
    throw new Error(`agent ${agentId} started no child with ${tool}`);
  return { callId: call.callId, childId: call.childTaskId };
}

describe('data-model / schema: a child conversation names its parent and the call that started it', () => {
  // AC (DC-2): "Когда агент чата запускает другого агента, беседа ребёнка называет беседу чата родителем и хранит id вызова
  //   инструмента, который её запустил; у беседы без родителя id вызова нет."
  // AC (DC-1, owner half): "...появляется одна беседа с владельцем Аня и без родителя" - the root row asserted in the same case.
  // Behavior: the chat agent's scripted step calls a starting tool -> the engine inserts the child task, then the child
  //   conversation inside the step's transaction -> the stored conversation row has `parent_id` = the chat conversation,
  //   `start_call_id` = the id of that tool call in the chat's history, and the same owner; the chat's own row has neither.
  //   A restarted child gets the call id copied from the conversation it restarts.
  // Catches: one of the starters (`start_agent`, `task`, `start_deep_agent`, restart) writing the child without the call id or with
  //   a wrong one - the link between the parent's history and the child that web and the parent report rely on is lost without
  //   an error - and a foreign key on `parent_id` that the order of inserts in the step's transaction violates (the whole step fails).
  // Verification items (rows of one table-driven case, one scratch harness per row):
  // - start_agent: child row `parent_id` = chat id, `start_call_id` = the call id found in the chat's history, same `owner_id`
  // - task (delegation): same assertions
  // - start_deep_agent: same assertions
  // - restart of a finished child: new row carries the restarted child's `start_call_id`
  // - the chat's own row: `parent_id` null and `start_call_id` null; the owner is a real employee row in `identity_users`
  // @category: core-functionality
  // @dependency: AgentStepHandler, start_agent / task / start_deep_agent / restart, ConversationsRepository, RuntimeTasksRepository, Postgres, ScriptedModel
  // @complexity: medium
  // `start_deep_agent` is stood in for by the harness's `start_test_deep_agent` (no brief card): both start their child through the
  // tool runner's one `startChild`, which binds the call id; the brief itself is not what this case is about.
  it(
    'DC-2 / DC-1: every starter stores the child conversation with its parent and the starting call id, restart copies the call id, and the root row has neither',
    async () => {
      // Given: an employee, a plain agent record and a deep agent with one subagent
      const ownerId = await newUser();
      const library = createLibraryDouble();
      library.add(testRecord('helper'));
      const deepId = library.add(
        testDeepAgent('deep', {
          prompt: 'You give the work to your scout.',
          servers: [],
          model: TEST_MODEL_DEFAULT,
          maxTurns: 10,
          subagents: [testSubagent('scout')],
          finalSubagent: null,
          taskList: false,
          listDelegation: false,
          selfLearning: false,
          scripts: [],
        }),
      );
      const model = createScriptedModel();
      model.script(
        { task: 'Start both' },
        [
          {
            calls: [
              {
                tool: 'start_agent',
                args: {
                  agent: 'helper',
                  description: 'helper',
                  prompt: 'Helper task',
                },
              },
              {
                tool: START_TEST_DEEP_AGENT,
                args: {
                  deepAgent: deepId,
                  prompt: 'Deep task',
                  description: 'deep',
                },
              },
            ],
          },
        ],
        { thereafter: { text: 'noted' } },
      );
      model.script({ task: 'Helper task' }, [], {
        thereafter: { text: 'helper done' },
      });
      model.script({ task: 'Deep task' }, [
        {
          calls: [
            taskCall({ subagentType: 'scout', description: 'Scout task' }),
          ],
        },
        { text: 'deep done' },
      ]);
      model.script({ task: 'Scout task' }, [{ text: 'scout done' }]);
      const harness = await createAgentsHarness({
        model,
        library,
        access: {},
        root: testRecord('root', { tools: ['start_agent'] }),
        deepAgentStarter: true,
      });
      try {
        // When: the root starts a plain agent and a deep agent, and the deep agent gives its scout a task
        const { agentId: rootId } = await harness.sessions.start({
          ownerId,
          prompt: 'Start both',
          description: 'root',
        });
        const helperCall = await startingCallOf(harness, rootId, 'start_agent');
        const deepCall = await startingCallOf(
          harness,
          rootId,
          START_TEST_DEEP_AGENT,
        );
        // A `task` call's result names no child: its one subagent is the deep agent's only child conversation.
        const scoutRows = await waitFor(
          () =>
            harness.db
              .select({ id: conversations.id })
              .from(conversations)
              .where(eq(conversations.parentId, deepCall.childId)),
          (rows) => rows.length === 1,
          `the scout of deep agent ${deepCall.childId}`,
        );
        const scoutId = scoutRows[0].id;
        await waitForTaskStatus(
          harness,
          helperCall.childId,
          ownerId,
          'completed',
        );
        await waitForTaskStatus(
          harness,
          deepCall.childId,
          ownerId,
          'completed',
        );
        const taskCallId = (
          await toolCallRowsOf(harness.db, deepCall.childId)
        ).find((call) => call.tool === 'task')?.callId;

        // Then: the root has the employee as its owner and neither a parent nor a starting call
        expect(await linkOf(harness, rootId)).toEqual({
          id: rootId,
          ownerId,
          parentId: null,
          startCallId: null,
        });
        // And: each child names its parent and the id of the call that started it, under the same owner
        expect([
          await linkOf(harness, helperCall.childId),
          await linkOf(harness, deepCall.childId),
          await linkOf(harness, scoutId),
        ]).toEqual([
          {
            id: helperCall.childId,
            ownerId,
            parentId: rootId,
            startCallId: helperCall.callId,
          },
          {
            id: deepCall.childId,
            ownerId,
            parentId: rootId,
            startCallId: deepCall.callId,
          },
          {
            id: scoutId,
            ownerId,
            parentId: deepCall.childId,
            startCallId: taskCallId,
          },
        ]);

        // When: the finished helper is restarted
        const { agentId: restartedId } = await harness.sessions.restart({
          agentId: helperCall.childId,
          ownerId,
        });

        // Then: the new conversation keeps the parent and the call of the one it replaces
        expect(await linkOf(harness, restartedId)).toEqual({
          id: restartedId,
          ownerId,
          parentId: rootId,
          startCallId: helperCall.callId,
        });
      } finally {
        await harness.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
