import type { RecordDetail, WorkflowExecutor } from '@agent-os/contracts';
import { describeApiError } from '@/lib/api/api-request';
import { logger } from '@/lib/logger';
import { libraryApi } from './library-api';
import type { LibraryIndex } from './library-index';
import { recordAction } from './record-action';

/** A saved agent record: the source an executor is copied from. */
export type AgentRecord = Extract<RecordDetail, { kind: 'agent' }>;
export type WorkflowRecord = Extract<RecordDetail, { kind: 'workflow' }>;

/**
 * «Взять новую версию» of one executor (executor-item.md, «Источник обновлён»): the instruction, model,
 * maximum of steps, systems and tools come from the source's version; the name, the responsibility line,
 * «сколько раз звать» stay. Systems the author has no access to do not come in and are named in `dropped`.
 */
export function executorFromSource(
  executor: WorkflowExecutor,
  agent: AgentRecord,
  allowedServers: readonly string[],
): { executor: WorkflowExecutor; dropped: string[] } {
  const { prompt, servers, model, maxTurns, tools } = agent.content;
  return {
    executor: {
      ...executor,
      prompt,
      model,
      maxTurns,
      tools,
      servers: servers.filter((server) => allowedServers.includes(server)),
      source: { recordId: agent.id, version: agent.version },
    },
    dropped: servers.filter((server) => !allowedServers.includes(server)),
  };
}

/** The workflow's executors whose source is `agentId` and is older than the agent's saved version. */
function staleExecutors(workflow: WorkflowRecord, agentId: string): number[] {
  return workflow.content.executors.flatMap((executor, index) =>
    executor.source?.recordId === agentId &&
    workflow.executorSources.some(
      (state) => state.executor === executor.name && state.recordId === agentId && state.state === 'changed',
    )
      ? [index]
      : [],
  );
}

/**
 * The author's own workflows that copied an executor from `agentId` (design-web.md, «Данные экранов»):
 * the own workflows of `libraryIndex`, each read by itself. A failed read is logged and skipped. Never rejects.
 */
export async function workflowsUsing(agentId: string, libraryIndex: LibraryIndex): Promise<WorkflowRecord[]> {
  if (libraryIndex.getState().records === null) await libraryIndex.refresh();
  const own = [...(libraryIndex.getState().records?.values() ?? [])].filter(
    (record) => record.kind === 'workflow' && record.mine,
  );
  const found: WorkflowRecord[] = [];
  for (const summary of own) {
    try {
      const record = await libraryApi.get(summary.id);
      if (record.kind === 'workflow' && staleExecutors(record, agentId).length > 0) found.push(record);
    } catch (error) {
      logger.warn('library: workflow read for "Update there" failed', { agentId, workflowId: summary.id, ...describeApiError(error) });
    }
  }
  return found;
}

/** `dropped` — the systems the taken version lost in this workflow: the author has no access to them. */
export type WorkflowUpdate = { workflow: WorkflowRecord; outcome: 'updated' | 'failed'; dropped: string[] };

/**
 * «Обновить там» (MC-13): every workflow takes the agent's new version for its executors from it and is saved
 * by its own `PUT` with the version it was read at. A refusal of one (a conflict included) stops none of the
 * others and changes nothing of it; after all saves the library list is read once.
 */
export async function updateWorkflows(input: {
  agent: AgentRecord;
  workflows: readonly WorkflowRecord[];
  allowedServers: readonly string[];
  libraryIndex: LibraryIndex;
}): Promise<WorkflowUpdate[]> {
  const { agent, workflows, allowedServers, libraryIndex } = input;
  const results: WorkflowUpdate[] = [];
  for (const workflow of workflows) {
    const stale = staleExecutors(workflow, agent.id);
    const dropped = new Set<string>();
    const executors = workflow.content.executors.map((executor, index) => {
      if (!stale.includes(index)) return executor;
      const taken = executorFromSource(executor, agent, allowedServers);
      taken.dropped.forEach((server) => dropped.add(server));
      return taken.executor;
    });
    const { name, description, version } = workflow;
    try {
      await recordAction({ recordId: workflow.id, kind: 'workflow', action: 'save', version }, () =>
        libraryApi.save(workflow.id, { name, description, kind: 'workflow', content: { ...workflow.content, executors }, version }),
      );
      results.push({ workflow, outcome: 'updated', dropped: [...dropped] });
    } catch {
      // `recordAction` has logged the refusal; the next workflow goes on.
      results.push({ workflow, outcome: 'failed', dropped: [] });
    }
  }
  logger.info('library: workflows updated from agent', {
    agentId: agent.id,
    agentVersion: agent.version,
    results: results.map(({ workflow, outcome }) => ({ workflowId: workflow.id, outcome })),
  });
  await libraryIndex.refresh();
  return results;
}
