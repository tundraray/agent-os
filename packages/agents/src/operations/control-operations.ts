import type { Logger } from '@agent-os/common';
import {
  AgentMessageKindSchema,
  TaskStatusSchema,
  WaitReasonSchema,
} from '@agent-os/contracts';
import { AgentSessionsRepository, Db } from '@agent-os/db';
import {
  Decisions,
  Inbox,
  type ResolveOutcome,
  TaskControl,
} from '@agent-os/runtime';
import { Inject, Injectable } from '@nestjs/common';
import type { z } from 'zod';

import { AGENTS_LOGGER } from '../agents.tokens';
import { AgentsError } from '../errors';
import { messagePayload } from '../resume';
import { type RootSession, toRootSession } from '../store/sessions';
import { ToolRegistry } from '../tools/tool-registry';
import type {
  AgentRef,
  ResolveConfirmationRequest,
  SendRequest,
} from './agent-sessions';
import {
  agentTask,
  asAgent,
  ConfirmationPayloadSchema,
  createLogged,
  parentOf,
} from './operation-support';

const { waiting, stopped } = TaskStatusSchema.enum;
const { user_message: userMessage, interrupt } = AgentMessageKindSchema.enum;

/**
 * The operations that change a live agent or its conversation: a message, an interrupt, a stop, the decision
 * of a confirmation, and the root session's place, title and deletion.
 */
@Injectable()
export class ControlOperations {
  private readonly logger: Logger;
  private readonly logged: ReturnType<typeof createLogged>;

  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(AgentSessionsRepository)
    private readonly sessionRows: AgentSessionsRepository,
    @Inject(TaskControl)
    private readonly tasks: Pick<
      TaskControl,
      'get' | 'interrupt' | 'stop' | 'deleteTree'
    >,
    @Inject(Inbox) private readonly inbox: Pick<Inbox, 'enqueue'>,
    @Inject(Decisions)
    private readonly decisions: Pick<Decisions, 'get' | 'resolve'>,
    @Inject(ToolRegistry)
    private readonly registry: Pick<ToolRegistry, 'toolOf'>,
    @Inject(AGENTS_LOGGER) logger: Logger,
  ) {
    this.logger = logger.child({ service: 'agents.sessions' });
    this.logged = createLogged(this.logger);
  }

  send({
    agentId,
    ownerId,
    text,
    record,
  }: SendRequest): Promise<{ messageId: string }> {
    return this.logged(
      'send',
      { agentId, ownerId, recordId: record?.id ?? null },
      async () => {
        const target = await agentTask(this.tasks, agentId, ownerId);
        // Notes 5: a message to a stopped agent carries the `resume` mark; the window between this
        // read and the write is a known low risk.
        const parent =
          target.status === stopped
            ? await parentOf(this.tasks, target, ownerId)
            : null;
        const { messageId } = await asAgent(
          this.inbox.enqueue({
            recipientId: agentId,
            ownerId,
            kind: userMessage,
            sender: ownerId,
            payload: {
              ...messagePayload(text, target, parent),
              ...(record === undefined ? {} : { record }),
            },
            revive: true,
          }),
        );
        return { messageId };
      },
      ({ messageId }) => ({ messageId }),
    );
  }

  /** Marks the agent «прерван»: it closes its open calls and waits for a message (KD-3). */
  interrupt({
    agentId,
    ownerId,
  }: AgentRef): Promise<'interrupted' | 'not_active'> {
    return this.logged(
      'interrupt',
      { agentId, ownerId },
      async () => {
        const task = await agentTask(this.tasks, agentId, ownerId);
        // A free agent (waiting for messages) has no work to cut off: `not_active`, nothing changes (Flow 4).
        if (
          task.status === waiting &&
          task.waitReason === WaitReasonSchema.enum.messages
        )
          return 'not_active';
        // KD-3: the `interrupt` message makes the agent's next step close its calls and wait.
        return asAgent(
          this.tasks.interrupt(agentId, ownerId, {
            kind: interrupt,
            sender: ownerId,
            payload: {},
            revive: false,
          }),
        );
      },
      (outcome) => ({ outcome }),
    );
  }

  stop({ agentId, ownerId }: AgentRef): Promise<string[]> {
    return this.logged(
      'stop',
      { agentId, ownerId },
      async () => {
        await agentTask(this.tasks, agentId, ownerId);
        // Flow 7: `tasks.stop` and nothing else; `history` shows the stop records.
        return asAgent(this.tasks.stop(agentId, ownerId));
      },
      (stoppedIds) => ({ stoppedIds }),
    );
  }

  resolveConfirmation({
    decisionId,
    ownerId,
    approve,
    args,
  }: ResolveConfirmationRequest): Promise<ResolveOutcome> {
    return this.logged(
      'resolveConfirmation',
      { decisionId, ownerId, approve, withArgs: args !== undefined },
      async () => {
        // The edit is checked only against an open request of this owner. For any other one
        // `decisions.resolve` answers `already_resolved` (resolved or cancelled) or
        // `DECISION_NOT_FOUND` (missing or another owner's) and writes nothing.
        const decision =
          args === undefined
            ? undefined
            : await this.decisions.get(decisionId, ownerId);
        const edited =
          decision?.status === 'open'
            ? {
                args: this.editedArgs(
                  ConfirmationPayloadSchema.parse(decision.payload),
                  args,
                ),
              }
            : {};
        // The tool step reads `{ approve, args? }` and the call id from the request's payload.
        return this.decisions.resolve(decisionId, ownerId, {
          approve,
          ...edited,
        });
      },
      (outcome) => ({ outcome }),
    );
  }

  /** Moves the owner's root session to the top of the list. */
  touchRoot(rootId: string, ownerId: string): Promise<void> {
    return this.logged('touchRoot', { rootId, ownerId }, () =>
      this.sessionRows.touchRoot(rootId, ownerId),
    );
  }

  /** Sets the title and moves the root session up; `undefined` as in `root`. */
  renameRoot(
    rootId: string,
    ownerId: string,
    title: string,
  ): Promise<RootSession | undefined> {
    return this.logged(
      'renameRoot',
      { rootId, ownerId },
      async () => {
        const row = await this.sessionRows.renameRoot(rootId, ownerId, title);
        return row === undefined ? undefined : toRootSession(row);
      },
      (renamed) => ({ found: renamed !== undefined }),
    );
  }

  /** Writes a generated title only into an empty one; `true` when it was written. */
  titleRootIfEmpty(
    rootId: string,
    ownerId: string,
    title: string,
  ): Promise<boolean> {
    return this.logged(
      'titleRootIfEmpty',
      { rootId, ownerId },
      () => this.sessionRows.titleRootIfEmpty(rootId, ownerId, title),
      (written) => ({ written }),
    );
  }

  /**
   * Stops the conversation's tree and marks it and its root session deleted, in one transaction: from
   * then on the conversation answers as a missing one everywhere. The rows stay. `AGENT_NOT_FOUND` for
   * a missing, another owner's or an already deleted root.
   */
  deleteRoot(rootId: string, ownerId: string): Promise<void> {
    return this.logged('deleteRoot', { rootId, ownerId }, () =>
      asAgent(
        this.db.transaction(async () => {
          await this.tasks.deleteTree(rootId, ownerId);
          await this.sessionRows.markDeleted(rootId);
        }),
      ),
    );
  }

  /** The edited arguments parsed by the tool's schema; `INVALID_ARGUMENTS` unless the tool allows the edit. */
  private editedArgs(
    payload: z.infer<typeof ConfirmationPayloadSchema>,
    args: unknown,
  ): unknown {
    // An MCP tool never allows an edit; nor does any tool of this part.
    const tool =
      payload.server === null ? this.registry.toolOf(payload.tool) : undefined;
    if (tool?.confirmation?.editableArgs !== true) {
      throw new AgentsError(
        'INVALID_ARGUMENTS',
        `Tool ${payload.tool} does not allow editing its arguments`,
      );
    }
    const parsed = tool.argsSchema.safeParse(args);
    if (!parsed.success) {
      throw new AgentsError(
        'INVALID_ARGUMENTS',
        `Arguments of ${payload.tool} rejected by its schema`,
        {
          cause: parsed.error,
        },
      );
    }
    return parsed.data;
  }
}
