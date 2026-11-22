import {
  CHAT_BUILTIN_KEY,
  type AgentContent,
  type DeepAgentContent,
  type RecordBody,
  type RecordDetail,
  type RecordSummary,
  type RunOrigin,
  type Subagent,
} from '@agent-os/contracts';
import type { LibraryTranslator } from '@/i18n/catalog';

/**
 * Rules of the web (design-web.md, «Правила веба»): pure decisions over data the caller has already
 * read. A live record is `undefined` while the library list is not read and `null` when the read list
 * has no such record; every rule below treats both as "no record".
 */
type LiveRecord<K extends keyof RecordSummary> =
  Pick<RecordSummary, K> | null | undefined;

/** «Использовать в чате» (AC-26.2, RV-01). */
export function canUseInChat(
  record: Pick<
    RecordSummary,
    'builtinKey' | 'mine' | 'offerInChat' | 'missingRights'
  >,
): boolean {
  if (record.builtinKey === CHAT_BUILTIN_KEY) return false;
  if (!record.mine && !record.offerInChat) return false;
  return !record.missingRights.some(
    (right) => right.subagent === null && Boolean(right.model),
  );
}

/** «Изменён после запуска» (AC-28.1): `live` is the record `origin.recordId` in the library list. */
export function changedAfterRun(
  origin: Pick<RunOrigin, 'version'>,
  live: LiveRecord<'version'>,
): boolean {
  return live != null && live.version > origin.version;
}

/** What the recipient's note names: the viewer's roles the colleague shared the record with. */
export type RecipientNote = { roles: string[] };

/**
 * «Пояснение получателю» (AC-29.1) on a colleague's record that is in the live list. The record page
 * shows it always (`firstRun` defaults to `true`); a run card passes its agent's `firstRun`.
 */
export function recipientNote(
  live: LiveRecord<'mine' | 'author' | 'audience'>,
  firstRun = true,
): RecipientNote | null {
  if (!firstRun || live == null || live.mine || live.author === null)
    return null;
  return {
    roles: live.audience.roles
      .filter((role) => role.member)
      .map((role) => role.name),
  };
}

/** Reads a record of the library list by id (`libraryIndex.summaryOf`). */
export type SummaryLookup = { summaryOf(recordId: string): LiveRecord<'name'> };

/** Title of a deep agent's brief card (MC-22): «Задание · {имя}», or «Задание» while the record is unknown. */
export function briefTitleName(
  t: LibraryTranslator,
  deepAgentId: string | null | undefined,
  index: SummaryLookup,
): string {
  const live = deepAgentId ? index.summaryOf(deepAgentId) : null;
  return live == null
    ? t('brief.title')
    : t('brief.titleNamed', { name: live.name });
}

/**
 * The fields of a definition (MC-7, MC-12, MC-27): an agent's form fields, and a deep agent's «Кто пишет ответ».
 * The editor, the conflict block (MC-10) and the «Правка» card (MC-24) name changed fields by them. The platform
 * tools of an agent have no field.
 */
export type RecordField =
  | 'name'
  | 'description'
  | 'prompt'
  | 'servers'
  | 'model'
  | 'maxTurns'
  | 'agents'
  | 'finalSubagent';

/** The fields of one subagent of a deep agent. */
export type SubagentField =
  'description' | 'prompt' | 'servers' | 'model' | 'maxTurns' | 'maxRuns';

/**
 * A changed field; a list field (servers, startable agents) names the entries the change removed. A subagent
 * is one unit, known by its name: changed (with its changed fields), new, or removed.
 */
export type ChangedField =
  | { field: RecordField; removed?: readonly string[] }
  | {
      field: 'subagent';
      subagent: string;
      change: 'changed';
      fields: readonly SubagentField[];
    }
  | { field: 'subagent'; subagent: string; change: 'new' | 'removed' };

const FIELD_LABEL = {
  name: 'fields.name',
  description: 'fields.description',
  prompt: 'fields.prompt',
  servers: 'fields.servers',
  model: 'fields.model',
  maxTurns: 'fields.maxTurns',
  agents: 'fields.agents',
  finalSubagent: 'definition.finalSubagent',
} as const satisfies Record<RecordField, string>;

/** The label a changed field is named by; a subagent by its name. */
export function changedFieldLabel(
  t: LibraryTranslator,
  changed: ChangedField,
): string {
  return changed.field === 'subagent'
    ? changed.subagent
    : t(FIELD_LABEL[changed.field]);
}

/** A record's definition: the editor's agent, or either kind on a record card. */
export type RecordDefinition = {
  readonly name: string;
  readonly description: string;
} & RecordBody;

/** An agent's definition as the editor's form holds it; a deep agent has no form (UXRD KD-1). */
export type AgentDefinition = {
  readonly name: string;
  readonly description: string;
  readonly kind: 'agent';
  readonly content: AgentContent;
};

/** A saved agent record: the only kind the editor opens. */
export type AgentRecord = Extract<RecordDetail, { kind: 'agent' }>;

/** Only the definition of a saved agent, as the form holds it. */
export function definitionOf({
  name,
  description,
  content,
}: AgentRecord): AgentDefinition {
  return { name, description, kind: 'agent', content };
}

/**
 * What differs between two definitions of one kind, in definition order; equal definitions give an empty list.
 * Definitions of different kinds never meet: a record never changes its kind.
 */
export function changedFields(
  before: RecordDefinition,
  after: RecordDefinition,
): ChangedField[] {
  const changed: ChangedField[] = [];
  if (before.name !== after.name) changed.push({ field: 'name' });
  if (before.description !== after.description)
    changed.push({ field: 'description' });
  if (before.kind === 'agent' && after.kind === 'agent')
    changed.push(...agentChanges(before.content, after.content));
  if (before.kind === 'deep_agent' && after.kind === 'deep_agent') {
    changed.push(...deepAgentChanges(before.content, after.content));
  }
  return changed;
}

function agentChanges(
  previous: AgentContent,
  next: AgentContent,
): ChangedField[] {
  return [
    ...scalarChanges([['prompt', previous.prompt === next.prompt]]),
    ...listChange('servers', previous.servers, next.servers),
    ...scalarChanges([
      ['model', previous.model === next.model],
      ['maxTurns', previous.maxTurns === next.maxTurns],
    ]),
    ...listChange('agents', previous.agents, next.agents),
  ];
}

function deepAgentChanges(
  previous: DeepAgentContent,
  next: DeepAgentContent,
): ChangedField[] {
  const before = new Map(
    previous.subagents.map((subagent) => [subagent.name, subagent]),
  );
  const after = new Set(next.subagents.map((subagent) => subagent.name));
  const subagents: ChangedField[] = [];
  for (const subagent of next.subagents) {
    const old = before.get(subagent.name);
    if (old === undefined) {
      subagents.push({
        field: 'subagent',
        subagent: subagent.name,
        change: 'new',
      });
      continue;
    }
    const fields = subagentChanges(old, subagent);
    if (fields.length > 0)
      subagents.push({
        field: 'subagent',
        subagent: subagent.name,
        change: 'changed',
        fields,
      });
  }
  for (const subagent of previous.subagents) {
    if (!after.has(subagent.name))
      subagents.push({
        field: 'subagent',
        subagent: subagent.name,
        change: 'removed',
      });
  }
  return [
    ...scalarChanges([['prompt', previous.prompt === next.prompt]]),
    ...listChange('servers', previous.servers, next.servers),
    ...subagents,
    ...scalarChanges([
      ['finalSubagent', previous.finalSubagent === next.finalSubagent],
      ['model', previous.model === next.model],
      ['maxTurns', previous.maxTurns === next.maxTurns],
    ]),
  ];
}

function subagentChanges(previous: Subagent, next: Subagent): SubagentField[] {
  const checks: [SubagentField, boolean][] = [
    ['description', previous.description === next.description],
    ['prompt', previous.prompt === next.prompt],
    ['servers', sameSet(previous.servers, next.servers)],
    ['model', previous.model === next.model],
    ['maxTurns', previous.maxTurns === next.maxTurns],
    ['maxRuns', previous.maxRuns === next.maxRuns],
  ];
  return checks.filter(([, same]) => !same).map(([field]) => field);
}

function scalarChanges(checks: [RecordField, boolean][]): ChangedField[] {
  return checks.filter(([, same]) => !same).map(([field]) => ({ field }));
}

/** A list field that differs, with the entries it lost; the order they were ticked in is no change. */
function listChange(
  field: RecordField,
  previous: readonly string[],
  next: readonly string[],
): ChangedField[] {
  if (sameSet(previous, next)) return [];
  const removed = previous.filter((value) => !next.includes(value));
  return [removed.length > 0 ? { field, removed } : { field }];
}

/** Server and agent lists are choices, not sequences: the order they were ticked in is no change. */
function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  return left.size === new Set(b).size && b.every((value) => left.has(value));
}
