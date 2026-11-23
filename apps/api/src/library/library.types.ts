import type {
  CreateRecordBody,
  LibraryRecordCard,
  LibraryRejectReason,
  RecordAuthor,
  RecordBody,
} from '@agent-os/contracts';
import type { LibraryViewer } from '@agent-os/db';
import type { StoredBan, StoredRecord } from './stored-records';
import type { RefusedField } from './save-rules';

/**
 * The types the library's services share (design-library.md; deep-agents design-agent-types.md): the
 * record as the services read it, who acts, the facts the callers give, and the refusals of a save and
 * of a chat change.
 */

interface NamedHolder {
  readonly id: string;
  readonly name: string;
}

/** The audience of a record: "everyone", roles and employees, each by name, then the id of its row. */
export interface RecordHolders {
  readonly everyone: boolean;
  readonly roles: readonly NamedHolder[];
  readonly users: readonly NamedHolder[];
}

/** A stored record with its author and its audience by name (`LibraryRecords`). */
export interface LibraryRecord extends Omit<StoredRecord, 'holders'> {
  /** `null` — a system record. */
  readonly author: RecordAuthor | null;
  readonly holders: RecordHolders;
}

/** A row of the ban list: no description, no content (AC-09.4). */
export interface BannedRecordRow extends Omit<StoredBan, 'ownerId'> {
  readonly author: RecordAuthor;
}

/** The employee of a route: the id from the session and the admin right (`req.user`). */
export interface LibraryActor {
  readonly id: string;
  readonly isAdmin: boolean;
}

/** Facts only the agents package has, given by the caller (KD-4, port-module-split.md): servers usable to the actor. */
export interface ServerFacts {
  readonly usableServers: readonly string[];
}

/** An admin on a system record chooses from the whole MCP registry. */
export interface PanelServerFacts extends ServerFacts {
  readonly registryServers: readonly string[];
}

/** A deep agent whose knowledge graph is open to the actor: what the knowledge routes need. */
export interface KnowledgeTarget {
  readonly recordId: string;
  /** The flag of the deep agent's last version. */
  readonly selfLearning: boolean;
  /** The servers of the deep agent and of its subagents in the last version, without repeats (`*` as is). */
  readonly servers: readonly string[];
}

/** Why a save is refused; each route answers it with its own error. */
export type SaveRefusal =
  | 'not_found'
  | 'read_only'
  | 'version_conflict'
  | 'name_taken'
  | 'system_name'
  | 'invalid'
  | LibraryRejectReason;

export type SaveScope = 'employee' | 'system';

export interface SaveRequest {
  readonly scope: SaveScope;
  readonly author: LibraryViewer;
  readonly target: { readonly id: string; readonly version: number } | null;
  readonly body: CreateRecordBody;
  /** Servers usable to the author (employee) or the MCP registry (system). */
  readonly servers: readonly string[];
  /** The id of a new record chosen before the save (a chat card, deep-agents KD-3); absent — the database's. */
  readonly newId?: string;
  /**
   * The models the author may choose, read before a transaction opened (the chat's save runs in the step's
   * transaction); absent — read here: allowed to the employee, or the chat models of the catalogue.
   */
  readonly models?: readonly string[];
}

/** A refusal of the save, with the part of the record the rule is about when a rule of the content decided. */
export interface Refused {
  readonly outcome: 'refused';
  readonly refusal: SaveRefusal;
  readonly field?: RefusedField;
}

export type SaveResult =
  { readonly outcome: 'saved'; readonly record: LibraryRecord } | Refused;

/** What the checks before the write decided: the stored record an edit changes, or the refusal. */
export type SaveCheck =
  | { readonly outcome: 'allowed'; readonly previous: LibraryRecord | null }
  | Refused;

/** A record's name, description and kind with its content, as a chat change names it. */
export interface ChatRecordInput {
  readonly name: string;
  readonly description: string;
  readonly body: RecordBody;
}

/**
 * A change the main chat asks for (deep-agents KD-3). The self-learning flag in `body` is not the
 * chat's: the service sets it — off on create, the stored one on edit.
 */
export type ChatChange =
  | {
      readonly action: 'create';
      readonly system: boolean;
      readonly record: ChatRecordInput;
    }
  | {
      readonly action: 'edit';
      readonly recordId: string;
      readonly record: ChatRecordInput;
    }
  | { readonly action: 'delete'; readonly recordId: string };

/** The facts a chat call is decided with, read before any transaction (`LibraryChatService.chatContext`). */
export interface ChatContext {
  readonly actor: LibraryActor;
  readonly viewer: LibraryViewer;
  /** The servers usable to the employee and, for an admin, the MCP registry. */
  readonly servers: PanelServerFacts;
  readonly allowedModels: readonly string[];
  /** The chat models of the catalogue; empty for a non-admin. */
  readonly catalogueModels: readonly string[];
}

/**
 * Why a chat change is refused: a refusal of the save, or a rule only the chat has — a record with
 * holders (`shared`), a system record for a non-admin (`admin_only`).
 */
export type ChatRefusalCode = SaveRefusal | 'shared' | 'admin_only';

/** A refused chat change, with the part of the record the rule is about when one is. */
export interface ChatRefusal {
  readonly outcome: 'refused';
  readonly refusal: ChatRefusalCode;
  readonly field?: RefusedField;
  /** The servers the record may name — usable to the employee, or the registry — when a rule of the content refused. */
  readonly allowedServers?: readonly string[];
}

/** The answer of the check before the card: the refusal, or the card's content. */
export type ChatReview =
  ChatRefusal | { readonly outcome: 'card'; readonly card: LibraryRecordCard };

/** The answer of the save of an approved card; `version` `null` — the record was deleted. */
export type ChatSaveResult =
  | ChatRefusal
  | {
      readonly outcome: 'saved';
      readonly recordId: string;
      readonly version: number | null;
    };
