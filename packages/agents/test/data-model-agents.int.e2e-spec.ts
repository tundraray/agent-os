// data-model / agents - integration test (in-process agents harness + real Postgres, scripted model)
// Design Doc: docs/features/data-model/design-agents.md, Test Strategy UC-5 (the model chain) and the second half of UC-3 (`task` with a name outside the team).
// No PRD and no UXRD for this feature (owner's decision): the Design Doc's acceptance criteria are the source.
// Test Type: Integration. Budget of the part: 4 of 3 integration skeletons (this file 1, apps/api 2, packages/db 1), 0 E2E.
// First run: the feature's full run, after the last part.
//
// File name and place follow the package convention: `test/*.e2e-spec.ts` with the `.int.` infix, picked up by `vitest.config.e2e.ts`; the harness
// is `test/support/agentsHarness.ts`, as in `agent-platform-agents.int.e2e-spec.ts` (its library double writes real `agents` and
// `agent_versions` rows: a conversation holds a foreign key to a version). Do NOT run it against the development database.
//
// Already proven elsewhere and NOT repeated here:
// - The chain itself and every start path of the table "Старт: версия, имя и модель беседы" (model of the version, then the parent, then the system model,
//   `model_not_configured`; an inherited model the owner may not use is `model_not_allowed`): one table-driven unit test, the rows of
//   `src/start/resolve-start.spec.ts` (DC-19, DC-20 rule). This file proves only that the resolved values reach the stored conversation and the model call.
// - The refusal wiring with exactly one `access_denied` and no child task: INT-2 / INT-3 of `apps/api/test/enterprise-access-access.int.e2e-spec.ts` and
//   INT-1 C of `custom-agents-runtime.int.e2e-spec.ts` (this directory).
// - The root without a system model answers `model_not_configured`: INT-6 and INT-7 of `apps/api/test/model-providers-core.int.e2e-spec.ts`.
// - The parent link and `start_call_id` of a child: `data-model-schema.int.e2e-spec.ts` of this directory.
// - Pinning of a running conversation to its version: INT-1 A of `custom-agents-runtime.int.e2e-spec.ts` (this directory).
// - The rule of `task` (a name outside the team is a temporary subagent, counted in `run_limit`): the rows of `deep/delegation-rules.spec.ts`;
//   the wiring row below shows it in the stored conversation. A `task` call past the limit refused with `run_limit` and starting
//   nothing: INT-2 A of `deep-agents-run.int.e2e-spec.ts` (this directory).
//
// Mock boundary: the model is the scripted double of the harness and records the model id of every call. Repositories, the engine, the step handler,
//   resolveStart and Postgres are real; the library is the harness's double over real catalogue rows.

import {
  createLibraryDouble,
  createScriptedModel,
  type LibraryDouble,
} from '@agent-os/agents/testing';
import { conversations, type Database } from '@agent-os/db';
import { newUser, waitFor } from '@agent-os/db/testing';
import { asc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  type AgentsHarness,
  createAgentsHarness,
  START_TEST_DEEP_AGENT,
  taskCall,
  TEST_MODEL_CHOSEN,
  TEST_MODEL_DEFAULT,
  testDeepAgent,
  testRecord,
  testSubagent,
  toolCallRowsOf,
  waitForTaskStatus,
} from './support/agentsHarness';

/** Bound of one in-process test; the rows settle far sooner. */
const TEST_TIMEOUT_MS = 180_000;

/** The model of a version, when it has one (the harness's system model is {@link TEST_MODEL_DEFAULT}). */
const MODEL_A = TEST_MODEL_CHOSEN;
const MODEL_B = TEST_MODEL_CHOSEN;
const MODEL_C = TEST_MODEL_DEFAULT;

/** A conversation as this file reads it: the start's stored values. */
interface Stored {
  readonly name: string;
  readonly subagent: string | null;
  readonly model: string;
  readonly agentVersionId: string;
}

/** The stored values of the conversations under `parentId`, by name. */
function childrenOf(db: Database, parentId: string): Promise<Stored[]> {
  return db
    .select({
      name: conversations.name,
      subagent: conversations.subagent,
      model: conversations.model,
      agentVersionId: conversations.agentVersionId,
    })
    .from(conversations)
    .where(eq(conversations.parentId, parentId))
    .orderBy(asc(conversations.name));
}

async function storedOf(db: Database, id: string): Promise<Stored> {
  const [row] = await db
    .select({
      name: conversations.name,
      subagent: conversations.subagent,
      model: conversations.model,
      agentVersionId: conversations.agentVersionId,
    })
    .from(conversations)
    .where(eq(conversations.id, id));
  if (row === undefined) throw new Error(`No conversation ${id}`);
  return row;
}

/** The active version of the double's record `recordId` as `viewerId` resolves it. */
async function activeVersionOf(
  library: LibraryDouble,
  viewerId: string,
  recordId: string,
): Promise<string> {
  const record = await library.resolve(viewerId, recordId);
  if (record === null) throw new Error(`Record ${recordId} is not visible`);
  return record.versionId;
}

/** Waits until the agent has started its first child and returns it. */
async function firstChildOf(
  harness: AgentsHarness,
  agentId: string,
): Promise<string> {
  const [call] = await waitFor(
    () => toolCallRowsOf(harness.db, agentId),
    (calls) => calls.some((call) => call.childTaskId !== null),
    `a child of agent ${agentId}`,
  );
  const child = call?.childTaskId;
  if (child === undefined || child === null)
    throw new Error(`agent ${agentId} started no child`);
  return child;
}

describe('data-model / agents: a child takes its model, version and name from the right place and runs on them', () => {
  // AC (DC-19): "Беседа ребёнка, у агента которого модель не задана, получает модель родительской беседы; корень - системную модель; корень без системной
  //   модели получает отказ `model_not_configured`." (the stored-value and model-call half)
  // AC (DC-26): "Глубокий агент, вызвавший `task` с именем не из команды, запускает общего сабагента под этим именем вместо отказа."
  // Behavior: a chat runs on model A and starts an agent without its own model; another chat runs on the system model and starts a deep
  //   agent with model B, which runs a team member without a model, a member with model C and a call with a name outside the team -> each
  //   child conversation row stores the resolved `model`, the version it stands on, its `name` and `subagent`, and its first model call uses
  //   that stored model.
  // Catches: an agent without a model that still runs on the system default instead of the parent's model (R19 not applied on one of the
  //   paths), a stored model different from the one the model call uses, a `task` with an unknown name that is refused, and a temporary
  //   subagent stored under a wrong version or name.
  // @category: core-functionality
  // @dependency: AgentStepHandler, resolveStart, start_agent / start_test_deep_agent / task, ConversationsRepository, Postgres, ScriptedModel
  // @complexity: medium
  it(
    'DC-19 / DC-26: every start path stores the version, name, subagent and the model of the chain (member, then parent, then system), a task with an unknown name starts a general subagent under that name, and the first model call uses the stored model',
    async () => {
      const ownerId = await newUser();

      // Row "start_agent": the chat on model A starts an agent without a model -> the child stores A, not the system model
      {
        const library = createLibraryDouble();
        const helperId = library.add(testRecord('helper', { model: null }));
        const model = createScriptedModel();
        model.script(
          { task: 'Start the helper' },
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
              ],
            },
          ],
          { thereafter: { text: 'noted' } },
        );
        const helper = model.script({ task: 'Helper task' }, [
          { text: 'helper report' },
        ]);
        const harness = await createAgentsHarness({
          model,
          library,
          access: {},
          root: testRecord('chat', { model: MODEL_A, tools: ['start_agent'] }),
        });
        try {
          const { agentId: rootId } = await harness.sessions.start({
            ownerId,
            prompt: 'Start the helper',
            description: 'chat on A',
          });
          const childId = await firstChildOf(harness, rootId);
          await waitForTaskStatus(harness, childId, ownerId, 'completed');

          expect(await storedOf(harness.db, childId)).toEqual({
            name: 'helper',
            subagent: null,
            model: MODEL_A,
            agentVersionId: await activeVersionOf(library, ownerId, helperId),
          });
          expect(helper.calls[0]?.model).toBe(MODEL_A);
        } finally {
          await harness.close();
        }
      }

      // Rows "root", "team member" and "task outside the team": a chat without a model of its own starts a deep agent on model B
      {
        const library = createLibraryDouble();
        const deepAgentId = library.add(
          testDeepAgent('incident team', {
            prompt: 'You run the incident team.',
            servers: [],
            model: MODEL_B,
            maxTurns: 10,
            subagents: [
              testSubagent('scout', { model: null }),
              testSubagent('writer', { model: MODEL_C }),
            ],
            finalSubagent: null,
            taskList: false,
            listDelegation: false,
            selfLearning: false,
          }),
        );
        const model = createScriptedModel();
        model.script(
          { task: 'Start the team' },
          [
            {
              calls: [
                {
                  tool: START_TEST_DEEP_AGENT,
                  args: {
                    deepAgent: deepAgentId,
                    prompt: 'Run the team',
                    description: 'incident team',
                  },
                },
              ],
            },
          ],
          { thereafter: { text: 'noted' } },
        );
        model.script(
          { task: 'Run the team' },
          [
            {
              calls: [
                taskCall({ subagentType: 'scout', description: 'Scout task' }),
                taskCall({
                  subagentType: 'writer',
                  description: 'Writer task',
                }),
                taskCall({
                  subagentType: 'outsider',
                  description: 'Outsider task',
                }),
              ],
            },
          ],
          { thereafter: { text: 'team done' } },
        );
        const scout = model.script({ task: 'Scout task' }, [
          { text: 'scout report' },
        ]);
        const writer = model.script({ task: 'Writer task' }, [
          { text: 'writer report' },
        ]);
        const outsider = model.script({ task: 'Outsider task' }, [
          { text: 'outsider report' },
        ]);
        const harness = await createAgentsHarness({
          model,
          library,
          access: {},
          root: testRecord('chat', { model: null }),
          deepAgentStarter: true,
        });
        try {
          const { agentId: rootId } = await harness.sessions.start({
            ownerId,
            prompt: 'Start the team',
            description: 'chat on the system model',
          });
          const deepId = await firstChildOf(harness, rootId);
          await waitForTaskStatus(harness, deepId, ownerId, 'completed');
          const deepVersion = await activeVersionOf(
            library,
            ownerId,
            deepAgentId,
          );

          // Then (root): the conversation stands on the active version of `chat` and the system model
          const chat = await library.resolveBuiltin('chat');
          expect(await storedOf(harness.db, rootId)).toMatchObject({
            model: TEST_MODEL_DEFAULT,
            agentVersionId: chat.versionId,
          });

          // Then (deep agent): its own model B
          expect(await storedOf(harness.db, deepId)).toEqual({
            name: 'incident team',
            subagent: null,
            model: MODEL_B,
            agentVersionId: deepVersion,
          });

          // Then (team): the member without a model takes B, the member with C keeps C, the name outside the team is general-purpose
          // under that name; every one stands on the deep agent's version and makes its first call on its stored model
          const children = await childrenOf(harness.db, deepId);
          const named = (name: string) =>
            children.find((child) => child.name === name);
          expect([named('scout'), named('writer'), named('outsider')]).toEqual([
            {
              name: 'scout',
              subagent: 'scout',
              model: MODEL_B,
              agentVersionId: deepVersion,
            },
            {
              name: 'writer',
              subagent: 'writer',
              model: MODEL_C,
              agentVersionId: deepVersion,
            },
            {
              name: 'outsider',
              subagent: 'general-purpose',
              model: MODEL_B,
              agentVersionId: deepVersion,
            },
          ]);
          expect(
            [scout, writer, outsider].map((script) => script.calls[0]?.model),
          ).toEqual([MODEL_B, MODEL_C, MODEL_B]);
        } finally {
          await harness.close();
        }
      }
    },
    TEST_TIMEOUT_MS,
  );
});
