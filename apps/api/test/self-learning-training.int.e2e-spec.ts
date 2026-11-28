// self-learning / training - API integration (real AppModule + real Postgres + MCP fixture process, workers on, scripted model)
// Design Doc: docs/features/self-learning/design-training.md, Test Strategy UC-1 (the write barrier), UC-2 (the cap), UC-3 (rights and
//   isolation), UC-4 (one trainer per agent), UC-5 (the main path); design-scripts.md DC-2 (activation guarded by the base version).
//
// Harness: one `createTestApp({ workers: true, mcpServers: ['backoffice'] })`; the fixture's call log is the proof that a changing call
//   never left. Every past task is a real run of the deep agent from its author's chat (`startDeepAgentInChat`). The deep agent of a case
//   answers by a reply function that tells the past run, the base replay and the proposed replay apart by their version's prompt; the
//   judge answers by the order of the two reports in its message. The trainer's script is keyed by its first task.
//
// Not repeated here: the rows of `canTrain` (unit `training-rules.spec.ts`); the judge's mapping of its answer and the random order to a
//   verdict (unit `judge.spec.ts` in packages/agents); the memory rule outside a training tree is self-learning-memory; the report notice is deep-agents-agent-types INT (packages/agents).

import { randomUUID } from 'node:crypto';
import {
  createLatch,
  type RecordedModelCall,
  type ScriptedAnswer,
  type ScriptedReply,
} from '@agent-os/agents/testing';
import type { AgentTurnMessage } from '@agent-os/agents';
import {
  AgentMemoryViewSchema,
  RecordDetailSchema,
  TrainingActivatedSchema,
  TrainingStartedSchema,
  TrainingStateSchema,
  TrainingViewSchema,
  SelfLearningSettingsSchema,
  type AgentMemoryView,
  type CreateRecordBody,
  type DeepAgentContent,
  type HistoryEntry,
  type RecordDetail,
  type Script,
  type TrainingView,
} from '@agent-os/contracts';
import { waitFor } from '@agent-os/db/testing';
import { readFixtureLog } from '@agent-os/mcp-fixture';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  allowRole,
  grantTo,
  HAIKU_TEST_PRICES,
  removeRunRows,
  runModel,
  type RunRole,
  useRunModels,
} from './support/access';
import { chatApi, expectBody, expectError } from './support/api';
import { createTestApp, type TestApp } from './support/createTestApp';
import {
  auditOfRecord,
  createRecord,
  deepAgentBody,
  getRecord,
  pointBuiltinsAt,
  putRecord,
  recordName,
  shareWith,
} from './support/library';
import { BACKOFFICE_SERVER } from './support/mcp-servers';
import {
  briefTask,
  startDeepAgentInChat,
  treeOf,
  untilAgentStatus,
} from './support/record-tools';
import {
  apiRequest,
  createEmployee,
  seedSuperAdmin,
  type Session,
} from './support/session';

const TEST_TIMEOUT_MS = 300_000;
const MODEL = runModel('haiku-training');

const CREATE_NOTE = `mcp__${BACKOFFICE_SERVER}__create_incident_note`;
const GET_ORDER = `mcp__${BACKOFFICE_SERVER}__get_order`;
const NOTE_ARGS = { orderId: 'ord-0000a001', text: 'from a replay' };
/** Code that calls the changing tool and returns how the call ended: `recorded` in a training tree. */
const NOTE_CODE = [
  `try { await callTool(${JSON.stringify(CREATE_NOTE)}, ${JSON.stringify(NOTE_ARGS)}); return "sent"; }`,
  'catch (error) { return error.outcome; }',
].join('\n');
const NOTE_SCRIPT: Script = {
  name: 'note',
  description: 'Writes the incident note of the order',
  input: '',
  code: NOTE_CODE,
  class: 'write',
  owner: null,
};

const PAST_REPORT = 'Отчёт прошлого запуска.';
const BASE_REPORT = 'Отчёт основы.';
const PROPOSED_REPORT = 'Отчёт предложенной версии.';
const CHANGES = 'Промпт короче, скрипт тот же.';
/** A description and a text of the employee's memory the past run writes: the trainer never sees them. */
const SECRET_DESCRIPTION = 'Предпочтение Ани zx81';
const SECRET_TEXT = 'Аня любит отчёты таблицей qq42';

/** The trainer's first task, as the start writes it. */
function trainerTask(name: string, version: number): string {
  return `Обучи агента «${name}»: основа — его версия ${version}. Иди по списку задач.`;
}

function taskUpdate(taskId: number, status: string) {
  return { tool: 'task_update', args: { taskId, status } };
}

/** The prompt markers of one deep agent: its past version, the base the training starts from and the proposal. */
interface Prompts {
  readonly past: string;
  readonly base: string;
  readonly proposed: string;
}

function promptsOf(tag: string): Prompts {
  return {
    past: `PAST ${tag}`,
    base: `BASE ${tag}`,
    proposed: `PROPOSED ${tag}`,
  };
}

/**
 * The deep agent's answers, told apart by the prompt of the run's version: the past run answers its report (after `pastCalls`), the
 * base replay makes `baseCalls` first, the proposed replay answers at once. The report document is the double's.
 */
function deepAgentReply(
  prompts: Prompts,
  calls: {
    readonly past?: ScriptedAnswer['calls'];
    readonly base?: ScriptedAnswer['calls'];
  } = {},
): ScriptedReply {
  return (messages: readonly AgentTurnMessage[], call: RecordedModelCall) => {
    const first = messages.at(-1)?.role === 'user';
    if (call.instructions.includes(prompts.proposed))
      return { text: PROPOSED_REPORT };
    const own = call.instructions.includes(prompts.past)
      ? { calls: calls.past, report: PAST_REPORT }
      : { calls: calls.base, report: BASE_REPORT };
    return first && own.calls !== undefined
      ? { calls: own.calls }
      : { text: own.report };
  };
}

/** The judge: `proposed_better` whatever order the two reports come in. */
const judgeReply: ScriptedReply = (messages) => {
  const [message] = messages;
  const text = message?.role === 'user' ? message.content : '';
  const proposedFirst =
    text.indexOf(PROPOSED_REPORT) < text.indexOf(BASE_REPORT);
  return {
    calls: [
      {
        tool: 'verdict',
        args: {
          better: proposedFirst ? 'first' : 'second',
          reason: 'The proposed report is clearer.',
        },
      },
    ],
  };
};

function toolResults(
  entries: readonly HistoryEntry[],
  tool: string,
): Extract<HistoryEntry, { kind: 'tool_result' }>['content'][] {
  return entries.flatMap((entry) =>
    entry.kind === 'tool_result' && entry.content.tool === tool
      ? [entry.content]
      : [],
  );
}

let harness: TestApp;
let admin: Session;
/** Authors who may train their own agents and use the back office. */
let ownTrainers: RunRole;
/** Holders of the right to train any agent in the panel. */
let anyTrainers: RunRole;
/** Employees with no training right. */
let plain: RunRole;
let restoreModels: (() => Promise<void>) | undefined;
let restoreBuiltins: (() => Promise<void>) | undefined;
const made = { users: [] as string[], roles: [] as string[] };

async function employee(role: RunRole): Promise<Session> {
  const session = await createEmployee(harness.app, admin);
  made.users.push(session.id);
  await role.add(session);
  return session;
}

async function runRole(
  name: string,
  rights: { trainOwn?: boolean; trainAny?: boolean },
): Promise<RunRole> {
  const role = await allowRole(harness.app, admin, {
    name,
    models: [MODEL],
    servers: [BACKOFFICE_SERVER],
  });
  made.roles.push(role.id);
  if (Object.keys(rights).length > 0)
    await apiRequest(
      harness.app,
      admin,
      'patch',
      `/admin/roles/${role.id}`,
      rights,
    ).expect(200);
  return role;
}

/** A self-learning deep agent of `author` on its past prompt, with the back office at the deep agent itself. */
function trainedAgentBody(
  name: string,
  prompts: Prompts,
): Extract<CreateRecordBody, { kind: 'deep_agent' }> {
  const body = deepAgentBody(name, MODEL);
  return {
    ...body,
    content: {
      ...body.content,
      prompt: prompts.past,
      servers: [BACKOFFICE_SERVER],
      selfLearning: true,
    },
  };
}

/** Saves a new version of the agent with `content` over its current one. */
function saveVersion(
  author: Session,
  record: RecordDetail,
  content: Partial<DeepAgentContent>,
): Promise<RecordDetail> {
  if (record.kind !== 'deep_agent') throw new Error('not a deep agent');
  return putRecord(harness.app, author, record.id, {
    kind: 'deep_agent',
    name: record.name,
    description: record.description,
    version: record.version,
    content: { ...record.content, ...content },
  });
}

/**
 * A deep agent of `author` with one completed past task run on its past prompt, then saved as the base version (version 2, its
 * prompt `prompts.base`, `scripts`). Returns the record at version 2 and the past task's conversation.
 */
async function agentWithPastTask(
  author: Session,
  tag: string,
  options: {
    readonly scripts?: readonly Script[];
    readonly pastCalls?: ScriptedAnswer['calls'];
    readonly baseCalls?: ScriptedAnswer['calls'];
  } = {},
): Promise<{
  readonly record: RecordDetail;
  readonly prompts: Prompts;
  readonly pastId: string;
  readonly threadId: string;
}> {
  const prompts = promptsOf(`${tag} ${randomUUID().slice(0, 8)}`);
  const created = await createRecord(
    harness.app,
    author,
    trainedAgentBody(recordName(`Обучаемый ${tag}`), prompts),
  );
  const question = `Вопрос ${prompts.past}`;
  harness.model.script({ task: briefTask(question) }, [], {
    thereafter: deepAgentReply(prompts, {
      ...(options.pastCalls === undefined ? {} : { past: options.pastCalls }),
      ...(options.baseCalls === undefined ? {} : { base: options.baseCalls }),
    }),
  });
  const api = chatApi(harness.app, author);
  const { threadId, deepAgentId } = await startDeepAgentInChat(
    harness.model,
    api,
    {
      record: created,
      question,
      chatTask: `Запусти ${prompts.past}`,
    },
  );
  await untilAgentStatus(api, threadId, deepAgentId, 'completed');
  const record = await saveVersion(author, created, {
    prompt: prompts.base,
    scripts: [...(options.scripts ?? [])],
  });
  return { record, prompts, pastId: deepAgentId, threadId };
}

function startTraining(session: Session, recordId: string) {
  return apiRequest(
    harness.app,
    session,
    'post',
    `/library/${recordId}/training`,
  );
}

async function started(session: Session, recordId: string): Promise<string> {
  const { trainingId } = await expectBody(
    startTraining(session, recordId),
    201,
    TrainingStartedSchema,
  );
  return trainingId;
}

function trainingView(
  session: Session,
  recordId: string,
  trainingId: string,
): Promise<TrainingView> {
  return expectBody(
    apiRequest(
      harness.app,
      session,
      'get',
      `/library/${recordId}/training/${trainingId}`,
    ),
    200,
    TrainingViewSchema,
  );
}

function untilTraining(
  session: Session,
  recordId: string,
  trainingId: string,
  status: TrainingView['status'],
): Promise<TrainingView> {
  return waitFor(
    () => trainingView(session, recordId, trainingId),
    (view) => view.status === status,
    `training ${trainingId} to be ${status}`,
    60_000,
  );
}

/** The agent's memory as its author sees it. */
function agentMemory(
  session: Session,
  recordId: string,
): Promise<AgentMemoryView> {
  return expectBody(
    apiRequest(harness.app, session, 'get', `/library/${recordId}/memory`),
    200,
    AgentMemoryViewSchema,
  );
}

/** The calls that reached the back office, by tool. */
function sentTools(): string[] {
  return readFixtureLog(harness.fixtureLog.callLog).map((entry) => entry.tool);
}

/** The judge answers every training's pair; the trainer's name is the built-in record's in either language. */
function scriptJudge(): void {
  for (const agent of ['Тренер', 'Trainer'])
    harness.model.script({ agent }, [], { thereafter: judgeReply });
}

describe('self-learning / training - the trainer changes nothing outside, stays under its cap and its rights, and its version is switched on by its starter only', () => {
  beforeAll(async () => {
    harness = await createTestApp({
      workers: true,
      mcpServers: ['backoffice'],
    });
    harness.model.completeText({ text: 'Обучение' });
    admin = await seedSuperAdmin(
      harness.app,
      `e2e-training-admin-${randomUUID().slice(0, 8)}`,
    );
    made.users.push(admin.id);
    restoreModels = await useRunModels(harness.app, admin, {
      chat: { id: MODEL, ...HAIKU_TEST_PRICES },
    });
    restoreBuiltins = await pointBuiltinsAt(harness.app, admin, MODEL);
    ownTrainers = await runRole('train-own', { trainOwn: true });
    anyTrainers = await runRole('train-any', { trainAny: true });
    plain = await runRole('train-none', {});
    scriptJudge();
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    if (harness === undefined) return;
    try {
      try {
        await restoreBuiltins?.();
        await restoreModels?.();
      } finally {
        await removeRunRows(harness.pool, {
          models: [MODEL],
          roles: made.roles,
          users: made.users,
        });
      }
    } finally {
      await harness.close();
    }
  }, TEST_TIMEOUT_MS);

  // Main path (UC-5) with the write barrier (UC-1) and the trainer's reads (UC-3, reads half).
  // Catches: a changing call sent from a training tree — directly, from `run_code` of class write, from a `write` script or from
  //   `try_script` — or a question asked in it; a memory record written from it; a replay or judge that never runs or wakes the
  //   trainer; the employee's own memory reaching the trainer; a read of a conversation that is not the agent's past task;
  //   an activation that does not move the active version or writes no audit; a message to a replay that is not refused as missing.
  it(
    'TR-1: start -> the trainer closes tasks 2 and 3 and proposes a version -> two replays write nothing outside and report -> the judge decides -> done -> the starter switches the version on',
    async () => {
      const anya = await employee(ownTrainers);
      const api = chatApi(harness.app, anya);
      const past = await agentWithPastTask(anya, 'main', {
        scripts: [NOTE_SCRIPT],
        pastCalls: [
          {
            tool: 'remember',
            args: {
              scope: 'user',
              description: SECRET_DESCRIPTION,
              text: SECRET_TEXT,
            },
          },
        ],
        baseCalls: [
          { tool: CREATE_NOTE, args: NOTE_ARGS },
          {
            tool: 'run_code',
            args: {
              description: 'Заметка кодом',
              class: 'write',
              script: NOTE_CODE,
            },
          },
          { tool: 'script__note', args: {} },
          {
            tool: 'remember',
            args: { scope: 'agent', description: 'Как', text: 'Так' },
          },
        ],
      });
      const { record } = past;
      const sentBefore = sentTools();
      const memoryBefore = await agentMemory(anya, record.id);
      const trainer = harness.model.script(
        { task: trainerTask(record.name, 2) },
        [
          {
            calls: [
              {
                tool: 'read_past_task',
                args: { conversation: past.pastId },
              },
              // The chat of the past task is a conversation, but not a past task of the agent.
              {
                tool: 'read_past_task',
                args: { conversation: past.threadId },
              },
              {
                tool: 'try_script',
                args: {
                  name: 'note',
                  code: NOTE_CODE,
                  class: 'write',
                  owner: null,
                },
              },
            ],
          },
          { calls: [taskUpdate(2, 'completed')] },
          { calls: [taskUpdate(3, 'completed')] },
          {
            calls: [
              {
                tool: 'propose_version',
                args: {
                  prompt: past.prompts.proposed,
                  scripts: [NOTE_SCRIPT],
                  changes: CHANGES,
                },
              },
            ],
          },
        ],
      );

      const trainingId = await started(anya, record.id);
      const done = await untilTraining(anya, record.id, trainingId, 'done');

      // The result view of the starter
      expect(done).toMatchObject({
        baseVersion: 2,
        cappedAt: null,
        recommended: true,
        canActivate: true,
        activatedAt: null,
        activeVersion: 2,
        proposal: {
          version: 3,
          changes: CHANGES,
          explanation: null,
          base: { prompt: past.prompts.base },
          proposed: { prompt: past.prompts.proposed },
        },
      });
      expect(done.pool.map((task) => task.status)).toEqual(
        Array(6).fill('completed'),
      );
      expect(done.comparisons).toHaveLength(1);
      expect(done.comparisons[0]).toMatchObject({
        verdict: 'proposed_better',
        reason: expect.stringMatching(
          /^The proposed report is clearer\. \(first answer: (base|proposed) version; second answer: (base|proposed) version\)$/,
        ),
      });
      expect(trainer.calls).toHaveLength(4);

      // The tree: the trainer, two replays, each ended with its report; nobody was asked
      const conversation = await api.history(trainingId);
      expect(conversation.decisions).toEqual([]);
      const replays = treeOf(conversation.agents).filter(
        (agent) => agent.agentId !== trainingId,
      );
      expect(replays.map((replay) => replay.status)).toEqual([
        'completed',
        'completed',
      ]);
      const baseId = done.comparisons[0]?.base?.conversationId ?? '';
      const proposedId = done.comparisons[0]?.proposed?.conversationId ?? '';
      expect(new Set([baseId, proposedId])).toEqual(
        new Set(replays.map((replay) => replay.agentId)),
      );

      // The write barrier: nothing changing reached the back office, every way ended `recorded`
      expect(sentTools().slice(sentBefore.length)).toEqual([]);
      const baseEntries = (await api.agentPage(baseId)).entries;
      expect(
        toolResults(baseEntries, 'create_incident_note').map(
          (result) => result.outcome,
        ),
      ).toEqual(['recorded']);
      // Inside code the call throws with the outcome `recorded`, which each script returns.
      expect(
        ['run_code', 'script__note'].map(
          (tool) => toolResults(baseEntries, tool)[0]?.text,
        ),
      ).toEqual(['recorded', 'recorded']);
      // A training tree writes no memory: the replay's `remember` leaves the agent's memory as it was.
      expect(await agentMemory(anya, record.id)).toEqual(memoryBefore);
      const trainerEntries = conversation.entries;
      expect(toolResults(trainerEntries, 'try_script')[0]?.recorded).toEqual([
        CREATE_NOTE,
      ]);

      // The trainer's reads: the past task without the employee's memory; a conversation that is not one refused
      const [read, foreign] = toolResults(trainerEntries, 'read_past_task');
      expect(read?.outcome).toBe('success');
      expect(read?.text).toContain(PAST_REPORT);
      // The past run's own memory call is listed, without its record.
      expect(read?.text).toContain('"scope": "user"');
      expect(read?.text).not.toContain(SECRET_DESCRIPTION);
      expect(read?.text).not.toContain(SECRET_TEXT);
      expect(foreign).toMatchObject({
        outcome: 'refused',
        refusalReason: 'invalid_arguments',
      });

      // A replay takes no message: it answers as a missing agent
      const toReplay = await expectError(
        api.raw('post', `/agents/${baseId}/messages`, {
          text: 'ещё',
          sendKey: randomUUID(),
        }),
        404,
      );
      expect(toReplay.errorCode).toBe('AGENT_NOT_FOUND');

      // Activation: the active version moves to 3, one audit record
      const activated = await expectBody(
        apiRequest(
          harness.app,
          anya,
          'post',
          `/library/${record.id}/training/${trainingId}/activate`,
        ),
        200,
        TrainingActivatedSchema,
      );
      expect(activated.version).toBe(3);
      expect((await getRecord(harness.app, anya, record.id)).version).toBe(3);
      expect(
        (await auditOfRecord(harness.pool, record.id)).filter(
          (event) => event.kind === 'training_activate',
        ),
      ).toEqual([
        expect.objectContaining({
          actor: anya.id,
          before: { version: 2 },
          after: { version: 3, trainingId },
          outcome: 'ok',
        }),
      ]);
    },
    TEST_TIMEOUT_MS,
  );

  // Ordering case of the pool: the trainer closes its proposal task without a version.
  // Catches: a training that waits forever or starts replays without a version; an explanation that is not the closing answer's text.
  it(
    'TR-2: task 4 closed without a version -> done at once, no replays, the explanation is the text of that answer',
    async () => {
      const anya = await employee(ownTrainers);
      const { record } = await agentWithPastTask(anya, 'no-version');
      const explanation = 'Улучшать нечего: все прошлые задачи решены.';
      harness.model.script({ task: trainerTask(record.name, 2) }, [
        { calls: [taskUpdate(2, 'completed')] },
        { calls: [taskUpdate(3, 'completed')] },
        { text: explanation, calls: [taskUpdate(4, 'completed')] },
      ]);

      const trainingId = await started(anya, record.id);
      const done = await untilTraining(anya, record.id, trainingId, 'done');

      expect(done).toMatchObject({
        proposal: { version: null, explanation },
        recommended: null,
        canActivate: false,
      });
      expect(done.comparisons.map((element) => element.base)).toEqual([null]);
      expect(done.pool.map((task) => task.status)).toEqual(
        Array(6).fill('completed'),
      );
      expect(await chatApi(harness.app, anya).threadAgents(trainingId)).toEqual(
        [],
      );
    },
    TEST_TIMEOUT_MS,
  );

  // UC-2: the spend cap.
  // Catches: a model call made after the ledger passed the cap; a cap mark missing or written twice; a tree left running at the cap.
  it(
    'TR-3: the first trainer answer passes the cap -> no further model call in the tree, capped_at set, the training stopped',
    async () => {
      const anya = await employee(ownTrainers);
      const { record } = await agentWithPastTask(anya, 'cap');
      // 1 000 000 input tokens above the long-context threshold: 0,5 USD, past the lowest cap of 0,1 USD.
      const trainer = harness.model.script(
        { task: trainerTask(record.name, 2) },
        [
          {
            calls: [taskUpdate(2, 'completed')],
            usage: { inputTokens: 1_000_000, outputTokens: 10 },
          },
        ],
        { thereafter: { calls: [taskUpdate(3, 'completed')] } },
      );
      const settingsPath = '/admin/self-learning/settings';
      const settings = await expectBody(
        apiRequest(harness.app, admin, 'get', settingsPath),
        200,
        SelfLearningSettingsSchema,
      );
      const putCap = (trainingCapUsd: number) =>
        expectBody(
          apiRequest(harness.app, admin, 'put', settingsPath, {
            memoryIndexTokens: settings.memoryIndexTokens,
            trainingCapUsd,
          }),
          200,
          SelfLearningSettingsSchema,
        );
      await putCap(0.1);
      let trainingId: string;
      try {
        trainingId = await started(anya, record.id);
      } finally {
        await putCap(settings.trainingCapUsd);
      }

      const stopped = await untilTraining(
        anya,
        record.id,
        trainingId,
        'stopped',
      );
      expect(stopped.capUsd).toBe(0.1);
      expect(stopped.cappedAt).not.toBeNull();
      expect(stopped.spentUsd).toBeGreaterThanOrEqual(0.1);
      expect(trainer.calls).toHaveLength(1);
      // A later view gives the same mark and no new call happened.
      expect((await trainingView(anya, record.id, trainingId)).cappedAt).toBe(
        stopped.cappedAt,
      );
      expect(trainer.calls).toHaveLength(1);
    },
    TEST_TIMEOUT_MS,
  );

  // UC-4: one trainer per agent, and the trainer's root as a conversation.
  // Catches: two trainers of one agent from concurrent starts; a trainer that takes a message or a restart; a stop by another
  //   employee; a key that stays taken after a stop.
  it(
    'TR-4: two concurrent starts -> one trainer, the other TRAINING_RUNNING; the trainer takes no message or restart; only its starter stops it; a new start then succeeds',
    async () => {
      const anya = await employee(ownTrainers);
      const boris = await employee(anyTrainers);
      const { record } = await agentWithPastTask(anya, 'one');
      // An author shares only with her own roles.
      await anyTrainers.add(anya);
      await shareWith(harness.app, anya, record.id, [anyTrainers.id]);
      const held = createLatch();
      harness.model.script({ task: trainerTask(record.name, 2) }, [], {
        thereafter: { latch: held, calls: [taskUpdate(2, 'completed')] },
      });

      const responses = await Promise.all([
        startTraining(anya, record.id),
        startTraining(anya, record.id),
      ]);
      expect(
        responses.map((response) => response.status).sort((a, b) => a - b),
      ).toEqual([201, 409]);
      const refused = responses.find((response) => response.status === 409);
      expect(refused?.body.errorCode).toBe('TRAINING_RUNNING');
      const trainingId = TrainingStartedSchema.parse(
        responses.find((response) => response.status === 201)?.body,
      ).trainingId;
      const state = await expectBody(
        apiRequest(harness.app, anya, 'get', `/library/${record.id}/training`),
        200,
        TrainingStateSchema,
      );
      expect(state.running?.id).toBe(trainingId);
      // FR-15: the running training stays on the card of everyone who may train the agent
      const borisState = await expectBody(
        apiRequest(harness.app, boris, 'get', `/library/${record.id}/training`),
        200,
        TrainingStateSchema,
      );
      expect(borisState.running).toMatchObject({
        id: trainingId,
        startedByMe: false,
      });

      const anyaApi = chatApi(harness.app, anya);
      for (const [path, body] of [
        [
          `/agents/${trainingId}/messages`,
          { text: 'ещё', sendKey: randomUUID() },
        ],
        [`/agents/${trainingId}/restart`, undefined],
      ] as const) {
        const error = await expectError(anyaApi.raw('post', path, body), 404);
        expect(error.errorCode).toBe('AGENT_NOT_FOUND');
      }
      // Boris may train this agent, but the trainer is Anya's: no other check keeps a non-owner off a training root.
      await expectError(
        chatApi(harness.app, boris).raw('post', `/agents/${trainingId}/stop`),
        404,
      );
      await anyaApi.stopAgent(trainingId);
      await untilTraining(anya, record.id, trainingId, 'stopped');

      const again = await started(anya, record.id);
      expect(again).not.toBe(trainingId);
      await anyaApi.stopAgent(again);
      await untilTraining(anya, record.id, again, 'stopped');
    },
    TEST_TIMEOUT_MS,
  );

  // UC-3: rights and isolation at the routes, and the activation guard (scripts DC-2).
  // Catches: a training open to an employee without the right; a non-starter who reads the result (UC-8, FR-15) or switches the version on; a
  //   training read through another agent's address; an activation over a base the author has replaced, or one that moves the pointer
  //   anyway; a start with nothing to compare, or one that compares a past task
  //   whose run called a tool the starter has no right to (isolation between users).
  it(
    "TR-5: canTrain by author and panel rights; a non-starter gets 404, no last result and no activation; another agent's training is 404; a stale base is refused and moves nothing; no past tasks, or only ones calling a tool the starter is denied, is 409",
    async () => {
      const anya = await employee(ownTrainers);
      const boris = await employee(anyTrainers);
      const gleb = await employee(plain);
      // The only past task called a tool Boris is denied: it is no past task of a training he starts.
      const { record, prompts } = await agentWithPastTask(anya, 'rights', {
        pastCalls: [{ tool: GET_ORDER, args: { orderId: NOTE_ARGS.orderId } }],
      });
      await grantTo(
        harness.app,
        admin,
        { userId: boris.id },
        {
          effect: 'deny',
          target: {
            kind: 'tool',
            server: BACKOFFICE_SERVER,
            tool: 'get_order',
          },
        },
      );
      await anyTrainers.add(anya);
      await plain.add(anya);
      await shareWith(harness.app, anya, record.id, [anyTrainers.id, plain.id]);
      harness.model.script({ task: trainerTask(record.name, 2) }, [
        {
          calls: [
            {
              tool: 'propose_version',
              args: {
                prompt: prompts.proposed,
                scripts: [],
                changes: CHANGES,
              },
            },
          ],
        },
      ]);
      const trainingId = await started(anya, record.id);
      await untilTraining(anya, record.id, trainingId, 'done');

      // Gleb sees the agent but has no right: the state says so, the start is 403
      const glebState = await expectBody(
        apiRequest(harness.app, gleb, 'get', `/library/${record.id}/training`),
        200,
        TrainingStateSchema,
      );
      expect(glebState).toMatchObject({ canTrain: false, lastFinished: null });
      expect(
        (await expectError(startTraining(gleb, record.id), 403)).errorCode,
      ).toBe('TRAINING_FORBIDDEN');

      // Boris may train any agent in the panel: the result is the starter's alone (FR-15) — not found, not on his card, not his to switch on
      expect(
        (
          await expectError(
            apiRequest(
              harness.app,
              boris,
              'get',
              `/library/${record.id}/training/${trainingId}`,
            ),
            404,
          )
        ).errorCode,
      ).toBe('TRAINING_NOT_FOUND');
      const borisState = await expectBody(
        apiRequest(harness.app, boris, 'get', `/library/${record.id}/training`),
        200,
        TrainingStateSchema,
      );
      expect(borisState).toMatchObject({ canTrain: true, lastFinished: null });
      const activatePath = `/library/${record.id}/training/${trainingId}/activate`;
      expect(
        (
          await expectError(
            apiRequest(harness.app, boris, 'post', activatePath),
            403,
          )
        ).errorCode,
      ).toBe('TRAINING_FORBIDDEN');
      expect(
        (await expectError(startTraining(boris, record.id), 409)).errorCode,
      ).toBe('TRAINING_NO_PAST_TASKS');

      // Another agent's address does not reach this training
      const other = await createRecord(
        harness.app,
        anya,
        trainedAgentBody(recordName('Другой агент'), promptsOf('other')),
      );
      expect(
        (
          await expectError(
            apiRequest(
              harness.app,
              anya,
              'get',
              `/library/${other.id}/training/${trainingId}`,
            ),
            404,
          )
        ).errorCode,
      ).toBe('TRAINING_NOT_FOUND');
      // ... and an agent without past tasks has nothing to compare
      expect(
        (await expectError(startTraining(anya, other.id), 409)).errorCode,
      ).toBe('TRAINING_NO_PAST_TASKS');

      // The author saves a new version: the activation is stale and the active version stays the saved one
      const current = await getRecord(harness.app, anya, record.id);
      const saved = await saveVersion(anya, current, {
        prompt: `${prompts.base} v4`,
      });
      expect(
        (
          await expectError(
            apiRequest(harness.app, anya, 'post', activatePath),
            409,
          )
        ).errorCode,
      ).toBe('TRAINING_BASE_CHANGED');
      const after = RecordDetailSchema.parse(
        await getRecord(harness.app, anya, record.id),
      );
      expect([after.version, after.content.prompt]).toEqual([
        saved.version,
        `${prompts.base} v4`,
      ]);
      expect(
        (await auditOfRecord(harness.pool, record.id)).filter(
          (event) => event.kind === 'training_activate',
        ),
      ).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );
});
