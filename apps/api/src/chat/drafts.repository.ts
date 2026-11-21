import {
  AgentContentSchema,
  DraftStateSchema,
  SaveOwnRefusalSchema,
  WorkflowContentSchema,
  type DraftState,
  type RecordBody,
  type SaveOwnRefusal,
} from '@agent-os/contracts';
import { chatDrafts } from '@agent-os/db';
import { and, asc, eq } from 'drizzle-orm';
import type { Executor } from '../common/executor';

/** A row of `chat_drafts` with its kind and content read back as a record body. */
export interface Draft {
  readonly id: string;
  readonly conversationId: string;
  readonly ownerId: string;
  readonly callId: string;
  /** The edited record and its version at the draft; `null` for a new record. */
  readonly recordId: string | null;
  readonly baseVersion: number | null;
  readonly name: string;
  readonly description: string;
  readonly body: RecordBody;
  readonly state: DraftState;
  readonly savedRecordId: string | null;
  readonly refusal: SaveOwnRefusal | null;
  readonly createdAt: Date;
  readonly resolvedAt: Date | null;
}

/** What `draft_record` writes: the conversation — the id of its root session — its owner, the call and the proposed record. */
export interface NewDraft {
  readonly conversationId: string;
  readonly ownerId: string;
  readonly callId: string;
  readonly target: { readonly id: string; readonly version: number } | null;
  readonly name: string;
  readonly description: string;
  readonly body: RecordBody;
}

/** How a waiting draft ends: its final state and, when saved, the record it became. */
export interface DraftResolution {
  readonly state: Exclude<DraftState, 'pending' | 'superseded'>;
  readonly name: string;
  readonly savedRecordId: string | null;
}

type DraftRow = typeof chatDrafts.$inferSelect;

/** The stored content is the one `draft_record` validated; it is parsed back by its kind's schema. */
function recordBody(kind: string, content: unknown): RecordBody {
  return kind === 'agent'
    ? { kind: 'agent', content: AgentContentSchema.parse(content) }
    : { kind: 'workflow', content: WorkflowContentSchema.parse(content) };
}

function toDraft(row: DraftRow): Draft {
  return {
    id: row.id,
    conversationId: row.conversationId,
    ownerId: row.ownerId,
    callId: row.callId,
    recordId: row.recordId,
    baseVersion: row.baseVersion,
    name: row.name,
    description: row.description,
    body: recordBody(row.kind, row.content),
    state: DraftStateSchema.parse(row.state),
    savedRecordId: row.savedRecordId,
    refusal: row.refusal === null ? null : SaveOwnRefusalSchema.parse(row.refusal),
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt,
  };
}

const PENDING = DraftStateSchema.enum.pending;

// Queries of `chat_drafts` (repository-over-transaction.md): every write runs in the caller's
// transaction — the root step's commit for `draft_record`, the action's own for `DraftsService`.

/**
 * Writes a draft into the conversation, turning the conversation's waiting draft into `superseded`
 * first (KD-6, DC-8): a conversation has at most one waiting draft. The caller is the conversation's
 * root, in its own step; the foreign key refuses an id that is no session.
 */
export async function insertDraft(executor: Executor, draft: NewDraft): Promise<Draft> {
  await executor
    .update(chatDrafts)
    .set({ state: DraftStateSchema.enum.superseded, resolvedAt: new Date() })
    .where(and(eq(chatDrafts.conversationId, draft.conversationId), eq(chatDrafts.state, PENDING)));
  const [row] = await executor
    .insert(chatDrafts)
    .values({
      conversationId: draft.conversationId,
      ownerId: draft.ownerId,
      callId: draft.callId,
      kind: draft.body.kind,
      recordId: draft.target?.id ?? null,
      baseVersion: draft.target?.version ?? null,
      name: draft.name,
      description: draft.description,
      content: draft.body.content,
    })
    .returning();
  if (row === undefined) throw new Error('chat_drafts insert returned no row');
  return toDraft(row);
}

/** Every draft of the conversation, oldest first. The caller has checked the conversation's owner. */
export async function listDrafts(executor: Executor, conversationId: string): Promise<Draft[]> {
  const rows = await executor
    .select()
    .from(chatDrafts)
    .where(eq(chatDrafts.conversationId, conversationId))
    .orderBy(asc(chatDrafts.createdAt), asc(chatDrafts.id));
  return rows.map(toDraft);
}

/**
 * Locks the draft `draftId` of the owner's conversation `conversationId` FOR UPDATE, so two actions on
 * one draft take turns (DC-9). Another owner's draft and a draft of another conversation are as absent
 * as a missing one.
 */
export async function lockDraft(
  executor: Executor,
  key: { readonly draftId: string; readonly conversationId: string; readonly ownerId: string },
): Promise<Draft | undefined> {
  const [row] = await executor
    .select()
    .from(chatDrafts)
    .where(
      and(
        eq(chatDrafts.id, key.draftId),
        eq(chatDrafts.conversationId, key.conversationId),
        eq(chatDrafts.ownerId, key.ownerId),
      ),
    )
    .for('update');
  return row === undefined ? undefined : toDraft(row);
}

/** Ends a waiting draft: its final state, the name it was saved under and the saved record. */
export async function resolveDraft(
  executor: Executor,
  draftId: string,
  resolution: DraftResolution,
): Promise<Draft> {
  const [row] = await executor
    .update(chatDrafts)
    .set({
      state: resolution.state,
      name: resolution.name,
      savedRecordId: resolution.savedRecordId,
      refusal: null,
      resolvedAt: new Date(),
    })
    .where(eq(chatDrafts.id, draftId))
    .returning();
  if (row === undefined) throw new Error(`chat_drafts row ${draftId} vanished under its lock`);
  return toDraft(row);
}

/** Keeps the draft waiting with the reason `saveOwn` refused it. */
export async function setDraftRefusal(
  executor: Executor,
  draftId: string,
  refusal: SaveOwnRefusal,
): Promise<Draft> {
  const [row] = await executor
    .update(chatDrafts)
    .set({ refusal })
    .where(eq(chatDrafts.id, draftId))
    .returning();
  if (row === undefined) throw new Error(`chat_drafts row ${draftId} vanished under its lock`);
  return toDraft(row);
}
