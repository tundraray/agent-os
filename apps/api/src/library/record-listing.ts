import type { RecordBody, RecordKind } from '@agent-os/contracts';
import type { LibraryRecord } from './library.repository';
import { hasHolders } from './record-view';

/**
 * The texts the main chat reads from `list_records` and `read_record` (deep-agents design-agent-types.md,
 * «Инструменты записей», DC-7; pure-decision.md): pure functions over what `LibraryService` and
 * `Agents.mcp` read for the employee. Nothing here decides who sees what: the records are the ones the
 * library let through, the servers the ones the employee may use with the tools he has a right to.
 */

/** Whose a record is to the employee: his own, another employee's opened to his role, or a system one. */
export type RecordOwnership = 'own' | 'role' | 'system';

/** A record as the chat reads it: the header, whose it is, whether it is shared, and its content. */
export interface ChatRecord {
  readonly id: string;
  readonly kind: RecordKind;
  readonly name: string;
  readonly description: string;
  readonly version: number;
  readonly ownership: RecordOwnership;
  /** The record has at least one holder. */
  readonly shared: boolean;
  readonly body: RecordBody;
}

/** A server the employee may use and the names of its tools he has a right to call. */
export interface UsableServer {
  readonly server: string;
  readonly tools: readonly string[];
}

/** Upper bound of a `list_records` answer, so dozens of servers do not eat the chat's context (Risks). */
const RECORD_LIST_MAX_CHARS = 16_000;

const OWNERSHIP_LABELS: Record<RecordOwnership, string> = {
  own: 'yours',
  role: 'opened to your role',
  system: 'system',
};

/** The chat's reading of a stored record the employee may see. */
export function chatRecordOf(record: LibraryRecord, viewerId: string): ChatRecord {
  return {
    id: record.id,
    kind: record.body.kind,
    name: record.name,
    description: record.description,
    version: record.version,
    ownership: ownershipOf(record.ownerId, viewerId),
    shared: hasHolders(record),
    body: record.body,
  };
}

function ownershipOf(ownerId: string | null, viewerId: string): RecordOwnership {
  if (ownerId === null) return 'system';
  return ownerId === viewerId ? 'own' : 'role';
}

/** A description may hold line breaks; in a list it stays on its record's line. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function sharingLabel(shared: boolean): string {
  return shared ? 'shared' : 'not shared';
}

/**
 * The answer of `list_records`: one line per record (id, kind, name, whose, shared or not, description),
 * then the servers the employee may use with the tools he has a right to call — a server without such a
 * tool is not named. Past `maxChars` the lines stop and a note says how many were left out.
 */
export function recordListText(
  records: readonly ChatRecord[],
  servers: readonly UsableServer[],
  maxChars: number = RECORD_LIST_MAX_CHARS,
): string {
  const named = servers.filter((server) => server.tools.length > 0);
  const lines = [
    records.length === 0
      ? 'You see no library records.'
      : 'Library records you see (id | kind | name | whose | sharing | description):',
    ...records.map(
      (record) =>
        `- ${record.id} | ${record.kind} | ${record.name} | ${OWNERSHIP_LABELS[record.ownership]} | ${sharingLabel(record.shared)} | ${oneLine(record.description)}`,
    ),
    '',
    named.length === 0
      ? 'You may use no MCP server.'
      : 'MCP servers you may use, with the tools you have the right to call (give each subagent only the servers it needs):',
    ...named.map((server) => `- ${server.server}: ${server.tools.join(', ')}`),
  ];
  return cutLines(lines, maxChars);
}

/** The lines that fit into `maxChars` with the note of the cut, or all of them. */
function cutLines(lines: readonly string[], maxChars: number): string {
  const whole = lines.join('\n');
  if (whole.length <= maxChars) return whole;
  const kept: string[] = [];
  let length = 0;
  for (const line of lines) {
    if (length + line.length + 1 > maxChars) break;
    kept.push(line);
    length += line.length + 1;
  }
  const left = lines.length - kept.length;
  return `${kept.join('\n')}\n[cut: ${left} more lines are not shown, the answer is limited to ${maxChars} characters]`;
}

/**
 * The answer of `read_record`: the whole definition of a record the employee sees — its header, whose it
 * is, its version and its content. The self-learning flag stands on its own line: only a person changes
 * it, so the content an edit sends back holds no flag. The task-list flags (`taskList` of the agent, the deep
 * agent and each subagent; design-task-list.md KD-2) stay in the content: the chat may change them, and an
 * edit that sends the content back keeps them.
 */
export function recordText(record: ChatRecord): string {
  const { selfLearning, content } = splitFlag(record.body);
  return [
    `Record ${record.id}`,
    `kind: ${record.kind}`,
    `name: ${record.name}`,
    `description: ${record.description}`,
    `version: ${record.version}`,
    `whose: ${OWNERSHIP_LABELS[record.ownership]}`,
    `sharing: ${sharingLabel(record.shared)}`,
    ...(selfLearning === null
      ? []
      : [`selfLearning: ${selfLearning} (only a person changes it, on the record's card)`]),
    `content: ${JSON.stringify(content)}`,
  ].join('\n');
}

function splitFlag(body: RecordBody): { selfLearning: boolean | null; content: object } {
  if (body.kind === 'agent') return { selfLearning: null, content: body.content };
  const { selfLearning, ...content } = body.content;
  return { selfLearning, content };
}
