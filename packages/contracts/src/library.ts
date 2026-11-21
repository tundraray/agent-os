import { z } from 'zod';
import { ModelIdSchema } from './access';
import { McpServerNameSchema } from './mcp';

/**
 * Library of agents and workflows (design-library.md, Contract Definitions). Lengths and shapes
 * answered 400 live here; rules that carry a `reason` (all servers outside a system record, a role
 * the owner is not in, a holder that does not exist) are the service's, because the pipe's 400 has
 * no `reason`.
 */

export const RECORD_NAME_MAX_LENGTH = 80;
export const RECORD_DESCRIPTION_MAX_LENGTH = 300;
export const RECORD_PROMPT_MAX_LENGTH = 20_000;
export const COORDINATOR_RULES_MAX_LENGTH = 4_000;
export const EXECUTOR_NAME_MAX_LENGTH = 80;
export const EXECUTOR_ROLE_MAX_LENGTH = 300;
export const WORKFLOW_EXECUTORS_MIN = 1;
export const WORKFLOW_EXECUTORS_MAX = 10;
export const EXECUTOR_MAX_RUNS_MIN = 1;
export const EXECUTOR_MAX_RUNS_MAX = 20;
export const RECORD_MAX_TURNS_MIN = 1;
export const RECORD_MAX_TURNS_MAX = 200;
/** «Максимум шагов» of a new record until an administrator sets another (`library_settings`). */
export const RECORD_MAX_TURNS_DEFAULT = 40;

/** Built-in key of the main-chat record: every enabled employee sees it, its audience is fixed. */
export const CHAT_BUILTIN_KEY = 'chat';
/** "All servers" in a record's server list; only a system record may hold it. */
export const ALL_SERVERS = '*';

/** Error codes of the library (`errorCode` of ApiErrorSchema); a body that fails a schema is VALIDATION_FAILED. */
export const LibraryErrorCode = {
  RECORD_NOT_FOUND: 'RECORD_NOT_FOUND',
  RECORD_READ_ONLY: 'RECORD_READ_ONLY',
  RECORD_VERSION_CONFLICT: 'RECORD_VERSION_CONFLICT',
  RECORD_NAME_TAKEN: 'RECORD_NAME_TAKEN',
  RECORD_REJECTED: 'RECORD_REJECTED',
  /** 403: the workflow is visible, but its knowledge graph is not open to the employee. */
  KNOWLEDGE_FORBIDDEN: 'KNOWLEDGE_FORBIDDEN',
} as const;
export type LibraryErrorCode = (typeof LibraryErrorCode)[keyof typeof LibraryErrorCode];

/** `reason` of a 422 RECORD_REJECTED. */
export const LibraryRejectReasonSchema = z.enum([
  'server_not_allowed',
  'all_servers_not_allowed',
  'model_not_allowed',
  'agent_not_visible',
  'role_not_member',
  'sharing_banned',
  'holder_not_found',
  'audience_fixed',
  'builtin',
]);
export type LibraryRejectReason = z.infer<typeof LibraryRejectReasonSchema>;

/** `reason` of a 409 RECORD_NAME_TAKEN: the owner's own name, or the name of a system record. */
export const RecordNameTakenReasonSchema = z.enum(['own', 'system']);
export type RecordNameTakenReason = z.infer<typeof RecordNameTakenReasonSchema>;

/**
 * Why `saveOwn` refused a save from the chat (design-library.md, «Для части `runtime`»): its own
 * reasons and every reason of a 422 RECORD_REJECTED. `shared` — the record has holders (AC-18.5).
 */
export const SaveOwnRefusalSchema = z.enum([
  'not_found',
  'read_only',
  'shared',
  'version_conflict',
  'name_taken',
  'system_name',
  'invalid',
  ...LibraryRejectReasonSchema.options,
]);
export type SaveOwnRefusal = z.infer<typeof SaveOwnRefusalSchema>;

export const RecordKindSchema = z.enum(['agent', 'workflow']);
export type RecordKind = z.infer<typeof RecordKindSchema>;

/** Platform tools a record may hold. `run_code` and `start_workflow` are never stored in a record. */
export const RecordToolSchema = z.enum(['start_agent', 'message_agent', 'list_agents', 'stop_agent']);
export type RecordTool = z.infer<typeof RecordToolSchema>;

/** The id of a record, role or user. */
export const IdSchema = z.uuid();
const IsoDateSchema = z.iso.datetime();
/** The version of a record. */
export const VersionSchema = z.number().int().positive();

/**
 * A name stays on one line: no line break or other control character, so a name can never add a line
 * of its own to a tool description (custom-agents design-runtime.md, Security Considerations).
 */
function nameSchema(maxLength: number) {
  return z
    .string()
    .trim()
    .min(1)
    .max(maxLength)
    .regex(/^\P{Cc}*$/u, { message: 'control characters' });
}

function hasNoRepeats(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function listWithoutRepeats<T extends z.ZodType<string>>(item: T) {
  return z.array(item).refine(hasNoRepeats, { message: 'values repeat' });
}

// ---------- Content ----------

const PromptSchema = z.string().min(1).max(RECORD_PROMPT_MAX_LENGTH);
const MaxTurnsSchema = z.number().int().min(RECORD_MAX_TURNS_MIN).max(RECORD_MAX_TURNS_MAX);
const ServersSchema = listWithoutRepeats(z.union([McpServerNameSchema, z.literal(ALL_SERVERS)]));
const ToolsSchema = listWithoutRepeats(RecordToolSchema);
/** `null` — the default chat model at the start of a run. */
const RecordModelSchema = ModelIdSchema.nullable();

export const AgentContentSchema = z.object({
  prompt: PromptSchema,
  servers: ServersSchema,
  model: RecordModelSchema,
  maxTurns: MaxTurnsSchema,
  /** Agent records this agent may start. */
  agents: listWithoutRepeats(IdSchema),
  tools: ToolsSchema,
});
export type AgentContent = z.infer<typeof AgentContentSchema>;

/** The agent record an executor was taken from, at the version taken. */
const ExecutorSourceSchema = z.object({ recordId: IdSchema, version: VersionSchema });

const ExecutorSchema = z.object({
  name: nameSchema(EXECUTOR_NAME_MAX_LENGTH),
  /** What the executor answers for and when to call it. */
  role: z.string().trim().min(1).max(EXECUTOR_ROLE_MAX_LENGTH),
  prompt: PromptSchema,
  servers: ServersSchema,
  model: RecordModelSchema,
  maxTurns: MaxTurnsSchema,
  maxRuns: z.number().int().min(EXECUTOR_MAX_RUNS_MIN).max(EXECUTOR_MAX_RUNS_MAX),
  tools: ToolsSchema,
  source: ExecutorSourceSchema.nullable(),
});
export type WorkflowExecutor = z.infer<typeof ExecutorSchema>;

export const WorkflowContentSchema = z
  .object({
    coordinator: z.object({
      /** Rules in words; may be empty. */
      rules: z.string().max(COORDINATOR_RULES_MAX_LENGTH),
      model: RecordModelSchema,
      maxTurns: MaxTurnsSchema,
    }),
    executors: z.array(ExecutorSchema).min(WORKFLOW_EXECUTORS_MIN).max(WORKFLOW_EXECUTORS_MAX),
    /** Executor whose report becomes the answer; `null` — the coordinator writes it. */
    finalExecutor: z.string().nullable(),
    /** Runs learn into the workflow's knowledge graph; content saved before the field reads `false`. */
    selfLearning: z.boolean().default(false),
  })
  .superRefine((content, ctx) => {
    const names = content.executors.map((executor) => executor.name);
    if (!hasNoRepeats(names.map((name) => name.toLowerCase()))) {
      ctx.addIssue({ code: 'custom', path: ['executors'], message: 'executor names repeat' });
    }
    const sources = content.executors.flatMap((executor) =>
      executor.source ? [executor.source.recordId] : [],
    );
    if (!hasNoRepeats(sources)) {
      ctx.addIssue({ code: 'custom', path: ['executors'], message: 'executor sources repeat' });
    }
    if (content.finalExecutor !== null && !names.includes(content.finalExecutor)) {
      ctx.addIssue({ code: 'custom', path: ['finalExecutor'], message: 'no such executor' });
    }
  });
export type WorkflowContent = z.infer<typeof WorkflowContentSchema>;

/** `kind` and the content of that kind, joined to the given fields. */
export function withContentByKind<T extends z.ZodRawShape>(fields: T) {
  return z.discriminatedUnion('kind', [
    z.object({
      ...fields,
      kind: z.literal(RecordKindSchema.enum.agent),
      content: AgentContentSchema,
    }),
    z.object({
      ...fields,
      kind: z.literal(RecordKindSchema.enum.workflow),
      content: WorkflowContentSchema,
    }),
  ]);
}

/** A record's kind and the content of that kind, as the bodies and the stored rows hold it. */
export type RecordBody =
  | { readonly kind: 'agent'; readonly content: AgentContent }
  | { readonly kind: 'workflow'; readonly content: WorkflowContent };

// ---------- Bodies ----------

const recordTextFields = {
  name: nameSchema(RECORD_NAME_MAX_LENGTH),
  /** May hold line breaks: a tool description collapses them when it builds the record's line. */
  description: z.string().trim().min(1).max(RECORD_DESCRIPTION_MAX_LENGTH),
};

/** Body of POST /api/library and POST /api/admin/library. */
export const CreateRecordBodySchema = withContentByKind(recordTextFields);
export type CreateRecordBody = z.infer<typeof CreateRecordBodySchema>;

/**
 * Body of PUT /api/library/:id and PUT /api/admin/library/:id: `version` is the one the edit
 * started from. The kind never changes.
 */
export const UpdateRecordBodySchema = withContentByKind({ ...recordTextFields, version: VersionSchema });
export type UpdateRecordBody = z.infer<typeof UpdateRecordBodySchema>;

/** Body of PUT /api/library/:id/audience: roles of the owner; no roles — a personal record. */
export const RecordAudienceBodySchema = z.object({
  roleIds: listWithoutRepeats(IdSchema),
  offerInChat: z.boolean(),
});
export type RecordAudienceBody = z.infer<typeof RecordAudienceBodySchema>;

/** Body of PUT /api/admin/library/:id/audience; no holder — only admins see the record. */
export const SystemRecordAudienceBodySchema = z.object({
  everyone: z.boolean(),
  roleIds: listWithoutRepeats(IdSchema),
  userIds: listWithoutRepeats(IdSchema),
  offerInChat: z.boolean(),
});
export type SystemRecordAudienceBody = z.infer<typeof SystemRecordAudienceBodySchema>;

// ---------- Responses ----------

/** Owner of an employee record; `disabled` — the account is disabled. */
const RecordAuthorSchema = z.object({ id: IdSchema, name: z.string(), disabled: z.boolean() });
export type RecordAuthor = z.infer<typeof RecordAuthorSchema>;

/**
 * Audience as the viewer may see it: the owner, and an admin on a system record, see it whole;
 * anyone else gets only the roles they are in, without `everyone` and `users`.
 */
const RecordAudienceSchema = z.object({
  everyone: z.boolean().optional(),
  roles: z.array(z.object({ id: IdSchema, name: z.string(), member: z.boolean() })),
  users: z.array(z.object({ id: IdSchema, name: z.string() })).optional(),
});
export type RecordAudience = z.infer<typeof RecordAudienceSchema>;

/** What the viewer lacks to run the record; `executor` `null` — the agent itself or the coordinator. */
const MissingRightSchema = z.object({
  executor: z.string().nullable(),
  servers: z.array(McpServerNameSchema),
  model: ModelIdSchema.nullable(),
});
export type MissingRight = z.infer<typeof MissingRightSchema>;

/** Fields of a summary row except `kind`, which the detail narrows with its content. */
const recordViewFields = {
  id: IdSchema,
  name: z.string(),
  description: z.string(),
  version: VersionSchema,
  updatedAt: IsoDateSchema,
  offerInChat: z.boolean(),
  builtinKey: z.string().nullable(),
  /** The viewer is the owner. */
  mine: z.boolean(),
  /** `null` — a system record. */
  author: RecordAuthorSchema.nullable(),
  audience: RecordAudienceSchema,
  /** Only on the viewer's own record under a sharing ban. */
  ban: z.object({ closedAt: IsoDateSchema }).nullable(),
  /** Empty — the viewer has every right the record needs. */
  missingRights: z.array(MissingRightSchema),
  canEdit: z.boolean(),
  canShare: z.boolean(),
  canDelete: z.boolean(),
};

/** Row of GET /api/library and of the panel lists `system` and `shared`. */
export const RecordSummarySchema = z.object({ ...recordViewFields, kind: RecordKindSchema });
export type RecordSummary = z.infer<typeof RecordSummarySchema>;

/** State of an executor's source agent for the viewer. */
const ExecutorSourceStateSchema = z.object({
  executor: z.string(),
  recordId: IdSchema,
  version: VersionSchema,
  state: z.enum(['current', 'changed', 'gone']),
  /** The newer version when `changed`, otherwise `null`. */
  latestVersion: VersionSchema.nullable(),
});
export type ExecutorSourceState = z.infer<typeof ExecutorSourceStateSchema>;

/** Response of GET /api/library/:id and of every write that returns the record. */
export const RecordDetailSchema = withContentByKind({
  ...recordViewFields,
  /** Only workflows have executors; an agent's list is empty. */
  executorSources: z.array(ExecutorSourceStateSchema),
});
export type RecordDetail = z.infer<typeof RecordDetailSchema>;

/** Response of POST /api/library/:id/copy. */
export const CopyResultSchema = z.object({
  record: RecordDetailSchema,
  removedServers: z.array(
    z.object({ executor: z.string().nullable(), servers: z.array(McpServerNameSchema) }),
  ),
  replacedModels: z.array(
    z.object({ executor: z.string().nullable(), from: ModelIdSchema, to: ModelIdSchema }),
  ),
  /** Agents the copy may not start: the copier does not see them. */
  removedAgents: z.array(IdSchema),
});
export type CopyResult = z.infer<typeof CopyResultSchema>;

/** Row of GET /api/admin/library/bans: no description and no content. */
export const BannedRecordSchema = z.object({
  id: IdSchema,
  kind: RecordKindSchema,
  name: z.string(),
  author: RecordAuthorSchema,
  closedAt: IsoDateSchema,
});
export type BannedRecord = z.infer<typeof BannedRecordSchema>;

/** Response of GET /api/library/choices. */
export const LibraryChoicesSchema = z.object({
  /** Servers the employee may use, by name. */
  servers: z.array(McpServerNameSchema),
  /** Model of a new record; `null` while no default chat model is chosen. */
  defaultModel: ModelIdSchema.nullable(),
  /** «Максимум шагов» of a new record, set by an administrator. */
  defaultMaxTurns: MaxTurnsSchema,
});
export type LibraryChoices = z.infer<typeof LibraryChoicesSchema>;

/** Body of PUT /api/admin/library/settings. */
export const UpdateLibrarySettingsBodySchema = z.object({ defaultMaxTurns: MaxTurnsSchema });
export type UpdateLibrarySettingsBody = z.infer<typeof UpdateLibrarySettingsBodySchema>;

/** Response of GET/PUT /api/admin/library/settings. `updatedAt: null` while the default stands. */
export const LibrarySettingsSchema = UpdateLibrarySettingsBodySchema.extend({
  updatedAt: IsoDateSchema.nullable(),
});
export type LibrarySettings = z.infer<typeof LibrarySettingsSchema>;

/** Response of GET /api/auth/me/roles: the viewer's roles by name. */
export const MyRoleListSchema = z.array(z.object({ id: IdSchema, name: z.string() }));
export type MyRoleList = z.infer<typeof MyRoleListSchema>;

// ---------- Port for the runtime part ----------

/** Row of `listVisible(viewerId)`; `shared` — the record has at least one holder. */
export type RecordHeader = {
  id: string;
  kind: RecordKind;
  name: string;
  description: string;
  version: number;
  builtinKey: string | null;
  author: RecordAuthor | null;
  mine: boolean;
  shared: boolean;
  offerInChat: boolean;
};

/** Answer of `resolve` and `resolveBuiltin`: the header and the content of its kind. */
export type ResolvedRecord = Omit<RecordHeader, 'kind'> & RecordBody;
