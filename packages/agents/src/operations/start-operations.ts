import { CHAT_BUILTIN_KEY } from '@agent-os/contracts';
import { isFinished } from '@agent-os/runtime';

import { AgentsError } from '../errors';
import { auditStartRefusal, resolveStart, type StartSource } from '../start/resolve-start';
import type { RunSnapshot } from '../start/snapshot';
import { type Session, type SessionInput, sessionInputOf, sessions } from '../store/sessions.repository';
import { logStart } from '../tools/system/start-child';
import type { AgentSessions } from './agent-sessions';
import { type AgentSessionsDeps, agentTask, asAgent, createLogged } from './operation-support';

/**
 * Where a restart takes its snapshot (KD-2): a record starts anew by its id, as the owner sees it now;
 * a subagent and a fork restart on their own snapshot.
 */
function restartSource(snapshot: RunSnapshot, session: Session): StartSource {
  if (snapshot.kind === 'subagent' || session.forkedFromTaskId !== null) {
    return { kind: 'restart', snapshot };
  }
  return { kind: 'record', recordId: snapshot.origin.recordId, expected: snapshot.origin.kind };
}

/** The operations that make an agent: the start of a conversation's root and the restart of a finished agent. */
export function createStartOperations(deps: AgentSessionsDeps): Pick<AgentSessions, 'start' | 'restart'> {
  const { database, runtime, logger } = deps;
  const logged = createLogged(logger);

  /**
   * The snapshot of a start by `resolveStart` on behalf of the owner (KD-2), and the log of the start
   * once its agent exists; a refusal is logged and is `START_REFUSED` with its reason and model, and no
   * agent is made. Only a refusal of the access gate writes an `access_denied` record.
   */
  async function startSnapshot(
    ownerId: string,
    source: StartSource,
    parentId: string | null,
  ): Promise<{ snapshot: RunSnapshot; done: (agentId: string, rootId: string) => void }> {
    const startedAt = Date.now();
    const resolution = await resolveStart({ ownerId, source }, deps);
    const entry = { ownerId, parentId, source: source.kind, resolution, startedAt };
    if (resolution.kind === 'refused') {
      await auditStartRefusal(deps.audit, resolution);
      logStart(logger, { ...entry, rootId: null, agentId: null, refusal: resolution.reason });
      throw new AgentsError('START_REFUSED', `A start from source ${source.kind} is refused: ${resolution.reason}`, {
        refusal: { reason: resolution.reason, model: resolution.model },
      });
    }
    return {
      snapshot: resolution.snapshot,
      done: (agentId, rootId) => logStart(logger, { ...entry, rootId, agentId, refusal: null }),
    };
  }

  /**
   * Creates a root — a chat: its task and its session commit together, so whoever sees the task sees the
   * session, and of two starts with one `agentId` the second waits for the first and is `TASK_EXISTS`.
   */
  async function createRoot(
    ownerId: string,
    input: SessionInput,
    agentId?: string,
  ): Promise<{ agentId: string }> {
    return database.transaction(async (tx) => {
      const taskId = await runtime.tasks.create(
        { type: deps.chatStart.type, ownerId, input, ...(agentId === undefined ? {} : { taskId: agentId }) },
        tx,
      );
      await deps.chatStart.startSession(tx, { taskId, ownerId, parentId: null, rootId: taskId }, input);
      return { agentId: taskId };
    });
  }

  /** Creates the task of the snapshot's class under its parent, then its session in its own transaction (plan Notes 11). */
  async function createChild(
    parent: { readonly ownerId: string; readonly parentId: string; readonly rootId: string },
    input: SessionInput,
  ): Promise<{ agentId: string }> {
    const { ownerId, parentId, rootId } = parent;
    const start = deps.childStart(input.snapshot);
    const agentId = await asAgent(runtime.tasks.create({ type: start.type, ownerId, input, parentId }));
    // A worker may take the first step before this: it makes the same session (ON CONFLICT DO NOTHING).
    await database.transaction((tx) =>
      start.startSession(tx, { taskId: agentId, ownerId, parentId, rootId }, input),
    );
    return { agentId };
  }

  return {
    start({ agentId, ownerId, prompt, description, record }) {
      return logged(
        'start',
        { agentId: agentId ?? null, ownerId, recordId: record?.id ?? null },
        async () => {
          const started = await startSnapshot(ownerId, { kind: 'builtin', builtinKey: CHAT_BUILTIN_KEY }, null);
          const created = await createRoot(
            ownerId,
            {
              snapshot: started.snapshot,
              prompt,
              description,
              ...(record === undefined ? {} : { record }),
            },
            agentId,
          );
          started.done(created.agentId, created.agentId);
          return created;
        },
        ({ agentId }) => ({ agentId }),
      );
    },

    restart({ agentId, ownerId }) {
      return logged(
        'restart',
        { agentId, ownerId },
        async () => {
          const task = await agentTask(runtime, agentId, ownerId);
          if (!isFinished(task.status)) {
            throw new AgentsError('NOT_FINISHED', `Agent ${agentId} is ${task.status}, not finished`);
          }
          const session = await sessions.get(database, agentId);
          if (session === undefined) throw new Error(`Finished agent ${agentId} has no session`);
          const { snapshot } = sessionInputOf(task.input);
          // AC-09.2: the same assignment and parent on the snapshot of KD-2; the history starts anew,
          // and a restarted fork does not inherit its parent's.
          const started = await startSnapshot(ownerId, restartSource(snapshot, session), task.parentId);
          const input = {
            snapshot: started.snapshot,
            description: session.description,
            prompt: session.prompt,
          };
          const created =
            task.parentId === null
              ? await createRoot(ownerId, input)
              : await createChild({ ownerId, parentId: task.parentId, rootId: task.rootId }, input);
          started.done(created.agentId, task.rootId);
          return created;
        },
        (restarted) => ({ restartedAs: restarted.agentId }),
      );
    },
  };
}
