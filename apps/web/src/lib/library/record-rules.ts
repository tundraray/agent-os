import {
  CHAT_BUILTIN_KEY,
  type AgentContent,
  type DraftView,
  type RecordBody,
  type RecordSummary,
  type RunOrigin,
  type WorkflowContent,
  type WorkflowExecutor,
} from '@agent-os/contracts';

/**
 * Rules of the web (design-web.md, «Правила веба»): pure decisions over data the caller has already
 * read. A live record is `undefined` while the library list is not read and `null` when the read list
 * has no such record; every rule below treats both as "no record".
 */
type LiveRecord<K extends keyof RecordSummary> = Pick<RecordSummary, K> | null | undefined;

/** «Использовать в чате» (AC-26.2, RV-01). */
export function canUseInChat(
  record: Pick<RecordSummary, 'builtinKey' | 'mine' | 'offerInChat' | 'missingRights'>,
): boolean {
  if (record.builtinKey === CHAT_BUILTIN_KEY) return false;
  if (!record.mine && !record.offerInChat) return false;
  return !record.missingRights.some((right) => right.executor === null && Boolean(right.model));
}

/** «Изменён после запуска» (AC-28.1): `live` is the record `origin.recordId` in the library list. */
export function changedAfterRun(origin: Pick<RunOrigin, 'version'>, live: LiveRecord<'version'>): boolean {
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
  if (!firstRun || live == null || live.mine || live.author === null) return null;
  return { roles: live.audience.roles.filter((role) => role.member).map((role) => role.name) };
}

/** DC-01 «Устарел»: a pending edit draft whose record moved on after it, or whose save hit a conflict. */
export function isDraftStale(
  draft: Pick<DraftView, 'state' | 'recordId' | 'baseVersion' | 'refusal'>,
  live: LiveRecord<'version'>,
): boolean {
  if (draft.state !== 'pending' || draft.recordId === null || draft.baseVersion === null) return false;
  if (draft.refusal === 'version_conflict') return true;
  return live != null && live.version > draft.baseVersion;
}

/** Reads a record of the library list by id (`libraryIndex.summaryOf`). */
export type SummaryLookup = { summaryOf(recordId: string): LiveRecord<'name'> };

/** Title of a workflow task card (MC-21): «Задание · {имя}», or «Задание» while the record is unknown. */
export function taskTitleName(workflowId: string | null | undefined, index: SummaryLookup): string {
  const live = workflowId ? index.summaryOf(workflowId) : null;
  return live == null ? 'Задание' : `Задание · ${live.name}`;
}

/** «{имя} 2», «{имя} 3», … — the first not among the owner's names; names compare without case, as the server does. */
export function freeName(name: string, ownNames: readonly string[]): string {
  const taken = new Set(ownNames.map((own) => own.toLowerCase()));
  for (let n = 2; ; n += 1) {
    const candidate = `${name} ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/**
 * Form labels of a record's fields (MC-7, MC-12): the editor, the conflict block (MC-10) and the draft
 * card (MC-15) name changed fields by them. The platform tools of an agent have no form field.
 */
export const RECORD_FIELD_LABELS = {
  name: 'Имя',
  description: 'Описание',
  prompt: 'Инструкция',
  servers: 'Системы',
  model: 'Модель',
  maxTurns: 'Максимум шагов',
  agents: 'Может запускать',
  rules: 'Как работает команда',
  finalExecutor: 'Кто пишет ответ',
  selfLearning: 'Самообучение',
  coordinatorModel: 'Модель координатора',
  coordinatorMaxTurns: 'Максимум шагов координатора',
} as const;
export type RecordField = keyof typeof RECORD_FIELD_LABELS;

/** A changed field; an executor is one unit, named as its panel is (MC-13 «Исполнитель «{имя}»»). */
export type ChangedField =
  | { field: RecordField; label: string }
  | { field: 'executor'; executor: string; label: string };

/** A record's definition as the form, a saved record and a draft hold it. */
export type RecordDefinition = { readonly name: string; readonly description: string } & RecordBody;

/** Only the definition of a saved record or a draft, as the form holds it. */
export function definitionOf(record: RecordDefinition): RecordDefinition {
  const { name, description } = record;
  return record.kind === 'agent'
    ? { name, description, kind: 'agent', content: record.content }
    : { name, description, kind: 'workflow', content: record.content };
}

/** Fields that differ between two definitions, in form order; equal definitions give an empty list. */
export function changedFields(before: RecordDefinition, after: RecordDefinition): ChangedField[] {
  const changed: ChangedField[] = [];
  if (before.name !== after.name) changed.push(fieldOf('name'));
  if (before.description !== after.description) changed.push(fieldOf('description'));
  if (after.kind === 'agent') {
    const previous = before.kind === 'agent' ? before.content : null;
    changed.push(...agentChanges(previous, after.content));
  } else {
    const previous = before.kind === 'workflow' ? before.content : null;
    changed.push(...workflowChanges(previous, after.content));
  }
  return changed;
}

function fieldOf(field: RecordField): ChangedField {
  return { field, label: RECORD_FIELD_LABELS[field] };
}

function executorOf(name: string): ChangedField {
  return { field: 'executor', executor: name, label: `Исполнитель «${name}»` };
}

/** `previous` `null` — the other definition is of another kind, so every field counts as changed. */
function agentChanges(previous: AgentContent | null, next: AgentContent): ChangedField[] {
  const checks: [RecordField, boolean][] = [
    ['prompt', previous?.prompt === next.prompt],
    ['servers', previous !== null && sameSet(previous.servers, next.servers)],
    ['model', previous?.model === next.model],
    ['maxTurns', previous?.maxTurns === next.maxTurns],
    ['agents', previous !== null && sameSet(previous.agents, next.agents)],
  ];
  return checks.filter(([, same]) => !same).map(([field]) => fieldOf(field));
}

function workflowChanges(previous: WorkflowContent | null, next: WorkflowContent): ChangedField[] {
  const before = new Map((previous?.executors ?? []).map((executor) => [executor.name, executor]));
  const after = new Map(next.executors.map((executor) => [executor.name, executor]));
  const executors = [
    ...next.executors.filter((executor) => {
      const old = before.get(executor.name);
      return old === undefined || !sameExecutor(old, executor);
    }),
    ...(previous?.executors ?? []).filter((executor) => !after.has(executor.name)),
  ].map((executor) => executorOf(executor.name));

  const checks: [RecordField, boolean][] = [
    ['rules', previous?.coordinator.rules === next.coordinator.rules],
    ['finalExecutor', previous !== null && previous.finalExecutor === next.finalExecutor],
    ['selfLearning', previous?.selfLearning === next.selfLearning],
    ['coordinatorModel', previous?.coordinator.model === next.coordinator.model],
    ['coordinatorMaxTurns', previous?.coordinator.maxTurns === next.coordinator.maxTurns],
  ];
  return [...executors, ...checks.filter(([, same]) => !same).map(([field]) => fieldOf(field))];
}

function sameExecutor(a: WorkflowExecutor, b: WorkflowExecutor): boolean {
  return (
    a.role === b.role &&
    a.prompt === b.prompt &&
    a.model === b.model &&
    a.maxTurns === b.maxTurns &&
    a.maxRuns === b.maxRuns &&
    sameSet(a.servers, b.servers) &&
    sameSet(a.tools, b.tools) &&
    a.source?.recordId === b.source?.recordId &&
    a.source?.version === b.source?.version
  );
}

/** Server and agent lists are choices, not sequences: the order they were ticked in is no change. */
function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  return left.size === new Set(b).size && b.every((value) => left.has(value));
}
