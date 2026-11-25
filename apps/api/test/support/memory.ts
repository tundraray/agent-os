import type { ScriptedReply, ScriptedToolCall } from '@agent-os/agents/testing';
import {
  AgentMemoryViewSchema,
  MyMemoryViewSchema,
  type AgentMemoryView,
  type CreateRecordBody,
  type MyMemoryView,
  type RecordDetail,
} from '@agent-os/contracts';
import { randomUUID } from 'node:crypto';
import {
  allowRole,
  HAIKU_TEST_PRICES,
  removeRunRows,
  type RunRole,
  useRunModels,
} from './access';
import { chatApi, expectBody, type ChatApi } from './api';
import { createTestApp, type TestApp } from './createTestApp';
import {
  createRecord,
  deepAgentBody,
  pointBuiltinsAt,
  recordName,
  shareWith,
} from './library';
import {
  briefTask,
  startDeepAgentInChat,
  untilAgentStatus,
  type ToolResult,
} from './record-tools';
import {
  apiRequest,
  createEmployee,
  seedSuperAdmin,
  type Session,
} from './session';

/**
 * The memory tests' world (self-learning MEM, memory-hygiene MH): the harness with workers on, its admin, the
 * role the employees share an agent through, the run's model and the rows `close` removes.
 */
export interface MemoryWorld {
  readonly harness: TestApp;
  readonly admin: Session;
  readonly role: RunRole;
  readonly model: string;
  readonly made: { readonly users: string[]; readonly roles: string[] };
  /** Restores the built-ins and the models, removes the rows, closes the harness. */
  close(): Promise<void>;
}

/** A world whose runs and built-ins answer on `model`; a failed setup closes what it opened. */
export async function openMemoryWorld(model: string): Promise<MemoryWorld> {
  const harness = await createTestApp({ workers: true });
  harness.model.completeText({ text: 'Память' });
  const made = { users: [] as string[], roles: [] as string[] };
  const restores: (() => Promise<void>)[] = [];
  const close = async () => {
    try {
      try {
        for (const restore of restores.reverse()) await restore();
      } finally {
        await removeRunRows(harness.pool, {
          models: [model],
          roles: made.roles,
          users: made.users,
        });
      }
    } finally {
      await harness.close();
    }
  };
  try {
    const admin = await seedSuperAdmin(
      harness.app,
      `e2e-memory-admin-${randomUUID().slice(0, 8)}`,
    );
    made.users.push(admin.id);
    restores.push(
      await useRunModels(harness.app, admin, {
        chat: { id: model, ...HAIKU_TEST_PRICES },
      }),
    );
    restores.push(await pointBuiltinsAt(harness.app, admin, model));
    const role = await allowRole(harness.app, admin, {
      name: 'memory',
      models: [model],
      servers: [],
    });
    made.roles.push(role.id);
    return { harness, admin, role, model, made, close };
  } catch (error) {
    await close();
    throw error;
  }
}

/** A scripted call of a memory tool; `text` and `version` only when given. */
export function memoryCall(
  tool: 'remember' | 'read_memory' | 'forget',
  scope: 'agent' | 'user',
  description: string,
  extra: { readonly text?: string; readonly version?: number } = {},
): ScriptedToolCall {
  return { tool, args: { scope, description, ...extra } };
}

/** A new employee in the world's role. */
export async function employee(world: MemoryWorld): Promise<Session> {
  const session = await createEmployee(world.harness.app, world.admin);
  world.made.users.push(session.id);
  await world.role.add(session);
  return session;
}

/** A self-learning deep agent of `author`, shared with the world's role. */
export async function sharedAgent(
  world: MemoryWorld,
  author: Session,
): Promise<RecordDetail> {
  const body = deepAgentBody(recordName('Память'), world.model);
  const record = await createRecord(world.harness.app, author, {
    ...body,
    content: { ...body.content, selfLearning: true },
  } satisfies CreateRecordBody);
  await shareWith(world.harness.app, author, record.id, [world.role.id]);
  return record;
}

/** «Моя память» of `session`. */
export function myMemory(
  world: MemoryWorld,
  session: Session,
): Promise<MyMemoryView> {
  return expectBody(
    apiRequest(world.harness.app, session, 'get', '/memory'),
    200,
    MyMemoryViewSchema,
  );
}

/** The agent's memory as `session` sees it on the agent's screen. */
export function agentMemory(
  world: MemoryWorld,
  session: Session,
  agentId: string,
): Promise<AgentMemoryView> {
  return expectBody(
    apiRequest(world.harness.app, session, 'get', `/library/${agentId}/memory`),
    200,
    AgentMemoryViewSchema,
  );
}

/** A run of `record` for `session` with its deep agent scripted by `answers`, until it completes. */
export async function runAgent(
  world: MemoryWorld,
  run: {
    readonly session: Session;
    readonly record: RecordDetail;
    /** Unique in the file: the key of the run's scripts. */
    readonly question: string;
    readonly answers: readonly ScriptedReply[];
  },
): Promise<{
  /** The system text of each model call of the deep agent: its memory index. */
  readonly instructions: readonly string[];
  readonly results: readonly ToolResult[];
}> {
  const { harness } = world;
  const script = harness.model.script(
    { task: briefTask(run.question) },
    run.answers,
  );
  const api: ChatApi = chatApi(harness.app, run.session);
  const started = await startDeepAgentInChat(harness.model, api, {
    record: run.record,
    question: run.question,
    chatTask: `Запусти: ${run.question}`,
  });
  await untilAgentStatus(
    api,
    started.threadId,
    started.deepAgentId,
    'completed',
  );
  const page = await api.agentPage(started.deepAgentId);
  return {
    instructions: script.calls.map((call) => call.instructions),
    results: page.entries.flatMap((entry) =>
      entry.kind === 'tool_result' ? [entry.content] : [],
    ),
  };
}
