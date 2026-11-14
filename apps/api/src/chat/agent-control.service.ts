import { Inject, Injectable } from '@nestjs/common';
import {
  AgentsError,
  type AgentHistoryEntry,
  type Agents,
  type AgentView as AgentsAgentView,
} from '@agent-os/agents';
import {
  HISTORY_PAGE_SIZE,
  type AgentListNode,
  type AgentListPage,
  type AgentPageView,
  type AwaitingCount,
  type DecisionRequest,
  type DecisionResponse,
  type HistoryEntry,
  type InheritedHistory,
  type InterruptResponse,
  type RestartResponse,
  type SpendResponse,
  type StopResponse,
  type WorkflowRunView,
} from '@agent-os/contracts';
import type { Runtime } from '@agent-os/runtime';
import type { Workflows } from '@agent-os/workflows';
import { AGENTS } from '../agents/agents.tokens.js';
import { RUNTIME } from '../runtime/runtime.tokens.js';
import { WORKFLOWS } from '../workflows/workflows.tokens.js';
import { httpError } from './chat.errors.js';
import { AGENT_LIST_PAGE_SIZE } from './chat.tokens.js';
import {
  type TemplateTitles,
  templateTitles,
  toAgentTree,
  toAgentView,
  toConfirmation,
  toHistoryEntry,
  toPending,
} from './conversation-view.js';
import { type Conversation, ConversationsRepository } from './conversations.repository.js';
import { isUuid, toThreadSummary } from './conversations.service.js';
import { decodeThreadCursor, selectThreadPage, sortThreadsForList } from './thread-cursor.js';

const agentNotFound = () => httpError('AGENT_NOT_FOUND');

/** A top agent of the list with the position the list order and its cursor read. */
type ListedAgent = { readonly updatedAt: Date; readonly id: string; readonly node: AgentListNode };

/** The current month `YYYY-MM` by UTC. */
const utcMonth = (now: Date): string => now.toISOString().slice(0, 7);

/**
 * The next `afterSeq` of a history page: the last seq of a full page, `null` when everything is read
 * (the rule of the conversation view).
 */
const nextAfterSeqOf = (entries: readonly AgentHistoryEntry[]): number | null =>
  entries.length === HISTORY_PAGE_SIZE ? (entries.at(-1)?.seq ?? null) : null;

/**
 * The agent routes, decisions and spend (design-chat.md, Contract «Агенты», «Решения и расход», KD-7,
 * DC-3). Every agent operation starts with `agents.sessions.get` (the owner check of the package) and
 * refuses a conversation's root: for the web the root is not an agent. A malformed, missing or foreign
 * id answers as a missing one. Agents are reached only through `agents`, `workflows` and `runtime`;
 * the only table read is `chat_conversations`.
 */
@Injectable()
export class AgentControlService {
  constructor(
    private readonly conversations: ConversationsRepository,
    @Inject(AGENTS) private readonly agents: Agents,
    @Inject(RUNTIME) private readonly runtime: Runtime,
    @Inject(WORKFLOWS) private readonly workflows: Workflows,
    @Inject(AGENT_LIST_PAGE_SIZE) private readonly pageSize: number,
  ) {}

  /**
   * KD-7: the top agents (children of roots) of all the owner's conversations, newest first
   * (`createdAt` DESC, then `agentId` DESC), with their subtrees and conversation.
   */
  async page(ownerId: string, cursor?: string): Promise<AgentListPage> {
    const position = cursor === undefined ? undefined : decodeThreadCursor(cursor);
    if (position !== undefined && !isUuid(position.i)) throw httpError('INVALID_CURSOR');
    const templates = this.templateTitles();
    const rows = await this.conversations.listWithRoot(ownerId);
    const perConversation = await Promise.all(
      rows.map(async (row) => this.topAgentsOf(row, ownerId, templates)),
    );
    const page = selectThreadPage({
      sorted: sortThreadsForList(perConversation.flat()),
      ...(position === undefined ? {} : { cursor: position }),
      size: this.pageSize,
    });
    return { agents: page.threads.map((listed) => listed.node), nextCursor: page.nextCursor };
  }

  /** NV-01: open decision requests across all the owner's conversations. */
  async awaiting(ownerId: string): Promise<AwaitingCount> {
    const rows = await this.conversations.listWithRoot(ownerId);
    const counts = await Promise.all(
      rows.map(async ({ rootId }) => {
        if (rootId === null) return 0;
        const confirmations = await unlessDeleted(
          this.agents.sessions.confirmations(rootId, ownerId),
        );
        return confirmations.filter((confirmation) => confirmation.status === 'open').length;
      }),
    );
    return { count: counts.reduce((sum, count) => sum + count, 0) };
  }

  /** `AgentPageView`: the agent with its conversation, a page of its history, its queue, own requests and subtree. */
  async history(agentId: string, ownerId: string, afterSeq: number): Promise<AgentPageView> {
    const view = await this.agent(agentId, ownerId);
    const conversation = await this.conversations.findByRoot(view.rootId);
    if (conversation === undefined || conversation.ownerId !== ownerId) throw agentNotFound();
    const [views, entries, messages, confirmations] = await Promise.all([
      this.agents.sessions.list(view.rootId, ownerId),
      this.agents.sessions.history({ agentId, ownerId, afterSeq, limit: HISTORY_PAGE_SIZE }),
      this.runtime.inbox.listPending(agentId, ownerId),
      this.agents.sessions.confirmations(view.rootId, ownerId),
    ]);
    const templates = this.templateTitles();
    // design v1.2 (A-2): the parent's description, unless the parent is the conversation's root.
    const parent = views.find((candidate) => candidate.agentId === view.parentId);
    const parentDescription =
      parent === undefined || parent.parentId === null ? undefined : parent.description;
    return {
      agent: {
        ...toAgentView(view, templates),
        threadId: conversation.id,
        threadTitle: toThreadSummary(conversation).title,
        ...(parentDescription === undefined ? {} : { parentDescription }),
      },
      entries: entries.map(toHistoryEntry),
      nextAfterSeq: nextAfterSeqOf(entries),
      pending: toPending(messages, views),
      decisions: confirmations
        .filter((confirmation) => confirmation.agentId === agentId)
        .map((confirmation) => toConfirmation(confirmation, templates)),
      children: toAgentTree(
        views.map((agent) => toAgentView(agent, templates)),
        agentId,
      ),
    };
  }

  /** AV-05: the fork parent's entries through `throughSeq`; empty for an agent that is not a fork. */
  async inherited(agentId: string, ownerId: string, afterSeq: number): Promise<InheritedHistory> {
    const { forkedFrom } = await this.agent(agentId, ownerId);
    if (forkedFrom === null) return { entries: [], nextAfterSeq: null };
    const page = await this.agents.sessions.history({
      agentId: forkedFrom.agentId,
      ownerId,
      afterSeq,
      limit: HISTORY_PAGE_SIZE,
    });
    const entries: HistoryEntry[] = page
      .filter((entry) => entry.seq <= forkedFrom.throughSeq)
      .map(toHistoryEntry);
    const last = page.at(-1);
    // A full page that ends before the fork point has more to read; anything else is read through.
    const more = nextAfterSeqOf(page) !== null && last !== undefined && last.seq < forkedFrom.throughSeq;
    return { entries, nextAfterSeq: more ? last.seq : null };
  }

  /** The workflow run of a coordinator; any other agent is `RUN_NOT_FOUND` (from `workflows`). */
  async run(agentId: string, ownerId: string): Promise<WorkflowRunView> {
    await this.agent(agentId, ownerId);
    const run = await this.workflows.runs.get(agentId, ownerId);
    const templates = this.templateTitles();
    return {
      agentId: run.agentId,
      template: { name: run.template.name, title: run.template.title },
      brief: { ...run.brief },
      coordinator: toAgentView(run.coordinator, templates),
      steps: run.steps.map((step) => toAgentView(step, templates)),
    };
  }

  /** A message to the agent; to a finished agent it continues with its history. */
  async send(agentId: string, ownerId: string, text: string): Promise<{ messageId: string }> {
    await this.agent(agentId, ownerId);
    return this.agents.sessions.send({ agentId, ownerId, text });
  }

  /** As the conversation's interrupt (FR-16): `not_active` with a text still sends the text. */
  async interrupt(agentId: string, ownerId: string, text?: string): Promise<InterruptResponse> {
    await this.agent(agentId, ownerId);
    const outcome = await this.agents.sessions.interrupt({
      agentId,
      ownerId,
      ...(text === undefined ? {} : { text }),
    });
    if (outcome === 'interrupted' || text === undefined) return { outcome };
    const { messageId } = await this.agents.sessions.send({ agentId, ownerId, text });
    return { outcome: 'not_active', messageId };
  }

  async stop(agentId: string, ownerId: string): Promise<StopResponse> {
    await this.agent(agentId, ownerId);
    return { stopped: await this.agents.sessions.stop({ agentId, ownerId }) };
  }

  /** A new agent with the same task; `NOT_FINISHED` and `PARENT_FINISHED` come from the packages. */
  async restart(agentId: string, ownerId: string): Promise<RestartResponse> {
    await this.agent(agentId, ownerId);
    return this.agents.sessions.restart({ agentId, ownerId });
  }

  /** Flow 4: a decision on a request of any agent of the owner. */
  async decide(
    decisionId: string,
    ownerId: string,
    decision: DecisionRequest,
  ): Promise<DecisionResponse> {
    if (!isUuid(decisionId)) throw httpError('DECISION_NOT_FOUND');
    const outcome = await this.agents.sessions.resolveConfirmation({
      decisionId,
      ownerId,
      approve: decision.approve,
      ...(decision.args === undefined ? {} : { args: decision.args }),
    });
    return { outcome };
  }

  /** The owner's spend in the current UTC month (AC-29.1). */
  async spend(ownerId: string): Promise<SpendResponse> {
    const month = utcMonth(new Date());
    const { costUsd } = await this.runtime.ledger.monthSpend(ownerId, month);
    return { month, costUsd };
  }

  /**
   * The common step of every agent operation (DC-3): the owner's agent that is not a conversation's
   * root; a malformed, missing, foreign or root id is `AGENT_NOT_FOUND`.
   */
  private async agent(agentId: string, ownerId: string): Promise<AgentsAgentView> {
    if (!isUuid(agentId)) throw agentNotFound();
    const view = await this.agents.sessions.get(agentId, ownerId);
    if (view.parentId === null) throw agentNotFound();
    return view;
  }

  /** The top agents of one conversation with their subtrees; none when its tree was deleted meanwhile. */
  private async topAgentsOf(
    row: Conversation,
    ownerId: string,
    templates: TemplateTitles,
  ): Promise<ListedAgent[]> {
    if (row.rootId === null) return [];
    const views = await unlessDeleted(this.agents.sessions.list(row.rootId, ownerId));
    const threadTitle = toThreadSummary(row).title;
    return toAgentTree(
      views.map((view) => toAgentView(view, templates)),
      row.rootId,
    ).map((node) => ({
      updatedAt: new Date(node.createdAt),
      id: node.agentId,
      node: { ...node, threadId: row.id, threadTitle },
    }));
  }

  /** One read of the template catalog per answer: it decides `template` and `templateTitle`. */
  private templateTitles(): TemplateTitles {
    return templateTitles(this.workflows.templates.list());
  }
}

/**
 * A tree read of a conversation that was deleted between listing the conversations and reading its
 * tree (Flow 6): the conversation is gone, so it contributes nothing to the owner's lists.
 */
async function unlessDeleted<T>(read: Promise<T[]>): Promise<T[]> {
  try {
    return await read;
  } catch (error) {
    if (error instanceof AgentsError && error.code === 'AGENT_NOT_FOUND') return [];
    throw error;
  }
}
