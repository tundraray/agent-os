import {
  ALL_SERVERS,
  type LibraryRejectReason,
  type RecordBody,
  type RecordNameTakenReason,
} from '@agent-os/contracts';
import {
  contentParts,
  isNameTaken,
  type ContentPart,
} from './record-content.js';

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

export type SaveDecision =
  | { readonly kind: 'allowed' }
  | { readonly kind: 'name_taken'; readonly reason: RecordNameTakenReason }
  | { readonly kind: 'refused'; readonly reason: LibraryRejectReason };

/**
 * Whether the author may save the record (KD-4, Flow 1; DC-8–DC-10, AC-06.1, AC-06.2, AC-07.1–AC-07.3).
 * Only what the author added is checked against their choices: a server they lost stays in the record.
 * The model is checked whole, and only when the employee has an allowed model at all. Rights stay
 * with `AccessGate` at every call; this keeps the record in step with the editor.
 */
export function decideSave(input: SaveInput): SaveDecision {
  const nameTaken = takenNameReason(input);
  if (nameTaken) return { kind: 'name_taken', reason: nameTaken };
  const refused = contentRefusal(input);
  if (refused) return { kind: 'refused', reason: refused };
  return { kind: 'allowed' };
}

function takenNameReason({
  name,
  previous,
  takenNames,
  choices,
}: SaveInput): RecordNameTakenReason | null {
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
}: SaveInput): LibraryRejectReason | null {
  const parts = contentParts(body);
  const previousParts = previous ? contentParts(previous.body) : [];
  const servers = parts.flatMap((part) => part.servers);
  const addedServers = added(
    servers,
    previousParts.flatMap((part) => part.servers),
  );
  // A `null` model is not checked: the start checks the default chat model (KD-5).
  const models = chosenModels(parts);

  if (choices.scope === 'employee') {
    if (servers.includes(ALL_SERVERS)) return 'all_servers_not_allowed';
    if (!within(addedServers, choices.usableServers))
      return 'server_not_allowed';
    const { allowedModels } = choices;
    if (allowedModels.length > 0 && !within(models, allowedModels))
      return 'model_not_allowed';
  } else {
    if (!within(addedServers, [...choices.registryServers, ALL_SERVERS]))
      return 'server_not_allowed';
    const addedModels = added(models, chosenModels(previousParts));
    if (!within(addedModels, choices.catalogueModels))
      return 'model_not_allowed';
  }

  const addedAgents = added(
    contentAgents(body),
    previous ? contentAgents(previous.body) : [],
  );
  if (!within(addedAgents, choices.visibleAgentIds)) return 'agent_not_visible';
  return null;
}

function chosenModels(parts: readonly ContentPart[]): string[] {
  return parts.flatMap((part) => (part.model === null ? [] : [part.model]));
}

function added(values: readonly string[], before: readonly string[]): string[] {
  const kept = new Set(before);
  return values.filter((value) => !kept.has(value));
}

function within(
  values: readonly string[],
  allowed: readonly string[],
): boolean {
  const set = new Set(allowed);
  return values.every((value) => set.has(value));
}
