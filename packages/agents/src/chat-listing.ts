import { CHAT_BUILTIN_KEY, type RecordHeader } from '@agent-os/contracts';

/**
 * Characters the lines of the chat listing may take (design-runtime.md, Runtime settings). Names
 * always stay: past the budget only descriptions are dropped.
 */
export const CHAT_LISTING_BUDGET = 12_000;

/** The mark of the employee's own record in the listing (KD-4). */
const OWN_MARK = 'yours';
/** The mark of a system record, which has no author. */
const SYSTEM_MARK = 'system';

/**
 * Whether the main chat may offer and start the record (KD-4): the employee's own always, another's only
 * with «предлагать в главном чате»; the `chat` record itself never.
 */
export function inRootLaunchSet(header: RecordHeader): boolean {
  if (header.builtinKey === CHAT_BUILTIN_KEY) return false;
  return header.mine || header.offerInChat;
}

export interface ChatListingInput {
  /** The employee's `listVisible`. */
  readonly headers: readonly RecordHeader[];
  /** Sessions the employee started per record id; a record without a row counts 0. */
  readonly sessionCounts: ReadonlyMap<string, number>;
  readonly budget: number;
}

export interface ChatListing {
  /** Lines of the agents, for the description of `start_agent`. */
  readonly agents: readonly string[];
  /** Lines of the deep agents, for the description of the tool that starts one by a brief. */
  readonly deepAgents: readonly string[];
  /** Records whose line kept its description. */
  readonly described: number;
}

/**
 * A line of a tool description built from what employees typed (names, descriptions, roles): every run
 * of whitespace, line breaks included, becomes one space, so typed text never adds a line of its own —
 * a forged line with another record or the `yours` mark (design-runtime.md, Security Considerations).
 */
export function descriptionLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function whose(header: RecordHeader): string {
  if (header.mine) return OWN_MARK;
  return header.author === null ? SYSTEM_MARK : `by ${header.author.name}`;
}

/** A line of the listing (KD-4): id, name, whose record and, while the budget allows, the description. */
function line(header: RecordHeader, withDescription: boolean): string {
  const head = `${header.id}: ${header.name} (${whose(header)})`;
  return descriptionLine(
    withDescription ? `${head} — ${header.description}` : head,
  );
}

function byName(left: RecordHeader, right: RecordHeader): number {
  const leftName = left.name.toLowerCase();
  const rightName = right.name.toLowerCase();
  if (leftName !== rightName) return leftName < rightName ? -1 : 1;
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
}

/** Own records first, then the others; by name without case, then by id. */
function displayOrder(left: RecordHeader, right: RecordHeader): number {
  if (left.mine !== right.mine) return left.mine ? -1 : 1;
  return byName(left, right);
}

/**
 * The records the main chat may offer, as lines of its tools (KD-4; pure-decision.md). Past the budget,
 * descriptions are dropped one by one, first from the records the employee started fewer sessions
 * with; at an equal count by name without case, then by id. Names stay at any budget.
 */
export function chatListing({
  headers,
  sessionCounts,
  budget,
}: ChatListingInput): ChatListing {
  const offered = headers.filter(inRootLaunchSet).sort(displayOrder);
  const countOf = (header: RecordHeader): number =>
    sessionCounts.get(header.id) ?? 0;

  const described = new Set(offered.map((header) => header.id));
  let size = offered.reduce(
    (sum, header) => sum + line(header, true).length,
    0,
  );
  const dropOrder = [...offered].sort(
    (left, right) => countOf(left) - countOf(right) || byName(left, right),
  );
  for (const header of dropOrder) {
    if (size <= budget) break;
    size -= line(header, true).length - line(header, false).length;
    described.delete(header.id);
  }

  const linesOf = (kind: RecordHeader['kind']): string[] =>
    offered
      .filter((header) => header.kind === kind)
      .map((header) => line(header, described.has(header.id)));
  return {
    agents: linesOf('agent'),
    deepAgents: linesOf('deep_agent'),
    described: described.size,
  };
}
