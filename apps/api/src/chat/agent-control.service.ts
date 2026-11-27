import { Inject, Injectable } from '@nestjs/common';
import {
  AgentsError,
  ViewOperations,
  ControlOperations,
  StartOperations,
  type AgentView as AgentsAgentView,
  type RootSession,
} from '@agent-os/agents';
import {
  HISTORY_PAGE_SIZE,
  type AgentListNode,
  type AgentListPage,
  type AgentPageView,
  type AwaitingCount,
  type DecisionRequest,
  type DecisionResponse,
  type DeepAgentRunView,
  type HistoryEntry,
  type InheritedHistory,
  type InterruptResponse,
  type RestartResponse,
  type AgentTasksView,
  type SpendResponse,
  type StopResponse,
} from '@agent-os/contracts';
import { AgentsRepository, TrainingsRepository } from '@agent-os/db';
import { Inbox, monthOf, TokenLedger } from '@agent-os/runtime';
import { isUuid } from '../common/is-uuid';
import { httpError } from './chat.errors';
import { AGENT_LIST_PAGE_SIZE } from './chat.tokens';
import {
  nextAfterSeqOf,
  toAgentTree,
  toAgentView,
  toConfirmation,
  toHistoryEntry,
  toDeepAgentRunView,
  toPending,
  trainingOf,
} from './conversation-view';
import { decodeRowCursor, toThreadSummary } from './thread-summary';
import { selectThreadPage, sortThreadsForList } from './thread-cursor';

const agentNotFound = () => httpError('AGENT_NOT_FOUND');

/** A top agent of the list with the position the list order and its cursor read. */
type ListedAgent = {
  readonly updatedAt: Date;
  readonly id: string;
  readonly node: AgentListNode;
};

/**
 * The agent routes, decisions and spend (design-chat.md, Contract «Агенты», «Решения и расход», KD-7,
 * DC-3). Every agent operation starts with `ViewOperations.get` (the owner check of the package) and
 * refuses a conversation's root: for the web the root is not an agent. A malformed, missing or foreign
 * id answers as a missing one. Agents and the conversations — their root sessions — are reached only
 * through `agents` and `runtime`.
 */
@Injectable()
export class AgentControlService {
  constructor(
    @Inject(ViewOperations) private readonly views: ViewOperations,
    @Inject(ControlOperations) private readonly control: ControlOperations,
    @Inject(StartOperations) private readonly starts: StartOperations,
    @Inject(Inbox) private readonly inbox: Inbox,
    @Inject(TokenLedger) private readonly ledger: TokenLedger,
    @Inject(AGENT_LIST_PAGE_SIZE) private readonly pageSize: number,
    @Inject(TrainingsRepository)
    private readonly trainings: TrainingsRepository,
    @Inject(AgentsRepository)
    private readonly agents: AgentsRepository,
  ) {}

  /**
   * KD-7: the top agents (children of roots) of all the owner's conversations, newest first
   * (`createdAt` DESC, then `agentId` DESC), with their subtrees and conversation.
   */
  async page(ownerId: string, cursor?: string): Promise<AgentListPage> {
    const position = cursor === undefined ? undefined : decodeRowCursor(cursor);
    const roots = await this.views.roots({ ownerId });
    const perConversation = await Promise.all(
      roots.map(async (root) => this.topAgentsOf(root, ownerId)),
    );
    const page = selectThreadPage({
      sorted: sortThreadsForList(perConversation.flat()),
      ...(position === undefined ? {} : { cursor: position }),
      size: this.pageSize,
    });
    return {
      agents: page.threads.map((listed) => listed.node),
      nextCursor: page.nextCursor,
    };
  }

  /** NV-01: open decision requests across all the owner's conversations. */
  async awaiting(ownerId: string): Promise<AwaitingCount> {
    const roots = await this.views.roots({ ownerId });
    const counts = await Promise.all(
      roots.map(async ({ rootId }) => {
        const confirmations = await unlessDeleted(
          this.views.confirmations(rootId, ownerId),
        );
        return confirmations.filter(
          (confirmation) => confirmation.status === 'open',
        ).length;
      }),
    );
    return { count: counts.reduce((sum, count) => sum + count, 0) };
  }

  /** `AgentPageView`: the agent with its conversation, a page of its history, its queue, own requests and subtree. */
  async history(
    agentId: string,
    ownerId: string,
    afterSeq: number,
  ): Promise<AgentPageView> {
    const view = await this.agent(agentId, ownerId);
    const conversation = await this.views.root(view.rootId, ownerId);
    if (conversation === undefined) throw agentNotFound();
    const [views, entries, messages, confirmations, training] =
      await Promise.all([
        this.views.list(view.rootId, ownerId),
        this.views.history({
          agentId,
          ownerId,
          afterSeq,
          limit: HISTORY_PAGE_SIZE,
        }),
        this.inbox.listPending(agentId, ownerId),
        this.views.confirmations(view.rootId, ownerId),
        this.trainings.find(view.rootId),
      ]);
    // design v1.2 (A-2): the parent's description, unless the parent is the conversation's root.
    const parent = views.find(
      (candidate) => candidate.agentId === view.parentId,
    );
    const parentDescription =
      parent === undefined || parent.parentId === null
        ? undefined
        : parent.description;
    return {
      agent: {
        ...toAgentView(view),
        threadId: conversation.rootId,
        threadTitle: toThreadSummary(conversation).title,
        ...(parentDescription === undefined ? {} : { parentDescription }),
      },
      entries: entries.map(toHistoryEntry),
      nextAfterSeq: nextAfterSeqOf(entries),
      pending: toPending(messages, views, confirmations),
      decisions: confirmations
        .filter((confirmation) => confirmation.agentId === agentId)
        .map((confirmation) => toConfirmation(confirmation, views)),
      children: toAgentTree(views, agentId),
      training: trainingOf(
        training,
        agentId,
        training?.agentId != null &&
          (await this.agents.exists(training.agentId)),
        null,
      ),
    };
  }

  /** AV-05: the fork parent's entries through `throughSeq`; empty for an agent that is not a fork. */
  async inherited(
    agentId: string,
    ownerId: string,
    afterSeq: number,
  ): Promise<InheritedHistory> {
    const { forkedFrom } = await this.agent(agentId, ownerId);
    if (forkedFrom === null) return { entries: [], nextAfterSeq: null };
    const page = await this.views.history({
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
    const more =
      nextAfterSeqOf(page) !== null &&
      last !== undefined &&
      last.seq < forkedFrom.throughSeq;
    return { entries, nextAfterSeq: more ? last.seq : null };
  }

  /** A deep agent's run (`DeepAgentRunView`); any other agent is `RUN_NOT_FOUND` (from `agents`). */
  async run(agentId: string, ownerId: string): Promise<DeepAgentRunView> {
    await this.agent(agentId, ownerId);
    return toDeepAgentRunView(await this.views.run(agentId, ownerId));
  }

  /**
   * The task list of any of the owner's sessions, the conversation's root included, in number order; a
   * session without one has an empty list (deep-agents KD-5), and the subagents of its `task` calls (design-task.md,
   * «Запись и маршрут»). A malformed, missing or foreign id is `AGENT_NOT_FOUND`.
   */
  async tasks(agentId: string, ownerId: string): Promise<AgentTasksView> {
    if (!isUuid(agentId)) throw agentNotFound();
    return this.views.taskList(agentId, ownerId);
  }

  /** A message to the agent; to a finished agent it continues with its history. */
  async send(
    agentId: string,
    ownerId: string,
    text: string,
  ): Promise<{ messageId: string }> {
    await this.agent(agentId, ownerId);
    return this.control.send({ agentId, ownerId, text });
  }

  /** As the conversation's interrupt (FR-16). */
  async interrupt(
    agentId: string,
    ownerId: string,
  ): Promise<InterruptResponse> {
    await this.agent(agentId, ownerId);
    return { outcome: await this.control.interrupt({ agentId, ownerId }) };
  }

  /** Also a training's root (the trainer): «Стоп» of a training conversation stops it. */
  async stop(agentId: string, ownerId: string): Promise<StopResponse> {
    if (!isUuid(agentId)) throw agentNotFound();
    const view = await this.views.get(agentId, ownerId);
    if (
      view.parentId === null &&
      (await this.trainings.find(agentId)) === undefined
    )
      throw agentNotFound();
    return { stopped: await this.control.stop({ agentId, ownerId }) };
  }

  /**
   * A new agent with the same task; `NOT_FINISHED`, `PARENT_FINISHED` and `START_REFUSED` (409 with the
   * reason and the model) come from the packages.
   */
  async restart(agentId: string, ownerId: string): Promise<RestartResponse> {
    await this.agent(agentId, ownerId);
    return this.starts.restart({ agentId, ownerId });
  }

  /**
   * Flow 4: a decision on a request of any agent of the owner; edited arguments (a brief's too) pass unchanged.
   * «Allow in this conversation» on a card that is not a changing MCP tool's is 400, and the card stays open
   * (improvements design-server.md Flow 2).
   */
  async decide(
    decisionId: string,
    ownerId: string,
    decision: DecisionRequest,
  ): Promise<DecisionResponse> {
    if (!isUuid(decisionId)) throw httpError('DECISION_NOT_FOUND');
    const outcome = await this.control.resolveConfirmation({
      decisionId,
      ownerId,
      approve: decision.approve,
      ...(decision.args === undefined ? {} : { args: decision.args }),
      ...(decision.allowInConversation === true
        ? { allowInConversation: true }
        : {}),
    });
    if (outcome === 'not_mcp_card') throw httpError('VALIDATION_FAILED');
    return { outcome };
  }

  /** The owner's spend in the current UTC month (AC-29.1). */
  async spend(ownerId: string): Promise<SpendResponse> {
    const month = monthOf(new Date());
    const { costUsd } = await this.ledger.monthSpend(ownerId, month);
    return { month, costUsd };
  }

  /**
   * The common step of every agent operation (DC-3): the owner's agent that is not a conversation's
   * root; a malformed, missing, foreign or root id is `AGENT_NOT_FOUND`.
   */
  private async agent(
    agentId: string,
    ownerId: string,
  ): Promise<AgentsAgentView> {
    if (!isUuid(agentId)) throw agentNotFound();
    const view = await this.views.get(agentId, ownerId);
    if (view.parentId === null) throw agentNotFound();
    return view;
  }

  /** The top agents of one conversation with their subtrees; none when its tree was deleted meanwhile. */
  private async topAgentsOf(
    root: RootSession,
    ownerId: string,
  ): Promise<ListedAgent[]> {
    const views = await unlessDeleted(this.views.list(root.rootId, ownerId));
    const threadTitle = toThreadSummary(root).title;
    return toAgentTree(views, root.rootId).map((node) => ({
      updatedAt: new Date(node.createdAt),
      id: node.agentId,
      node: { ...node, threadId: root.rootId, threadTitle },
    }));
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
    if (error instanceof AgentsError && error.code === 'AGENT_NOT_FOUND')
      return [];
    throw error;
  }
}
