import {
  ALL_SERVERS,
  FORK_AGENT,
  type LibraryRejectReason,
  type RecordBody,
  type RecordNameTakenReason,
} from '@agent-os/contracts';
import {
  contentParts,
  fieldPath,
  isNameTaken,
  type ContentPart,
} from './record-content';

/** Agent records the content may start; only an agent holds them. */
function contentAgents(body: RecordBody): readonly string[] {
  return body.kind === 'agent' ? body.content.agents : [];
}

/**
 * What the author may choose (KD-4): an employee — the servers usable to them, the models allowed to
 * them in «Мой доступ» order; an admin on a system record — the whole registry and catalogue.
 */
export type SaveChoices =
  | {
      readonly scope: 'employee';
      readonly usableServers: readonly string[];
      readonly allowedModels: readonly string[];
      readonly visibleAgentIds: readonly string[];
    }
  | {
      readonly scope: 'system';
      readonly registryServers: readonly string[];
      readonly catalogueModels: readonly string[];
      readonly visibleAgentIds: readonly string[];
    };

export interface SaveInput {
  readonly name: string;
  readonly body: RecordBody;
  /** The stored record before this save; `null` on create. */
  readonly previous: {
    readonly name: string;
    readonly body: RecordBody;
    readonly builtinKey: string | null;
  } | null;
  /**
   * Names of other records, this one left out: `own` — the author's (of every kind), `system` — the
   * system records.
   */
  readonly takenNames: {
    readonly own: readonly string[];
    readonly system: readonly string[];
  };
  readonly choices: SaveChoices;
}

/**
 * The part of the record a refusal is about (deep-agents KD-4): the path of the field, such as `name`,
 * `servers` or `subagents.1.servers`, and the values in it that broke the rule.
 */
export interface RefusedField {
  readonly path: string;
  readonly values: readonly string[];
}

export type SaveDecision =
  | { readonly kind: 'allowed' }
  | ({
      readonly kind: 'name_taken';
      readonly reason: RecordNameTakenReason;
    } & RefusedField)
  | ({
      readonly kind: 'refused';
      readonly reason: LibraryRejectReason;
    } & RefusedField);

/**
 * Whether the author may save the record (KD-4, Flow 1; DC-8–DC-10, AC-06.1, AC-06.2, AC-07.1–AC-07.3).
 * Only what the author added is checked against their choices: a server they lost stays in the record.
 * The model is checked whole, and only when the employee has an allowed model at all. Rights stay
 * with `AccessGate` at every call; this keeps the record in step with the editor. A refusal names the
 * first part of the record that breaks the rule and the values that break it.
 */
export function decideSave(input: SaveInput): SaveDecision {
  const nameTaken = takenNameReason(input);
  if (nameTaken)
    return {
      kind: 'name_taken',
      reason: nameTaken,
      path: 'name',
      values: [input.name],
    };
  const refused = contentRefusal(input);
  if (refused) return { kind: 'refused', ...refused };
  return { kind: 'allowed' };
}

type ContentRefusal = { readonly reason: LibraryRejectReason } & RefusedField;

function takenNameReason({
  name,
  previous,
  takenNames,
  choices,
}: SaveInput): RecordNameTakenReason | null {
  // `fork` names the fork of `start_agent`, never a record (data-model design-agents.md, «Таблицы каталога»):
  // it is taken as a system name is, whatever the record was named before.
  if (isNameTaken(name, [FORK_AGENT]))
    return choices.scope === 'system' ? 'own' : 'system';
  // An admin's own names are the system records' (design-library.md, RECORD_NAME_TAKEN).
  if (choices.scope === 'system')
    return isNameTaken(name, takenNames.system) ? 'own' : null;
  if (isNameTaken(name, takenNames.own)) return 'own';
  // A system record may take an employee's name later; the employee keeps it until they rename (DC-8).
  const renamed =
    previous === null || previous.name.toLowerCase() !== name.toLowerCase();
  return renamed && isNameTaken(name, takenNames.system) ? 'system' : null;
}

function contentRefusal({
  body,
  previous,
  choices,
}: SaveInput): ContentRefusal | null {
  // Only a catalogue deep agent learns: a default agent's version also runs temporary agents (self-learning KD-4).
  if (
    previous !== null &&
    previous.builtinKey !== null &&
    body.kind === 'deep_agent' &&
    body.content.selfLearning
  )
    return { reason: 'builtin', path: 'selfLearning', values: [] };
  const parts = contentParts(body);
  const previousParts = previous ? contentParts(previous.body) : [];
  const keptServers = new Set(previousParts.flatMap((part) => part.servers));
  // A `null` model is not checked: the start checks the default chat model (KD-5).
  const keptModels = new Set(chosenModels(previousParts));

  const serverRefusal =
    choices.scope === 'employee'
      ? (refusedIn(
          parts,
          'servers',
          'all_servers_not_allowed',
          (server) => server === ALL_SERVERS,
        ) ??
        refusedIn(
          parts,
          'servers',
          'server_not_allowed',
          outside(keptServers, choices.usableServers),
        ))
      : refusedIn(
          parts,
          'servers',
          'server_not_allowed',
          outside(keptServers, [...choices.registryServers, ALL_SERVERS]),
        );
  if (serverRefusal) return serverRefusal;

  const modelRefusal = refusedIn(
    parts,
    'model',
    'model_not_allowed',
    modelBreaks(choices, keptModels),
  );
  if (modelRefusal) return modelRefusal;

  const keptAgents = new Set(previous ? contentAgents(previous.body) : []);
  const hiddenAgents = contentAgents(body).filter(
    outside(keptAgents, choices.visibleAgentIds),
  );
  return hiddenAgents.length > 0
    ? { reason: 'agent_not_visible', path: 'agents', values: hiddenAgents }
    : null;
}

/**
 * An employee's model is checked whole, and only while some model is allowed to him; an admin's only
 * when it was not in the record before.
 */
function modelBreaks(
  choices: SaveChoices,
  keptModels: ReadonlySet<string>,
): (model: string) => boolean {
  if (choices.scope === 'system')
    return outside(keptModels, choices.catalogueModels);
  if (choices.allowedModels.length === 0) return () => false;
  return outside(new Set(), choices.allowedModels);
}

/** A value that was not in the record before and is not among the allowed ones. */
function outside(
  kept: ReadonlySet<string>,
  allowed: readonly string[],
): (value: string) => boolean {
  const permitted = new Set(allowed);
  return (value) => !kept.has(value) && !permitted.has(value);
}

/** The first part whose `field` holds a value `breaks` the rule, with those values; `null` when none. */
function refusedIn(
  parts: readonly ContentPart[],
  field: 'servers' | 'model',
  reason: LibraryRejectReason,
  breaks: (value: string) => boolean,
): ContentRefusal | null {
  for (const part of parts) {
    const values = field === 'servers' ? part.servers : chosenModels([part]);
    const broken = values.filter(breaks);
    if (broken.length > 0)
      return { reason, path: fieldPath(part, field), values: broken };
  }
  return null;
}

function chosenModels(parts: readonly ContentPart[]): string[] {
  return parts.flatMap((part) => (part.model === null ? [] : [part.model]));
}

/**
 * Whether an agent may be deleted (AC-12.2): a default agent never (data-model design-agents.md, KD-4,
 * DC-22), every other one by whoever may change it.
 */
export function decideDelete(agent: {
  readonly builtinKey: string | null;
}):
  | { readonly kind: 'allowed' }
  | { readonly kind: 'refused'; readonly reason: 'builtin' } {
  return agent.builtinKey === null
    ? { kind: 'allowed' }
    : { kind: 'refused', reason: 'builtin' };
}
