import type { Logger } from '@agent-os/common';
import type { StepContext, StepMessage } from '@agent-os/runtime';

import {
  CHAT_LISTING_BUDGET,
  type ChatListing,
  chatListing,
} from '../chat-listing';
import type { ToolDeclaration } from '../tools/tool';
import type { AgentDeps } from './agent-deps';
import type { AgentRun } from './agent-state';
import { BaseAgent } from './base-agent';
import { chatTurns } from './deliver';
import type { TurnEnd } from './model-step';
import { agentOwner } from './agent-owner';

/** What the chat works with: an agent's, and the logger of its listing. */
export interface ChatAgentDeps extends AgentDeps {
  /** Logs the chat listing of each model call. */
  readonly logger: Logger;
}

/**
 * The chat: the root of a conversation, the agent the employee talks to (design-agents.md KD-2, KD-6). Its task
 * is created only by `sessions.start` and the restart of a root, with the `chat` task type. Over the shared step it differs in this:
 * it declares itself a root — so it gets the root's tools and always keeps a task list — and lists the employee's
 * records as they are now in the descriptions of its tools, starts a new turn with every message of the
 * employee, never ends by itself — it waits for the next message.
 */
export class ChatAgent extends BaseAgent {
  constructor(
    private readonly chatDeps: ChatAgentDeps,
    run: AgentRun,
  ) {
    super(chatDeps, run);
  }

  protected override get root(): boolean {
    return true;
  }

  /**
   * The model call's declaration lists whom the chat may start as the employee's library is now: the agents
   * for `start_agent`, the deep agents for `start_deep_agent`. The check of its calls needs no listing.
   */
  override async offeredDeclaration(
    ctx: StepContext,
  ): Promise<ToolDeclaration> {
    const listing = await this.listing(ctx);
    return {
      ...this.declaration,
      startable: listing.agents,
      deepAgents: listing.deepAgents,
    };
  }

  /** The chat listing of the root's owner (KD-4): his `listVisible` and his session counts, read now. */
  private async listing(ctx: StepContext): Promise<ChatListing> {
    const { library, sessionRows } = this.chatDeps;
    const startedAt = Date.now();
    const headers = await library.listVisible(agentOwner(ctx));
    const counts = await sessionRows.recordCounts(agentOwner(ctx));
    const sessionCounts = new Map(
      counts.map((row) => [row.recordId, row.sessions]),
    );
    const listing = chatListing({
      headers,
      sessionCounts,
      budget: CHAT_LISTING_BUDGET,
    });
    this.chatDeps.logger
      .child({ service: 'agents.tools' })
      .info('chat listing built', {
        ownerId: ctx.ownerId,
        agentId: ctx.taskId,
        visible: headers.length,
        described: listing.described,
        length: [...listing.agents, ...listing.deepAgents].reduce(
          (sum, line) => sum + line.length,
          0,
        ),
        durationMs: Date.now() - startedAt,
      });
    return listing;
  }

  /** Every message of the employee starts a new turn (DC-1). */
  override turnsAfterDelivery(
    turns: number,
    messages: readonly StepMessage[],
  ): number {
    return chatTurns(turns, messages);
  }

  /** An answer without tool calls is the chat's reply: it waits for the next message, whatever its children do. */
  override async endOfTurn(): Promise<TurnEnd> {
    return {
      ending: { kind: 'wait' },
      inFlight: { unfinished: 0, pending: 0 },
    };
  }
}
