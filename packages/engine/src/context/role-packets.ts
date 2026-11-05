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

/** The material of a worker: its own subquestion and its own evidence, nothing else (AC-05.2). */
export interface WorkerMaterial {
  readonly subquestion: string;
  readonly evidence: readonly EvidenceItem[];
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
 * The controller input split as in C3. `mandatory` — plan revision, budget, admissible decisions, unread
 * signals, and the tasks and claim revisions that appeared or changed status since the previous step;
 * the controller handler assembles it. `taskCounts` go with it; `claims` are compressible.
 */
export interface ControllerMaterial {
  readonly mandatory: Readonly<Record<string, unknown>>;
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

export function workerSlots(material: WorkerMaterial): RoleSlots {
  return { assignment: material.subquestion, evidence: material.evidence };
}

/** Earlier claims in packing order: newest revision first. */
export function newestFirst(claims: readonly ClaimLine[]): ClaimLine[] {
  return [...claims].sort((left, right) => right.revisedAt.getTime() - left.revisedAt.getTime());
}

/** The controller message with the mandatory part and the first `claims` of the compressible part. */
export function controllerMessages(
  material: ControllerMaterial,
  claims: readonly ClaimLine[],
): RoleMessage[] {
  const sections = [
    `<decision_input>\n${JSON.stringify(material.mandatory)}\n</decision_input>`,
    `<task_counts>\n${JSON.stringify(material.taskCounts)}\n</task_counts>`,
  ];
  if (claims.length > 0) {
    const lines = claims.map(
      (claim) => `${claim.claimId} [${claim.status}] ${claim.text.slice(0, CLAIM_LINE_TEXT_CHARS)}`,
    );
    sections.push(`<earlier_claims>\n${lines.join('\n')}\n</earlier_claims>`);
  }
  return [{ role: 'user', content: sections.join('\n') }];
}
