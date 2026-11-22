import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import {
  AgentsMcp,
  ToolRegistry,
  type InCommitAgentTool,
} from '@agent-os/agents';
import { LOGGER, type Logger } from '@agent-os/common';
import {
  AgentContentSchema,
  CREATE_RECORD_TOOL,
  CreateRecordBodySchema,
  DEEP_AGENT_SUBAGENTS_MAX,
  DeepAgentContentSchema,
  DELETE_RECORD_TOOL,
  EDIT_RECORD_TOOL,
  GENERAL_PURPOSE_SUBAGENT,
  LIBRARY_RECORD_CONFIRMATION,
  LibraryRecordCardSchema,
  LIST_RECORDS_TOOL,
  READ_RECORD_TOOL,
  RecordKindSchema,
  SUBAGENT_MAX_RUNS_MAX,
  type LibraryRecordAction,
  type RecordBody,
  type RecordKind,
  type ToolRefusalReason,
} from '@agent-os/contracts';
import { z } from 'zod';
import { IdentityDirectory } from '../identity/identity-directory';
import { LibraryChatService } from './library-chat.service';
import type { ChatChange, ChatContext, ChatRefusal } from './library.types';
import { recordListText, recordText } from './record-listing';

type ToolReview = Awaited<
  ReturnType<NonNullable<NonNullable<InCommitAgentTool<unknown>['confirmation']>['review']>>
>;

// ---------- Arguments ----------

const RecordIdSchema = z
  .string()
  .min(1)
  .describe('The id of the record, as list_records names it');

/** The deep agent's content without the self-learning flag: only a person changes it (Invariant 4). */
const { selfLearning: _selfLearning, ...deepAgentFields } =
  DeepAgentContentSchema.shape;

/**
 * The content a record tool takes: the content schema of the kind without `selfLearning` (KD-4). The
 * deep agent's own rules — repeated names, `finalSubagent` outside the team — stay the contract's: they
 * are asked of `DeepAgentContentSchema` itself, so the paths and the rules are the contract's.
 */
const DeepAgentToolContentSchema = z
  .object(deepAgentFields)
  .superRefine((content, ctx) => {
    const checked = DeepAgentContentSchema.safeParse(content);
    if (checked.success) return;
    for (const issue of checked.error.issues) {
      if (issue.code === 'custom')
        ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message });
    }
  });

function toolContentSchema(kind: RecordKind) {
  return kind === 'agent' ? AgentContentSchema : DeepAgentToolContentSchema;
}

const [agentBodySchema] = CreateRecordBodySchema.options;

const recordShape = {
  kind: RecordKindSchema.describe('agent or deep_agent; a record never changes its kind'),
  name: agentBodySchema.shape.name.describe('The record name, unique among your records'),
  description: agentBodySchema.shape.description.describe(
    'When to use the record, one or two sentences',
  ),
  content: z
    .record(z.string(), z.unknown())
    .describe(
      'The whole definition of the record in the form of its kind (see the tool description), without selfLearning',
    ),
};

/** `content` checked by the schema of `kind`; an error names its path under `content` and the rule. */
function withContentOfKind<T extends { kind: RecordKind; content: unknown }>(
  args: T,
  ctx: z.RefinementCtx,
): void {
  const checked = toolContentSchema(args.kind).safeParse(args.content);
  if (checked.success) return;
  for (const issue of checked.error.issues) {
    ctx.addIssue({
      code: 'custom',
      path: ['content', ...issue.path],
      message: issue.message,
    });
  }
}

const ListRecordsArgsSchema = z.object({});
const ReadRecordArgsSchema = z.object({ recordId: RecordIdSchema });
const DeleteRecordArgsSchema = z.object({ recordId: RecordIdSchema });
const CreateRecordArgsSchema = z
  .object({
    ...recordShape,
    system: z
      .boolean()
      .default(false)
      .describe('A system record of the admin panel; only an administrator may set it'),
  })
  .superRefine(withContentOfKind);
const EditRecordArgsSchema = z
  .object({ recordId: RecordIdSchema, ...recordShape })
  .superRefine(withContentOfKind);

type ListRecordsArgs = z.infer<typeof ListRecordsArgsSchema>;
type ReadRecordArgs = z.infer<typeof ReadRecordArgsSchema>;
type DeleteRecordArgs = z.infer<typeof DeleteRecordArgsSchema>;
type CreateRecordArgs = z.infer<typeof CreateRecordArgsSchema>;
type EditRecordArgs = z.infer<typeof EditRecordArgsSchema>;

/** The checked arguments as a record body; the flag is set by the library, never by the chat. */
function bodyOf(args: {
  kind: RecordKind;
  content: Record<string, unknown>;
}): RecordBody {
  if (args.kind === 'agent')
    return { kind: 'agent', content: AgentContentSchema.parse(args.content) };
  return {
    kind: 'deep_agent',
    content: DeepAgentContentSchema.parse(
      DeepAgentToolContentSchema.parse(args.content),
    ),
  };
}

// ---------- Descriptions ----------

const CONTENT_FORMS = [
  'content of an agent: { prompt, servers (MCP server names), model (a model id or null for the default chat',
  'model), maxTurns, agents (ids of agent records it may start), tools (any of start_agent, message_agent,',
  'list_agents, stop_agent), taskList (it keeps a task list; true unless given) }.',
  `content of a deep agent: { prompt, servers, model, maxTurns, subagents: 1 to ${DEEP_AGENT_SUBAGENTS_MAX} of { name,`,
  `description (when to call it), prompt, servers, model, maxTurns, maxRuns (1 to ${SUBAGENT_MAX_RUNS_MAX}), taskList`,
  `(false unless given); the name ${GENERAL_PURPOSE_SUBAGENT} is taken }, finalSubagent (the name of the subagent`,
  'whose answer is the answer, or null), taskList (true unless given), listDelegation (it may give one instruction',
  'with a list of items, one subagent per item; true unless given) }.',
  'Give the deep agent and each subagent only the servers it needs, from the servers list_records names.',
].join('\n');

const NOT_THE_CHATS =
  'The chat never shares a record and never turns self-learning on: only the employee does that, on the record’s card.';

const LIST_DESCRIPTION = [
  'List the library records you see — id, kind, name, whose it is, whether it is shared, description — and',
  'then the MCP servers you may use with the names of the tools you have the right to call.',
].join('\n');

const READ_DESCRIPTION =
  'Read the whole definition of a library record you see: kind, name, description, version, whose it is and its content.';

const CREATE_DESCRIPTION = [
  'Propose a new library record (an agent or a deep agent). The employee is shown a card with the whole',
  'definition; nothing is saved until the employee approves it. A refusal names the field and the rule: fix it',
  'and call again.',
  CONTENT_FORMS,
  NOT_THE_CHATS,
].join('\n');

const EDIT_DESCRIPTION = [
  'Propose a change of one of your own records that is shared with no one (an administrator: also a system',
  'record). Send the whole new definition, not only the changed part: what you leave out is removed. The',
  'employee approves the change on a card; nothing is saved before that.',
  CONTENT_FORMS,
  NOT_THE_CHATS,
].join('\n');

const DELETE_DESCRIPTION = [
  'Propose to delete one of your own records that is shared with no one (an administrator: also a system',
  'record; a built-in record is never deleted). The employee approves it on a card.',
].join('\n');

// ---------- Refusals ----------

/** One text for a missing record and for one the employee does not see: the chat learns nothing of it. */
const RECORD_UNAVAILABLE_TEXT =
  'recordId: there is no record with this id among the records you see';

/**
 * The reason and the text of a refused chat change (KD-4): the path of the field and the rule, and the
 * values that broke it — names of servers, models and agents, never a prompt or another record's content.
 */
function refusalOf(refusal: ChatRefusal): {
  reason: ToolRefusalReason;
  text: string;
} {
  const path = refusal.field?.path ?? '';
  const values = refusal.field?.values ?? [];
  switch (refusal.refusal) {
    case 'not_found':
      return { reason: 'record_unavailable', text: RECORD_UNAVAILABLE_TEXT };
    case 'read_only':
      return {
        reason: 'read_only',
        text: 'recordId: the record is another employee’s; the chat changes only your own records',
      };
    case 'shared':
      return {
        reason: 'shared',
        text: 'recordId: the record is shared; the chat changes only your records shared with no one',
      };
    case 'admin_only':
      return {
        reason: 'admin_only',
        text:
          path === 'system'
            ? 'system: only an administrator creates a system record'
            : 'recordId: a system record; only an administrator changes it',
      };
    case 'builtin':
      return { reason: 'builtin', text: 'recordId: a built-in record is never deleted' };
    case 'version_conflict':
      return {
        reason: 'version_conflict',
        text: 'recordId: the record changed after the card was shown; read it again and propose the change anew',
      };
    case 'invalid':
      return { reason: 'invalid_arguments', text: 'kind: a record never changes its kind' };
    case 'name_taken':
      return {
        reason: 'name_taken',
        text: `${path}: "${values.join(', ')}" is the name of another of your records`,
      };
    case 'system_name':
      return {
        reason: 'system_name',
        text: `${path}: "${values.join(', ')}" is the name of a system record`,
      };
    case 'server_not_allowed':
      return {
        reason: 'server_not_allowed',
        text: `${path}: ${values.join(', ')} — servers you may not use; servers you may use: ${namesOrNone(refusal.allowedServers ?? [])}`,
      };
    case 'all_servers_not_allowed':
      return {
        reason: 'all_servers_not_allowed',
        text: `${path}: "*" (all servers) is allowed only in a system record; name the servers`,
      };
    case 'model_not_allowed':
      return {
        reason: 'model_not_allowed',
        text: `${path}: ${values.join(', ')} — models you may not choose`,
      };
    case 'agent_not_visible':
      return {
        reason: 'agent_not_visible',
        text: `${path}: ${values.join(', ')} — agent records you do not see`,
      };
    case 'role_not_member':
    case 'sharing_banned':
    case 'holder_not_found':
    case 'audience_fixed':
      throw new Error(`a chat change was refused by the audience rule ${refusal.refusal}`);
  }
}

function namesOrNone(names: readonly string[]): string {
  return names.length === 0 ? 'none' : [...names].sort().join(', ');
}

// ---------- Tools ----------

export interface RecordToolsOptions {
  readonly library: Pick<
    LibraryChatService,
    | 'chatContext'
    | 'chatRecords'
    | 'chatRecord'
    | 'reviewChatChange'
    | 'saveChatChange'
  >;
  readonly identity: Pick<IdentityDirectory, 'isAdmin'>;
  readonly mcp: Pick<AgentsMcp, 'usable' | 'usableTools' | 'list'>;
  readonly logger: Logger;
}

/** What a mutating tool's `execute` takes: the action its card must carry. */
const CARD_ACTION: Record<string, LibraryRecordAction> = {
  [CREATE_RECORD_TOOL]: 'create',
  [EDIT_RECORD_TOOL]: 'edit',
  [DELETE_RECORD_TOOL]: 'delete',
};

/**
 * The five record tools of the main chat (deep-agents KD-3, Flow 1): built-in and `rootOnly`, so only the
 * root of a conversation gets them — a deep agent or a subagent gets `tool_not_in_definition` (AC-06.5).
 * Each is a thin adapter: rights and rules live in `LibraryChatService` and `decideSave`. `create_record`,
 * `edit_record` and `delete_record` wait for the employee's `library.record` card: `review` asks the
 * library before the card, and a refusal closes the call with its text and no card; `execute` saves the
 * approved card's content in the step's transaction, where the library checks it again.
 * The facts of a call — the admin right, the servers, the models — are read outside the
 * transaction (`review`, `prepare`). The log names the employee, the agent, the call, the action, the
 * record, the outcome and the reason; `loggedArgs` name only the record (Security Considerations).
 */
function createRecordTools(options: RecordToolsOptions) {
  const { library, identity, mcp } = options;
  const logger = options.logger.child({ service: 'library.record_tools' });

  async function contextOf(ownerId: string): Promise<ChatContext> {
    const isAdmin = await identity.isAdmin(ownerId);
    const [usableServers, registry] = await Promise.all([
      mcp.usable(ownerId),
      isAdmin ? mcp.list() : [],
    ]);
    return library.chatContext(
      { id: ownerId, isAdmin },
      { usableServers, registryServers: registry.map((server) => server.name) },
    );
  }

  function logOutcome(
    call: { readonly ownerId: string; readonly agentId: string; readonly callId: string | null },
    tool: string,
    recordId: string | null,
    result: { readonly outcome: string; readonly reason?: string },
  ): void {
    logger.info('record tool call', {
      ownerId: call.ownerId,
      agentId: call.agentId,
      callId: call.callId,
      tool,
      action: CARD_ACTION[tool] ?? (tool === READ_RECORD_TOOL ? 'read' : 'list'),
      recordId,
      outcome: result.outcome,
      reason: result.reason ?? null,
    });
  }

  function refused(refusal: ChatRefusal): {
    kind: 'refused';
    reason: ToolRefusalReason;
    text: string;
  } {
    return { kind: 'refused', ...refusalOf(refusal) };
  }

  /** The check before the card of a mutating call. */
  async function review(
    tool: string,
    change: ChatChange,
    caller: { readonly ownerId: string; readonly agentId: string },
  ): Promise<ToolReview> {
    const context = await contextOf(caller.ownerId);
    const reviewed = await library.reviewChatChange(context, change);
    const recordId =
      reviewed.outcome === 'card'
        ? reviewed.card.recordId
        : change.action === 'create'
          ? null
          : change.recordId;
    if (reviewed.outcome === 'refused') {
      const answer = refused(reviewed);
      logOutcome({ ...caller, callId: null }, tool, recordId, {
        outcome: 'refused_before_card',
        reason: answer.reason,
      });
      return answer;
    }
    logOutcome({ ...caller, callId: null }, tool, recordId, { outcome: 'card' });
    return { kind: 'card', content: reviewed.card };
  }

  /** The save of the approved card in the step's transaction. */
  function mutating<Args extends { readonly recordId?: string; readonly kind?: string; readonly name?: string }>(
    tool: string,
    description: string,
    argsSchema: z.ZodType<Args>,
    changeOf: (args: Args) => ChatChange,
  ): InCommitAgentTool<Args, ChatContext> {
    return {
      name: tool,
      description,
      argsSchema,
      mode: 'in_commit',
      rootOnly: true,
      // The record's content holds its prompt: only what names the record goes to the log.
      loggedArgs: ({ recordId, kind, name }) => ({ recordId, kind, name }),
      confirmation: {
        kind: LIBRARY_RECORD_CONFIRMATION,
        editableArgs: false,
        content() {
          throw new Error(`${tool} builds its card in review`);
        },
        review: (args, caller) => review(tool, changeOf(args), caller),
      },
      prepare: ({ caller }) => contextOf(caller.ownerId),
      async execute({ caller, callId, prepared, confirmed }) {
        if (prepared === undefined || confirmed === undefined)
          throw new Error(`${tool} of agent ${caller.agentId} runs without its approved card`);
        const card = LibraryRecordCardSchema.parse(confirmed);
        if (card.action !== CARD_ACTION[tool])
          throw new Error(`${tool} of agent ${caller.agentId} got a ${card.action} card`);
        const saved = await library.saveChatChange(prepared, card);
        const call = { ownerId: caller.ownerId, agentId: caller.agentId, callId };
        if (saved.outcome === 'refused') {
          const answer = refused(saved);
          logOutcome(call, tool, card.recordId, { outcome: 'refused', reason: answer.reason });
          return answer;
        }
        logOutcome(call, tool, saved.recordId, { outcome: 'saved' });
        return { kind: 'done', outcome: 'success', text: savedText(card.action, card.kind, saved) };
      },
    };
  }

  const listRecords: InCommitAgentTool<ListRecordsArgs, string> = {
    name: LIST_RECORDS_TOOL,
    description: LIST_DESCRIPTION,
    argsSchema: ListRecordsArgsSchema,
    mode: 'in_commit',
    rootOnly: true,
    async prepare({ caller }) {
      const context = await contextOf(caller.ownerId);
      const [records, servers] = await Promise.all([
        library.chatRecords(context),
        mcp.usableTools(caller.ownerId),
      ]);
      return recordListText(records, servers);
    },
    async execute({ caller, callId, prepared }) {
      if (prepared === undefined)
        throw new Error(`${LIST_RECORDS_TOOL} of agent ${caller.agentId} runs without its prepare`);
      logOutcome({ ...caller, callId }, LIST_RECORDS_TOOL, null, { outcome: 'success' });
      return { kind: 'done', outcome: 'success', text: prepared };
    },
  };

  const readRecord: InCommitAgentTool<ReadRecordArgs, string | null> = {
    name: READ_RECORD_TOOL,
    description: READ_DESCRIPTION,
    argsSchema: ReadRecordArgsSchema,
    mode: 'in_commit',
    rootOnly: true,
    async prepare({ args, caller }) {
      const record = await library.chatRecord(await contextOf(caller.ownerId), args.recordId);
      return record === null ? null : recordText(record);
    },
    async execute({ args, caller, callId, prepared }) {
      if (prepared === undefined)
        throw new Error(`${READ_RECORD_TOOL} of agent ${caller.agentId} runs without its prepare`);
      const call = { ...caller, callId };
      if (prepared === null) {
        logOutcome(call, READ_RECORD_TOOL, args.recordId, {
          outcome: 'refused',
          reason: 'record_unavailable',
        });
        return { kind: 'refused', reason: 'record_unavailable', text: RECORD_UNAVAILABLE_TEXT };
      }
      logOutcome(call, READ_RECORD_TOOL, args.recordId, { outcome: 'success' });
      return { kind: 'done', outcome: 'success', text: prepared };
    },
  };

  return [
    listRecords,
    readRecord,
    mutating<CreateRecordArgs>(CREATE_RECORD_TOOL, CREATE_DESCRIPTION, CreateRecordArgsSchema, (args) => ({
      action: 'create',
      system: args.system,
      record: { name: args.name, description: args.description, body: bodyOf(args) },
    })),
    mutating<EditRecordArgs>(EDIT_RECORD_TOOL, EDIT_DESCRIPTION, EditRecordArgsSchema, (args) => ({
      action: 'edit',
      recordId: args.recordId,
      record: { name: args.name, description: args.description, body: bodyOf(args) },
    })),
    mutating<DeleteRecordArgs>(DELETE_RECORD_TOOL, DELETE_DESCRIPTION, DeleteRecordArgsSchema, (args) => ({
      action: 'delete',
      recordId: args.recordId,
    })),
  ] as const;
}

/** What the model reads after an approved card was saved. */
function savedText(
  action: LibraryRecordAction,
  kind: RecordKind,
  saved: { readonly recordId: string; readonly version: number | null },
): string {
  switch (action) {
    case 'create':
      return `Saved: the new ${kind} record ${saved.recordId}, version ${saved.version}.`;
    case 'edit':
      return `Saved: record ${saved.recordId} is now in version ${saved.version}.`;
    case 'delete':
      return `Deleted: record ${saved.recordId}.`;
  }
}

/**
 * Registers the five record tools of the main chat (deep-agents KD-3) in the tools library of the agents, in
 * `onModuleInit`: the library closes in `onApplicationBootstrap`.
 */
@Injectable()
export class RecordToolsRegistration implements OnModuleInit {
  constructor(
    @Inject(ToolRegistry) private readonly registry: ToolRegistry,
    @Inject(AgentsMcp) private readonly mcp: AgentsMcp,
    private readonly library: LibraryChatService,
    private readonly identity: IdentityDirectory,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  onModuleInit(): void {
    const tools = createRecordTools({
      library: this.library,
      identity: this.identity,
      mcp: this.mcp,
      logger: this.logger,
    });
    for (const tool of tools) this.registry.register(tool);
  }
}
