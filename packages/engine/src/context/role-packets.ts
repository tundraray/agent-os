import type { RoleMessage } from '../model/token-counter.js';

/** One evidence record as a role reads it; the text is mandatory material and is never cut. */
export interface EvidenceItem {
  readonly evidenceId: string;
  readonly text: string;
}

/** The slots of a role packet besides the instructions, which travel as `system`. */
export interface RoleSlots {
  readonly assignment: string;
  readonly summary?: string;
  readonly evidence: readonly EvidenceItem[];
}

/** A page of records as the worker reads it: its evidence id and its records in the order of the page's `items`. */
export interface EvidencePage {
  readonly evidenceId: string;
  readonly records: readonly unknown[];
}

/** The material of a worker: its own subquestion and its own pages, nothing else (AC-05.2). */
export interface WorkerMaterial {
  readonly subquestion: string;
  readonly pages: readonly EvidencePage[];
}

/** Tasks outside the mandatory part, reduced to a count per type, status and failure reason (C3). */
export interface TaskCount {
  readonly type: string;
  readonly status: string;
  readonly failureReason: string | null;
  readonly count: number;
}

/** A claim outside the mandatory part, reduced to one line: `claimId`, status and the start of its text. */
export interface ClaimLine {
  readonly claimId: string;
  readonly status: string;
  readonly text: string;
  /** When its latest revision was written; earlier claims are packed newest first. */
  readonly revisedAt: Date;
}

/**
 * The start of the controller input that stays the same for the whole investigation between two plan revisions
 * (invariant 7): the source tools, then the current plan revision. It goes first and ends at the cache mark (KD-6).
 */
export interface StableControllerBlock {
  readonly tools: readonly unknown[];
  readonly planRevision: Readonly<Record<string, unknown>>;
}

/** A rejected attempt of the current step as the retry sees it: the kind the model named, or null, and the code's reason. */
export interface RejectedAttempt {
  readonly kind: string | null;
  readonly reason: string;
}

/**
 * The controller input split as in C3 and KD-6. `stable` goes first, under the cache mark. The changing block follows:
 * `changing` — budget, admissible decisions, unread signals and the observations of what appeared or changed since the
 * previous step — then the rejected attempts of this step, the task counts, and the compressible earlier `claims`.
 * Everything but `claims` is mandatory; the controller handler assembles it.
 */
export interface ControllerMaterial {
  readonly stable: StableControllerBlock;
  readonly changing: Readonly<Record<string, unknown>>;
  /** Empty on the first attempt of a step. */
  readonly rejectedAttempts: readonly RejectedAttempt[];
  readonly taskCounts: readonly TaskCount[];
  readonly claims: readonly ClaimLine[];
}

/** How much of a compressible claim's text its line carries. */
const CLAIM_LINE_TEXT_CHARS = 160;

export function slotMessages(slots: RoleSlots): RoleMessage[] {
  const sections = [`<assignment>\n${slots.assignment}\n</assignment>`];
  if (slots.summary !== undefined) {
    sections.push(`<summary>\n${slots.summary}\n</summary>`);
  }
  for (const item of slots.evidence) {
    sections.push(`<evidence id="${item.evidenceId}">\n${item.text}\n</evidence>`);
  }
  return [{ role: 'user', content: sections.join('\n') }];
}

/** A page's records, each numbered by its position from 0 — the numbers a claim's pointer names (KD-1). */
function numberedRecords(page: EvidencePage): EvidenceItem {
  const lines = page.records.map((record, number) => `<record number="${number}">${JSON.stringify(record)}</record>`);
  return { evidenceId: page.evidenceId, text: lines.join('\n') };
}

export function workerSlots(material: WorkerMaterial): RoleSlots {
  return { assignment: material.subquestion, evidence: material.pages.map(numberedRecords) };
}

/** Earlier claims in packing order: newest revision first. */
export function newestFirst(claims: readonly ClaimLine[]): ClaimLine[] {
  return [...claims].sort((left, right) => right.revisedAt.getTime() - left.revisedAt.getTime());
}

/**
 * The stable block of the controller input. It is built from the block's values alone, so equal tools and plan revision
 * give equal bytes on every step.
 */
function stableBlockMessage(stable: StableControllerBlock): RoleMessage {
  const content = [
    `<tools>\n${JSON.stringify(stable.tools)}\n</tools>`,
    `<plan_revision>\n${JSON.stringify(stable.planRevision)}\n</plan_revision>`,
  ].join('\n');
  return { role: 'user', content, cacheMark: true };
}

/**
 * The controller messages (KD-6): the stable block with the cache mark, then the changing block with the mandatory part
 * and the first `claims` of the compressible part. Two user messages in a row reach the provider as one turn of two
 * blocks, so the mark ends the first block and everything after it changes freely.
 */
export function controllerMessages(
  material: ControllerMaterial,
  claims: readonly ClaimLine[],
): RoleMessage[] {
  const decisionInput = { ...material.changing, rejectedAttempts: material.rejectedAttempts };
  const sections = [
    `<decision_input>\n${JSON.stringify(decisionInput)}\n</decision_input>`,
    `<task_counts>\n${JSON.stringify(material.taskCounts)}\n</task_counts>`,
  ];
  if (claims.length > 0) {
    const lines = claims.map(
      (claim) => `${claim.claimId} [${claim.status}] ${claim.text.slice(0, CLAIM_LINE_TEXT_CHARS)}`,
    );
    sections.push(`<earlier_claims>\n${lines.join('\n')}\n</earlier_claims>`);
  }
  return [stableBlockMessage(material.stable), { role: 'user', content: sections.join('\n') }];
}
