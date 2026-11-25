import { z } from 'zod';
import { ModelIdSchema } from './access';
import {
  RunCodeArgsSchema,
  ScriptCodeSchema,
  ScriptToolArgsSchema,
} from './agents';
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
/**
 * The subagent every deep agent has besides its record's (deep-agents/design-task.md, Contract «Инструмент
 * `task`»): a record's subagent may not take this name.
 */
export const GENERAL_PURPOSE_SUBAGENT = 'general-purpose';
export const RECORD_MAX_TURNS_MIN = 1;
export const RECORD_MAX_TURNS_MAX = 200;

/**
 * Keys of the default agents, one per task type (data-model design-agents.md, KD-4): every enabled employee
 * sees them, their audience is fixed and they cannot be deleted.
 */
export const BuiltinKeySchema = z.enum([
  'chat',
  'agent',
  'deep_agent',
  'trainer',
]);
export type BuiltinKey = z.infer<typeof BuiltinKeySchema>;

/** Built-in key of the main-chat agent, the root of every conversation. */
export const CHAT_BUILTIN_KEY = BuiltinKeySchema.enum.chat;
/** Built-in key of the trainer agent, the root of every training. */
export const TRAINER_BUILTIN_KEY = BuiltinKeySchema.enum.trainer;
/** Key of the built-in role in `BUILTIN_NAMES`: the role has no `builtinKey`, it is known by its name. */
export const BUILTIN_ROLE_KEY = 'super-admin';

/**
 * Names of the built-in records by `builtinKey` and of the built-in role, in each interface language
 * (i18n design-web.md, KD-6; UXRD MC-7). `ru` is the name the built-in rows migration gives the agent and
 * the role: a name equal to it was not renamed and is shown in the page's language.
 */
export const BUILTIN_NAMES = {
  [CHAT_BUILTIN_KEY]: { ru: 'Главный чат', en: 'Main chat' },
  [BuiltinKeySchema.enum.deep_agent]: {
    ru: 'Глубокий агент',
    en: 'Deep agent',
  },
  [TRAINER_BUILTIN_KEY]: { ru: 'Тренер', en: 'Trainer' },
  [BUILTIN_ROLE_KEY]: { ru: 'Супер-администратор', en: 'Super administrator' },
} as const satisfies Record<string, Record<Language, string>>;

const isBuiltinNameKey = (key: string): key is keyof typeof BUILTIN_NAMES =>
  Object.hasOwn(BUILTIN_NAMES, key);

/**
 * The name of a library record, or of a role, in `language` (KD-6): a built-in one still under its seeded
 * name (`ru`) is named in `language`; any other name, an administrator's among them, stays as it is. A role
 * has no `builtinKey` and passes `BUILTIN_ROLE_KEY`: it is known by its name alone.
 */
export function builtinNameIn(
  named: { builtinKey: string | null; name: string },
  language: Language,
): string {
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
  /** 403: the deep agent is visible, but its memory is not open to the employee. */
  MEMORY_FORBIDDEN: 'MEMORY_FORBIDDEN',
} as const;
export type LibraryErrorCode =
  (typeof LibraryErrorCode)[keyof typeof LibraryErrorCode];

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
export const RecordToolSchema = z.enum([
  'start_agent',
  'message_agent',
  'list_agents',
  'stop_agent',
]);
export type RecordTool = z.infer<typeof RecordToolSchema>;

/** The names of the two start tools, as the API registers them and the web recognises them in a feed. */
export const START_AGENT_TOOL = RecordToolSchema.enum.start_agent;
export const START_DEEP_AGENT_TOOL = 'start_deep_agent';
/**
 * `agent` of `start_agent` that starts a fork of the caller; no record may take this name (data-model
 * design-agents.md, «Таблицы каталога»).
 */
export const FORK_AGENT = 'fork';

/** The names of the record tools of the main chat (deep-agents design-agent-types.md, «Инструменты записей»). */
export const LIST_RECORDS_TOOL = 'list_records';
export const READ_RECORD_TOOL = 'read_record';
export const CREATE_RECORD_TOOL = 'create_record';
export const EDIT_RECORD_TOOL = 'edit_record';
export const DELETE_RECORD_TOOL = 'delete_record';
export const ChatRecordToolSchema = z.enum([
  LIST_RECORDS_TOOL,
  READ_RECORD_TOOL,
  CREATE_RECORD_TOOL,
  EDIT_RECORD_TOOL,
  DELETE_RECORD_TOOL,
]);
export type ChatRecordTool = z.infer<typeof ChatRecordToolSchema>;

/** The id of a record, role or user. */
export const IdSchema = z.uuid();
const IsoDateSchema = z.iso.datetime();
/** The version of a record. */
export const VersionSchema = z.number().int().positive();

/** The record chip of a message (custom-agents design-runtime.md, KD-4): shown next to its text. */
export const ChipRecordSchema = z.object({
  id: IdSchema,
  kind: RecordKindSchema,
  name: z.string().min(1),
});
export type ChipRecord = z.infer<typeof ChipRecordSchema>;

/**
 * A name stays on one line: no line break or other control character, so a name can never add a line
 * of its own to a tool description (custom-agents design-runtime.md, Security Considerations).
 */
function lineSchema(maxLength: number) {
  return z
    .string()
    .trim()
    .max(maxLength)
    .regex(/^\P{Cc}*$/u, { message: 'control characters' });
}

function nameSchema(maxLength: number) {
  return lineSchema(maxLength).min(1);
}

function hasNoRepeats(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function listWithoutRepeats<T extends z.ZodType<string>>(item: T) {
  return z.array(item).refine(hasNoRepeats, { message: 'values repeat' });
}

// ---------- Content ----------

const PromptSchema = z.string().min(1).max(RECORD_PROMPT_MAX_LENGTH);
const MaxTurnsSchema = z
  .number()
  .int()
  .min(RECORD_MAX_TURNS_MIN)
  .max(RECORD_MAX_TURNS_MAX);
const ServersSchema = listWithoutRepeats(
  z.union([McpServerNameSchema, z.literal(ALL_SERVERS)]),
);
const ToolsSchema = listWithoutRepeats(RecordToolSchema);
/** `null` — the default chat model at the start of a run. */
const RecordModelSchema = ModelIdSchema.nullable();
/**
 * The run keeps a task list (deep-agents design-task-list.md KD-2): on by default for an agent and a deep
 * agent, off for a subagent. The conversation's root keeps one whatever its record says.
 */
const taskListSchema = (byDefault: boolean) => z.boolean().default(byDefault);

export const AgentContentSchema = z.object({
  prompt: PromptSchema,
  servers: ServersSchema,
  model: RecordModelSchema,
  maxTurns: MaxTurnsSchema,
  /** Agent records this agent may start. */
  agents: listWithoutRepeats(IdSchema),
  tools: ToolsSchema,
  taskList: taskListSchema(true),
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
  maxRuns: z
    .number()
    .int()
    .min(SUBAGENT_MAX_RUNS_MIN)
    .max(SUBAGENT_MAX_RUNS_MAX),
  taskList: taskListSchema(false),
});
export type Subagent = z.infer<typeof SubagentSchema>;

/** A saved script of a deep agent's version (self-learning design-scripts.md, Contract Definitions). */
export const ScriptSchema = z.object({
  name: z
    .string()
    .max(48)
    .regex(/^[A-Za-z][A-Za-z0-9_]*$/),
  /** When to call the script and what it returns. */
  description: nameSchema(1000),
  /** What the script takes as `input`, in words; may be empty. */
  input: lineSchema(1000),
  code: ScriptCodeSchema,
  class: RunCodeArgsSchema.shape.class,
  /** `null` — the deep agent itself, otherwise the name of one of its subagents. */
  owner: z.string().nullable(),
});
export type Script = z.infer<typeof ScriptSchema>;

/** `try_script` arguments: the draft's fields and the `input` a saved script's call gives. */
export const TryScriptArgsSchema = ScriptSchema.pick({
  name: true,
  code: true,
  class: true,
  owner: true,
}).extend({
  input: ScriptToolArgsSchema.shape.input.describe(
    "The script's global `input`, as a saved script's call would give it",
  ),
});
export type TryScriptArgs = z.infer<typeof TryScriptArgsSchema>;

export const DeepAgentContentSchema = z
  .object({
    prompt: PromptSchema,
    servers: ServersSchema,
    model: RecordModelSchema,
    maxTurns: MaxTurnsSchema,
    subagents: z
      .array(SubagentSchema)
      .min(DEEP_AGENT_SUBAGENTS_MIN)
      .max(DEEP_AGENT_SUBAGENTS_MAX),
    /** Subagent whose report becomes the answer; `null` — the deep agent writes it. */
    finalSubagent: z.string().nullable(),
    taskList: taskListSchema(true),
    /** `task` takes an instruction with a list of items, one subagent per item (FR-24); on by default. */
    listDelegation: z.boolean().default(true),
    /** Runs of the deep agent and its subagents keep a memory; only people change it, never on a default agent. */
    selfLearning: z.boolean().default(false),
    scripts: z.array(ScriptSchema).max(100).default([]),
  })
  .superRefine((content, ctx) => {
    const names = content.subagents.map((subagent) => subagent.name);
    if (!hasNoRepeats(names.map((name) => name.toLowerCase()))) {
      ctx.addIssue({
        code: 'custom',
        path: ['subagents'],
        message: 'subagent names repeat',
      });
    }
    const reserved = names.findIndex(
      (name) => name.toLowerCase() === GENERAL_PURPOSE_SUBAGENT,
    );
    if (reserved !== -1) {
      ctx.addIssue({
        code: 'custom',
        path: ['subagents', reserved, 'name'],
        message: `${GENERAL_PURPOSE_SUBAGENT} is the name of the built-in subagent`,
      });
    }
    if (
      content.finalSubagent !== null &&
      !names.includes(content.finalSubagent)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['finalSubagent'],
        message: 'no such subagent',
      });
    }
    const scriptNames = new Set<string>();
    content.scripts.forEach((script, index) => {
      const name = script.name.toLowerCase();
      if (scriptNames.has(name)) {
        ctx.addIssue({
          code: 'custom',
          path: ['scripts', index, 'name'],
          message: 'script names repeat',
        });
      }
      scriptNames.add(name);
      if (script.owner !== null && !names.includes(script.owner)) {
        ctx.addIssue({
          code: 'custom',
          path: ['scripts', index, 'owner'],
          message: 'no such subagent',
        });
      }
    });
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

/**
 * The name of a record: also the argument that names an agent in `start_agent`, `start_deep_agent` and `task`
 * (data-model design-agents.md, «Инструменты модели»).
 */
export const RecordNameSchema = nameSchema(RECORD_NAME_MAX_LENGTH);

const recordTextFields = {
  name: RecordNameSchema,
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
export const UpdateRecordBodySchema = withContentByKind({
  ...recordTextFields,
  version: VersionSchema,
});
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
export type SystemRecordAudienceBody = z.infer<
  typeof SystemRecordAudienceBodySchema
>;

// ---------- Responses ----------

/** Owner of an employee record; `disabled` — the account is disabled. */
const RecordAuthorSchema = z.object({
  id: IdSchema,
  name: z.string(),
  disabled: z.boolean(),
});
export type RecordAuthor = z.infer<typeof RecordAuthorSchema>;

/**
 * Audience as the viewer may see it: the owner, and an admin on a system record, see it whole;
 * anyone else gets only the roles they are in, without `everyone` and `users`.
 */
const RecordAudienceSchema = z.object({
  everyone: z.boolean().optional(),
  roles: z.array(
    z.object({ id: IdSchema, name: z.string(), member: z.boolean() }),
  ),
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
export const RecordSummarySchema = z.object({
  ...recordViewFields,
  kind: RecordKindSchema,
});
export type RecordSummary = z.infer<typeof RecordSummarySchema>;

/** Response of GET /api/library/:id and of every write that returns the record. */
export const RecordDetailSchema = withContentByKind(recordViewFields);
export type RecordDetail = z.infer<typeof RecordDetailSchema>;

/** Response of POST /api/library/:id/copy. */
export const CopyResultSchema = z.object({
  record: RecordDetailSchema,
  removedServers: z.array(
    z.object({
      subagent: z.string().nullable(),
      servers: z.array(McpServerNameSchema),
    }),
  ),
  replacedModels: z.array(
    z.object({
      subagent: z.string().nullable(),
      from: ModelIdSchema,
      to: ModelIdSchema,
    }),
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
export const UpdateLibrarySettingsBodySchema = z.object({
  defaultMaxTurns: MaxTurnsSchema,
});
export type UpdateLibrarySettingsBody = z.infer<
  typeof UpdateLibrarySettingsBodySchema
>;

/** Response of GET/PUT /api/admin/library/settings. `updatedAt: null` while the default stands. */
export const LibrarySettingsSchema = UpdateLibrarySettingsBodySchema.extend({
  updatedAt: IsoDateSchema.nullable(),
});
export type LibrarySettings = z.infer<typeof LibrarySettingsSchema>;

/** Response of GET /api/auth/me/roles: the viewer's roles by name. */
export const MyRoleListSchema = z.array(
  z.object({ id: IdSchema, name: z.string() }),
);
export type MyRoleList = z.infer<typeof MyRoleListSchema>;

// ---------- Port for the runtime part ----------

/**
 * Row of `listVisible(viewerId)`; `version` and `versionId` — the number and the id of the active version;
 * `shared` — the record has at least one holder. `listVisible` lists them by name without case, agents of
 * one name earliest created first (the name winner of KD-5 takes the first of several colleagues' agents).
 */
export type RecordHeader = {
  id: string;
  kind: RecordKind;
  name: string;
  description: string;
  version: number;
  versionId: string;
  builtinKey: string | null;
  author: RecordAuthor | null;
  mine: boolean;
  shared: boolean;
  offerInChat: boolean;
};

/** What the name rule (KD-5) reads of a record: a header of `listVisible` or a row of the library list. */
export type NameCandidate = Pick<
  RecordHeader,
  'kind' | 'name' | 'builtinKey' | 'mine' | 'author'
>;

/** The rank of KD-5: the viewer's own agent, then a colleague's, then a system one. */
function nameRank(record: NameCandidate): number {
  if (record.mine) return 0;
  return record.author === null ? 2 : 1;
}

/**
 * The agents a name starts (data-model design-agents.md, KD-5) — the one place of the rule for the start, the
 * tool listings and the web: of the records of one kind and one name without case, the viewer's own, else the
 * colleague's that comes first, else the system one. `records` come in the order of the library list, agents
 * of one name earliest created first. The chat and the trainer are never started by name.
 */
export function nameWinners<T extends NameCandidate>(
  records: Iterable<T>,
): T[] {
  const winners = new Map<string, T>();
  for (const record of records) {
    if (
      record.builtinKey === CHAT_BUILTIN_KEY ||
      record.builtinKey === TRAINER_BUILTIN_KEY
    )
      continue;
    const key = `${record.kind}:${record.name.toLowerCase()}`;
    const current = winners.get(key);
    if (current === undefined || nameRank(record) < nameRank(current))
      winners.set(key, record);
  }
  return [...winners.values()];
}

/** The record a start of `kind` by `name` starts (`nameWinners`); `null` — none, a temporary agent starts. */
export function nameWinner<T extends NameCandidate>(
  records: Iterable<T>,
  kind: RecordKind,
  name: string,
): T | null {
  const key = name.toLowerCase();
  const [winner] = nameWinners(
    [...records].filter(
      (record) => record.kind === kind && record.name.toLowerCase() === key,
    ),
  );
  return winner ?? null;
}

/** Answer of `resolve` and `resolveBuiltin`: the header and the content of its active version. */
export type ResolvedRecord = Omit<RecordHeader, 'kind'> & RecordBody;

/**
 * Answer of `version(versionId)` (data-model design-agents.md, «Порт `RecordLibrary`»): an immutable version
 * with its agent's id and kind and the parsed content, read without a visibility check.
 */
export type AgentVersion = {
  id: string;
  agentId: string;
  number: number;
} & RecordBody;
