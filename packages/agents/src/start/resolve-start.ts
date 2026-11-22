import {
  modelProvider,
  type RecordKind,
  type ResolvedRecord,
  type StartRefusedError,
} from '@agent-os/contracts';

import {
  type AccessAudit,
  type AccessDeniedEntry,
  type AccessGate,
  OwnerDisabledError,
} from '../access-gate';
import { modelDeniedEntry } from '../model/model-client';
import { providerReadiness } from '../providers/provider-readiness';
import type { AgentsProviders } from '../providers/provider-registry';
import type { RecordLibrary } from './record-library';
import type { RunSnapshot } from './snapshot';
import { recordSnapshot, snapshotDefinition } from './snapshot-definition';

/**
 * Where a start takes its snapshot (design-runtime.md, «Откуда берётся снимок»). Only `builtin` and
 * `record` ask the library; the others copy a snapshot the run already holds. A deep agent's subagents
 * are not started here: `task` takes their snapshots from the deep agent's (deep-agents/design-task.md KD-6).
 */
export type StartSource =
  /** The built-in record with this key, such as `chat` for the root of a conversation. */
  | { readonly kind: 'builtin'; readonly builtinKey: string }
  /** A record by its id, and its restart from scratch; a record of another kind is unavailable. */
  | { readonly kind: 'record'; readonly recordId: string; readonly expected: RecordKind }
  /** A fork: the caller's snapshot. */
  | { readonly kind: 'fork'; readonly snapshot: RunSnapshot }
  /** The restart of a subagent or a fork: its own earlier snapshot. */
  | { readonly kind: 'restart'; readonly snapshot: RunSnapshot };

export interface StartRequest {
  /** The employee who starts the run: the library is asked on his behalf, not the author's. */
  readonly ownerId: string;
  readonly source: StartSource;
}

export interface StartDeps {
  readonly library: RecordLibrary;
  readonly access: AccessGate;
  /** The readiness of the provider of the snapshot's model (model-providers design-core.md KD-2). */
  readonly providers: Pick<AgentsProviders, 'connection'>;
}

/**
 * Why a start is refused (DC-5): `model` is the refused model on a model or provider refusal, otherwise
 * `null` — also for `model_not_configured`, where a record's model is the default and none is chosen.
 */
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

const MODEL_NOT_CONFIGURED: StartRefusal = {
  kind: 'refused',
  reason: 'model_not_configured',
  model: null,
  denied: null,
};

/**
 * The one start procedure (KD-2; ADR-0017): source → visibility for the starter → snapshot → model →
 * its provider. It runs before the transaction that starts the run and writes nothing: a refused model
 * comes back with its `access_denied` record, which the caller writes once that refusal is its outcome;
 * a provider refusal and `model_not_configured` have none (model-providers design-core.md KD-2, KD-5).
 * A record's `null` model becomes the default chat model here, once, in the snapshot: subagents, forks
 * and restarts copy it. A spent quota does not stop the start — the run fails at its first call; a
 * disabled owner rejects with `OwnerDisabledError`.
 */
export async function resolveStart(
  { ownerId, source }: StartRequest,
  deps: StartDeps,
): Promise<StartResolution> {
  const snapshot = await buildSnapshot(ownerId, source, deps);
  if (snapshot.kind === 'refused') return snapshot;
  const model = snapshotDefinition(snapshot).model;
  return (
    (await modelRefusal(ownerId, model, deps.access)) ??
    (await providerRefusal(model, deps.providers)) ?? { kind: 'snapshot', snapshot }
  );
}

/** Writes the `access_denied` record of a start refused for its model; any other refusal writes nothing. */
export async function auditStartRefusal(audit: AccessAudit, refusal: StartRefusal): Promise<void> {
  if (refusal.denied !== null) await audit(refusal.denied);
}

async function buildSnapshot(
  ownerId: string,
  source: StartSource,
  deps: StartDeps,
): Promise<RunSnapshot | StartRefusal> {
  switch (source.kind) {
    case 'builtin': {
      const record = await deps.library.resolveBuiltin(ownerId, source.builtinKey);
      return snapshotOfRecord(ownerId, record, deps);
    }
    case 'record': {
      const record = await deps.library.resolve(ownerId, source.recordId);
      return snapshotOfRecord(ownerId, record?.kind === source.expected ? record : null, deps);
    }
    case 'fork':
    case 'restart':
      return source.snapshot;
  }
}

/**
 * The snapshot of a record the library gave the starter; an agent's `agents` are matched against one
 * `listVisible` of the same starter (plan Notes 9в), a deep agent needs none. The default chat model is
 * read at the start, for the record's `null` models (KD-5).
 */
async function snapshotOfRecord(
  ownerId: string,
  record: ResolvedRecord | null,
  deps: StartDeps,
): Promise<RunSnapshot | StartRefusal> {
  if (record === null) return RECORD_UNAVAILABLE;
  const [visible, defaultModel] = await Promise.all([
    record.kind === 'agent' ? deps.library.listVisible(ownerId) : [],
    deps.access.defaultChatModel(),
  ]);
  return recordSnapshot(record, visible, defaultModel) ?? MODEL_NOT_CONFIGURED;
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

/**
 * The readiness of the model's provider (KD-2, `providerReadiness`): a provider that is missing,
 * disabled or without its key refuses the start with the model; not a refusal of rights, so no record.
 */
async function providerRefusal(
  model: string,
  providers: StartDeps['providers'],
): Promise<StartRefusal | undefined> {
  const readiness = providerReadiness(await providers.connection(modelProvider(model)));
  if (readiness === 'ready') return undefined;
  return { kind: 'refused', reason: `provider_${readiness}`, model, denied: null };
}
