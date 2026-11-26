import {
  type BuiltinKey,
  CHAT_BUILTIN_KEY,
  type ChipRecord,
  modelProvider,
  type RecordKind,
  type ResolvedRecord,
  type StartRefusedError,
  TRAINER_BUILTIN_KEY,
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
import type { RunStart } from './run-definition';

/**
 * Where a start takes its version (data-model design-agents.md, «Старт: версия, имя и модель беседы»). Only
 * `builtin` and `record` ask the library; the others repeat a start the run already holds. A call by name
 * goes through `resolveNamedStart`. A deep agent's team members are not started here: `task` takes them from
 * the deep agent's run (deep-agents/design-task.md KD-6).
 */
export type StartSource =
  /** The default agent with this key, such as `chat` for the root of a conversation. */
  | { readonly kind: 'builtin'; readonly builtinKey: BuiltinKey }
  /**
   * An agent by its id: the restart of an agent or a root from scratch, and `start_test_deep_agent` of the
   * harness; an agent of another kind is unavailable. `name` — the name the run keeps, a restart's: the
   * restarted conversation's, so a temporary agent stays under its call's name; absent — the agent's name.
   */
  | {
      readonly kind: 'record';
      readonly recordId: string;
      readonly expected: RecordKind;
      readonly name?: string;
    }
  /** A fork: the caller's start. */
  | { readonly kind: 'fork'; readonly run: RunStart }
  /** The restart of a subagent or a fork: the restarted conversation's version, name and model. */
  | { readonly kind: 'restart'; readonly run: RunStart };

export interface StartRequest {
  /** The employee who starts the run: the library is asked on his behalf, not the author's. */
  readonly ownerId: string;
  readonly source: StartSource;
  /**
   * The model of the caller's conversation, the second link of the model chain (KD-3); `null` — the run
   * is a conversation's root, whose chain goes on to the system model.
   */
  readonly callerModel: string | null;
}

export interface StartDeps {
  readonly library: RecordLibrary;
  readonly access: AccessGate;
  /** The readiness of the provider of the run's model (model-providers design-core.md KD-2). */
  readonly providers: Pick<AgentsProviders, 'connection'>;
}

/**
 * Why a start is refused (DC-5): `model` is the refused model on a model or provider refusal, otherwise
 * `null` — also for `model_not_configured`, where the chain of KD-3 ends without a model.
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
  { readonly kind: 'started'; readonly run: RunStart } | StartRefusal;

/** A start by the name a call gives (KD-5): the kind the call starts and the caller's model. */
export interface NamedStartRequest {
  readonly ownerId: string;
  readonly name: string;
  /** `agent` for `start_agent`, `deep_agent` for `start_deep_agent`. */
  readonly kind: RecordKind;
  readonly callerModel: string | null;
  /** The chip of the message the call answers (`History.answeredChip`); `null` — the message carries none. */
  readonly chip: ChipRecord | null;
}

/**
 * The answer of a start by name: a start or a refusal as by id, or `other_kind` — the owner sees no agent of
 * the asked kind with the name, but one of `found`: the tool refuses it with `not_allowed` and names the tool
 * that starts it.
 */
export type NamedStartResolution =
  StartResolution | { readonly kind: 'other_kind'; readonly found: RecordKind };

const RECORD_UNAVAILABLE: StartRefusal = {
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
 * The one start procedure (KD-2; ADR-0017): source → visibility for the starter → version, name and model →
 * the model's rights → its provider. It runs before the transaction that starts the run and writes nothing:
 * a refused model comes back with its `access_denied` record, which the caller writes once that refusal is
 * its outcome; a provider refusal and `model_not_configured` have none (model-providers design-core.md KD-2).
 * The model is chosen here, once, by the chain of KD-3 (data-model design-agents.md): the version's, else
 * the caller's, else — only at a root — the system model; a model inherited from the caller is checked like
 * any other (DC-20). A spent quota does not stop the start — the run fails at its first call; a disabled
 * owner rejects with `OwnerDisabledError`.
 */
export async function resolveStart(
  { ownerId, source, callerModel }: StartRequest,
  deps: StartDeps,
): Promise<StartResolution> {
  return checked(
    ownerId,
    await startOf(ownerId, source, callerModel, deps),
    deps,
  );
}

/**
 * The start of the agent a call names (KD-5; data-model design-agents.md, «Старт: версия, имя и модель
 * беседы»): the record the employee chose for the message, when the call names it (`chosenRecord`); else the
 * winner of the name among the agents of `kind` the owner sees — either under its own name; else, when
 * the owner sees an agent of the other kind with the name, `other_kind`; else a temporary agent — the default
 * agent of `kind` (`agent` or `deep_agent`) under the call's name. An invisible, a deleted and a missing name
 * all start the temporary agent, so a call never learns that a colleague has an agent of that name. The model
 * and its provider are checked as in `resolveStart`.
 */
export async function resolveNamedStart(
  request: NamedStartRequest,
  deps: StartDeps,
): Promise<NamedStartResolution> {
  const { ownerId, name, kind, callerModel } = request;
  const winner =
    (await chosenRecord(request, deps.library)) ??
    (await deps.library.resolveByName(ownerId, name, kind));
  if (winner === null) {
    const other = await deps.library.resolveByName(
      ownerId,
      name,
      otherKind(kind),
    );
    if (other !== null) return { kind: 'other_kind', found: other.kind };
  }
  const record = winner ?? {
    ...(await deps.library.resolveBuiltin(kind)),
    name,
  };
  return checked(ownerId, await startOfRecord(record, callerModel, deps), deps);
}

/**
 * The record a call means by the name of its message's chip: the chip names one record of several the owner
 * may see under that name, so a call of the chip's name — without case, as the name rule compares — starts
 * that record, read by its id as the owner sees it now. `null` — the name rule decides, exactly as without a
 * chip: the call names another name, or the record is deleted, hidden from the owner, of another kind than
 * the call starts, the chat or the trainer.
 */
async function chosenRecord(
  { ownerId, name, kind, chip }: NamedStartRequest,
  library: RecordLibrary,
): Promise<ResolvedRecord | null> {
  if (chip === null || chip.name.toLowerCase() !== name.toLowerCase())
    return null;
  const record = await library.resolve(ownerId, chip.id);
  return record?.kind === kind &&
    record.builtinKey !== CHAT_BUILTIN_KEY &&
    record.builtinKey !== TRAINER_BUILTIN_KEY
    ? record
    : null;
}

function otherKind(kind: RecordKind): RecordKind {
  return kind === 'agent' ? 'deep_agent' : 'agent';
}

/** The rights to the run's model and its provider, after the source gave a run. */
async function checked(
  ownerId: string,
  run: StartResolution,
  deps: StartDeps,
): Promise<StartResolution> {
  if (run.kind === 'refused') return run;
  const { model } = run.run;
  return (
    (await modelRefusal(ownerId, model, deps.access)) ??
    (await providerRefusal(model, deps.providers)) ??
    run
  );
}

/** Writes the `access_denied` record of a start refused for its model; any other refusal writes nothing. */
export async function auditStartRefusal(
  audit: AccessAudit,
  refusal: StartRefusal,
): Promise<void> {
  if (refusal.denied !== null) await audit(refusal.denied);
}

async function startOf(
  ownerId: string,
  source: StartSource,
  callerModel: string | null,
  deps: StartDeps,
): Promise<StartResolution> {
  switch (source.kind) {
    case 'builtin': {
      const record = await deps.library.resolveBuiltin(source.builtinKey);
      return startOfRecord(record, callerModel, deps);
    }
    case 'record': {
      const record = await deps.library.resolve(ownerId, source.recordId);
      return startOfRecord(
        record?.kind === source.expected
          ? { ...record, name: source.name ?? record.name }
          : null,
        callerModel,
        deps,
      );
    }
    case 'fork':
    case 'restart':
      return { kind: 'started', run: source.run };
  }
}

/**
 * The start of an agent the library gave the starter: its active version under its name, and the model by
 * the chain of KD-3. The system model is read only when the version and the caller have none — at a root.
 */
async function startOfRecord(
  record: ResolvedRecord | null,
  callerModel: string | null,
  deps: StartDeps,
): Promise<StartResolution> {
  if (record === null) return RECORD_UNAVAILABLE;
  const model =
    record.content.model ??
    callerModel ??
    (await deps.access.defaultChatModel());
  if (model === null) return MODEL_NOT_CONFIGURED;
  const identity = {
    id: record.versionId,
    agentId: record.id,
    number: record.version,
  };
  return {
    kind: 'started',
    run: {
      version:
        record.kind === 'agent'
          ? { ...identity, kind: 'agent', content: record.content }
          : { ...identity, kind: 'deep_agent', content: record.content },
      name: record.name,
      subagent: null,
      model,
    },
  };
}

/** The gate's answer about the run's model, as `start_agent` gives it (design-access.md KD-4). */
async function modelRefusal(
  ownerId: string,
  model: string,
  access: AccessGate,
): Promise<StartRefusal | undefined> {
  const verdict = await access.model(ownerId, model);
  if (verdict.kind === 'allowed' || verdict.reason === 'quota_exhausted')
    return undefined;
  if (verdict.reason === 'owner_disabled')
    throw new OwnerDisabledError(ownerId);
  return {
    kind: 'refused',
    reason:
      verdict.reason === 'model_not_connected'
        ? 'model_not_connected'
        : 'model_not_allowed',
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
  const readiness = providerReadiness(
    await providers.connection(modelProvider(model)),
  );
  if (readiness === 'ready') return undefined;
  return {
    kind: 'refused',
    reason: `provider_${readiness}`,
    model,
    denied: null,
  };
}
