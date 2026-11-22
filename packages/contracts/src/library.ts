import { z } from 'zod';
import { ModelIdSchema } from './access';
import { LanguageSchema, type Language } from './identity';
import { McpServerNameSchema } from './mcp';

/**
 * Library of agents and deep agents (design-library.md, deep-agents design-agent-types.md, Contract Definitions). Lengths and shapes
 * answered 400 live here; rules that carry a `reason` (all servers outside a system record, a role
 * the owner is not in, a holder that does not exist) are the service's, because the pipe's 400 has
 * no `reason`.
 */

export const RECORD_NAME_MAX_LENGTH = 80;
export const RECORD_DESCRIPTION_MAX_LENGTH = 300;
export const RECORD_PROMPT_MAX_LENGTH = 20_000;
export const SUBAGENT_NAME_MAX_LENGTH = 80;
export const SUBAGENT_DESCRIPTION_MAX_LENGTH = 300;
export const DEEP_AGENT_SUBAGENTS_MIN = 1;
export const DEEP_AGENT_SUBAGENTS_MAX = 10;
export const SUBAGENT_MAX_RUNS_MIN = 1;
export const SUBAGENT_MAX_RUNS_MAX = 20;
export const RECORD_MAX_TURNS_MIN = 1;
export const RECORD_MAX_TURNS_MAX = 200;
/** «Максимум шагов» of a new record until an administrator sets another (`library_settings`). */
export const RECORD_MAX_TURNS_DEFAULT = 40;

/** Built-in key of the main-chat record: every enabled employee sees it, its audience is fixed. */
export const CHAT_BUILTIN_KEY = 'chat';
/** Key of the built-in role in `BUILTIN_NAMES`: the role has no `builtinKey`, it is known by its name. */
export const BUILTIN_ROLE_KEY = 'super-admin';

/**
 * Names of the built-in records by `builtinKey` and of the built-in role, in each interface language
 * (i18n design-web.md, KD-6; UXRD MC-7). `ru` is the name the record is seeded with and the role is
 * created with by the migration: a name equal to it was not renamed and is shown in the page's language.
 */
export const BUILTIN_NAMES = {
  [CHAT_BUILTIN_KEY]: { ru: 'Главный чат', en: 'Main chat' },
  'deep-research': { ru: 'Глубокий ресерч', en: 'Deep research' },
  [BUILTIN_ROLE_KEY]: { ru: 'Супер-администратор', en: 'Super administrator' },
} as const satisfies Record<string, Record<Language, string>>;

const isBuiltinNameKey = (key: string): key is keyof typeof BUILTIN_NAMES => Object.hasOwn(BUILTIN_NAMES, key);

/**
 * The name of a library record, or of a role, in `language` (KD-6): a built-in one still under its seeded
 * name (`ru`) is named in `language`; any other name, an administrator's among them, stays as it is. A role
 * has no `builtinKey` and passes `BUILTIN_ROLE_KEY`: it is known by its name alone.
 */
export function builtinNameIn(named: { builtinKey: string | null; name: string }, language: Language): string {
  const { builtinKey, name } = named;
  if (builtinKey === null || !isBuiltinNameKey(builtinKey)) return name;
  const names = BUILTIN_NAMES[builtinKey];
  return name === names.ru ? names[language] : name;
}
/** "All servers" in a record's server list; only a system record may hold it. */
export const ALL_SERVERS = '*';

/** Error codes of the library (`errorCode` of ApiErrorSchema); a body that fails a schema is VALIDATION_FAILED. */
export const LibraryErrorCode = {
  RECORD_NOT_FOUND: 'RECORD_NOT_FOUND',
  RECORD_READ_ONLY: 'RECORD_READ_ONLY',
  RECORD_VERSION_CONFLICT: 'RECORD_VERSION_CONFLICT',
  RECORD_NAME_TAKEN: 'RECORD_NAME_TAKEN',
  RECORD_REJECTED: 'RECORD_REJECTED',
  /** 403: the deep agent is visible, but its knowledge graph is not open to the employee. */
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

export const RecordKindSchema = z.enum(['agent', 'deep_agent']);
export type RecordKind = z.infer<typeof RecordKindSchema>;

/** Platform tools an agent record may hold. `run_code` and `start_deep_agent` are never stored in a record. */
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

/** A subagent: a copy inside its deep agent, called by its name (KD-1). */
const SubagentSchema = z.object({
  name: nameSchema(SUBAGENT_NAME_MAX_LENGTH),
  /** When to call the subagent. */
  description: z.string().trim().min(1).max(SUBAGENT_DESCRIPTION_MAX_LENGTH),
  prompt: PromptSchema,
  servers: ServersSchema,
  model: RecordModelSchema,
  maxTurns: MaxTurnsSchema,
  /** Runs of the subagent within one run of its deep agent. */
  maxRuns: z.number().int().min(SUBAGENT_MAX_RUNS_MIN).max(SUBAGENT_MAX_RUNS_MAX),
});
export type Subagent = z.infer<typeof SubagentSchema>;

export const DeepAgentContentSchema = z
  .object({
    prompt: PromptSchema,
    servers: ServersSchema,
    model: RecordModelSchema,
    maxTurns: MaxTurnsSchema,
    subagents: z.array(SubagentSchema).min(DEEP_AGENT_SUBAGENTS_MIN).max(DEEP_AGENT_SUBAGENTS_MAX),
    /** Subagent whose report becomes the answer; `null` — the deep agent writes it. */
    finalSubagent: z.string().nullable(),
    /** Runs learn into the deep agent's knowledge graph; only people change it. */
    selfLearning: z.boolean().default(false),
  })
  .superRefine((content, ctx) => {
    const names = content.subagents.map((subagent) => subagent.name);
    if (!hasNoRepeats(names.map((name) => name.toLowerCase()))) {
      ctx.addIssue({ code: 'custom', path: ['subagents'], message: 'subagent names repeat' });
    }
    if (content.finalSubagent !== null && !names.includes(content.finalSubagent)) {
      ctx.addIssue({ code: 'custom', path: ['finalSubagent'], message: 'no such subagent' });
    }
  });
export type DeepAgentContent = z.infer<typeof DeepAgentContentSchema>;

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
      kind: z.literal(RecordKindSchema.enum.deep_agent),
      content: DeepAgentContentSchema,
    }),
  ]);
}

/** A record's kind and the content of that kind, as the bodies and the stored rows hold it. */
export type RecordBody =
  | { readonly kind: 'agent'; readonly content: AgentContent }
  | { readonly kind: 'deep_agent'; readonly content: DeepAgentContent };

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

/** Body of POST /api/library/:id/copy: the language of the copy mark and of an unrenamed built-in name. */
export const CopyRecordBodySchema = z.object({ language: LanguageSchema });
export type CopyRecordBody = z.infer<typeof CopyRecordBodySchema>;

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

/** What the viewer lacks to run the record; `subagent` `null` — the agent or the deep agent itself. */
const MissingRightSchema = z.object({
  subagent: z.string().nullable(),
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

/** Response of GET /api/library/:id and of every write that returns the record. */
export const RecordDetailSchema = withContentByKind(recordViewFields);
export type RecordDetail = z.infer<typeof RecordDetailSchema>;

/** Response of POST /api/library/:id/copy. */
export const CopyResultSchema = z.object({
  record: RecordDetailSchema,
  removedServers: z.array(
    z.object({ subagent: z.string().nullable(), servers: z.array(McpServerNameSchema) }),
  ),
  replacedModels: z.array(
    z.object({ subagent: z.string().nullable(), from: ModelIdSchema, to: ModelIdSchema }),
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
