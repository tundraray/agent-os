import type { RecordKind, ResolvedRecord, StartRefusedError } from '@agent-os/contracts';

import {
  type AccessAudit,
  type AccessDeniedEntry,
  type AccessGate,
  OwnerDisabledError,
} from '../access-gate.js';
import { modelDeniedEntry } from '../model/model-client.js';
import type { RecordLibrary } from './record-library.js';
import type { RunSnapshot, WorkflowSnapshot } from './snapshot.js';
import { executorSnapshot, recordSnapshot, snapshotDefinition } from './snapshot-definition.js';

/**
 * Where a start takes its snapshot (design-runtime.md, «Откуда берётся снимок»). Only `builtin` and
 * `record` ask the library; the others copy a snapshot the run already holds, so an executor works on
 * the workflow's copy even when its source is hidden from the starter (AC-16.3).
 */
export type StartSource =
  /** The built-in record with this key, such as `chat` for the root of a conversation. */
  | { readonly kind: 'builtin'; readonly builtinKey: string }
  /** A record by its id, and its restart from scratch; a record of another kind is unavailable. */
  | { readonly kind: 'record'; readonly recordId: string; readonly expected: RecordKind }
  /** An executor of the coordinator's team, by its name; a name outside the team is unavailable. */
  | { readonly kind: 'executor'; readonly coordinator: WorkflowSnapshot; readonly name: string }
  /** A fork: the caller's snapshot. */
  | { readonly kind: 'fork'; readonly snapshot: RunSnapshot }
  /** The restart of an executor or a fork: its own earlier snapshot. */
  | { readonly kind: 'restart'; readonly snapshot: RunSnapshot };

export interface StartRequest {
  /** The employee who starts the run: the library is asked on his behalf, not the author's. */
  readonly ownerId: string;
  readonly source: StartSource;
}

export interface StartDeps {
  readonly library: RecordLibrary;
  readonly access: AccessGate;
}

/** Why a start is refused (DC-5): `model` is the refused model on a model refusal, otherwise `null`. */
export interface StartRefusal {
  readonly kind: 'refused';
  readonly reason: StartRefusedError['reason'];
  readonly model: string | null;
  /**
   * The `access_denied` record of a refused model, `null` for any other refusal. The caller writes it
   * with `auditStartRefusal` only when this refusal is the outcome it returns.
   */
  readonly denied: AccessDeniedEntry | null;
}

export type StartResolution =
  | { readonly kind: 'snapshot'; readonly snapshot: RunSnapshot }
  | StartRefusal;

export const RECORD_UNAVAILABLE: StartRefusal = {
  kind: 'refused',
  reason: 'record_unavailable',
  model: null,
  denied: null,
};

/**
 * The one start procedure (KD-2; ADR-0017): source → visibility for the starter → snapshot → model.
 * It runs before the transaction that starts the run and writes nothing: a refused model comes back
 * with its `access_denied` record, which the caller writes once that refusal is its outcome. A spent
 * quota does not stop the start — the run fails at its first call; a disabled owner rejects with
 * `OwnerDisabledError`.
 */
export async function resolveStart(
  { ownerId, source }: StartRequest,
  deps: StartDeps,
): Promise<StartResolution> {
  const snapshot = await buildSnapshot(ownerId, source, deps.library);
  if (snapshot === null) return RECORD_UNAVAILABLE;
  const model = snapshotDefinition(snapshot).model;
  return (await modelRefusal(ownerId, model, deps.access)) ?? { kind: 'snapshot', snapshot };
}

/** Writes the `access_denied` record of a start refused for its model; any other refusal writes nothing. */
export async function auditStartRefusal(audit: AccessAudit, refusal: StartRefusal): Promise<void> {
  if (refusal.denied !== null) await audit(refusal.denied);
}

async function buildSnapshot(
  ownerId: string,
  source: StartSource,
  library: RecordLibrary,
): Promise<RunSnapshot | null> {
  switch (source.kind) {
    case 'builtin': {
      const record = await library.resolveBuiltin(ownerId, source.builtinKey);
      return snapshotOfRecord(ownerId, record, library);
    }
    case 'record': {
      const record = await library.resolve(ownerId, source.recordId);
      return snapshotOfRecord(ownerId, record?.kind === source.expected ? record : null, library);
    }
    case 'executor':
      return executorSnapshot(source.coordinator, source.name);
    case 'fork':
    case 'restart':
      return source.snapshot;
  }
}

/**
 * The snapshot of a record the library gave the starter; an agent's `agents` are matched against one
 * `listVisible` of the same starter (plan Notes 9в), a workflow needs none.
 */
async function snapshotOfRecord(
  ownerId: string,
  record: ResolvedRecord | null,
  library: RecordLibrary,
): Promise<RunSnapshot | null> {
  if (record === null) return null;
  const visible = record.kind === 'agent' ? await library.listVisible(ownerId) : [];
  return recordSnapshot(record, visible);
}

/** The gate's answer about the snapshot's model, as `start_agent` gives it (design-access.md KD-4). */
async function modelRefusal(
  ownerId: string,
  model: string,
  access: AccessGate,
): Promise<StartRefusal | undefined> {
  const verdict = await access.model(ownerId, model);
  if (verdict.kind === 'allowed' || verdict.reason === 'quota_exhausted') return undefined;
  if (verdict.reason === 'owner_disabled') throw new OwnerDisabledError(ownerId);
  return {
    kind: 'refused',
    reason: verdict.reason === 'model_not_connected' ? 'model_not_connected' : 'model_not_allowed',
    model,
    denied: modelDeniedEntry(ownerId, model, verdict),
  };
}
