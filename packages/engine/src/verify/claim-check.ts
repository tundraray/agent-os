import type { ProcessConfig } from '../config/process-config.schema.js';
import type { RoleMessage } from '../model/token-counter.js';
import { ClaimAssessmentSchema } from './claim-assessment.js';
import type { AtomCheck } from './check-atoms.js';

/**
 * A page of records the verifier call reads: where it came from and its records. The same shape as
 * `CalibrationPair.pages` of `@agent-os/mcp-fixture`, so calibration passes its pages as they are; in an investigation
 * the records are the ones the pointer names on that page, in pointer order.
 */
export interface ClaimCheckPage {
  readonly source: string;
  readonly tool: string;
  /** The request arguments with every default filled in. */
  readonly args: Readonly<Record<string, unknown>>;
  readonly snapshot: string;
  readonly complete: boolean;
  readonly records: readonly unknown[];
}

export interface ClaimCheckInput {
  readonly roleConfig: Pick<ProcessConfig['roles']['verifier'], 'prompt'>;
  readonly claimText: string;
  /** The atom check over the same records, numbered as here: its atoms go into `<claim>` as evidence. */
  readonly atomCheck: AtomCheck;
  readonly pages: readonly ClaimCheckPage[];
}

/**
 * One JSON line of a section. Angle brackets are escaped (`\u003c`, `\u003e`), so a string of a record or of the claim
 * cannot write a tag such as `</data>` into the message; the line stays the same JSON.
 */
function sectionLine(value: unknown): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e');
}

/** The packet of one verifier call. */
export interface ClaimCheck {
  readonly instructions: string;
  readonly messages: RoleMessage[];
  readonly outputSchema: typeof ClaimAssessmentSchema;
}

/**
 * The input of the verifier call for one claim (DC-14). The instructions are the role's prompt template unchanged —
 * the version 2 template has no fields, so the prompt version of the call is that of the role. The claim text and the
 * records travel only in the message: the claim as JSON in `<claim>` — its text and its atoms, each with its kind,
 * value, verdict of `checkAtoms` and the numbers of the records it was found in — then the `<data>` section, where each
 * page is a JSON line with its source, tool, arguments, snapshot and completeness, followed by its records, each a JSON
 * object with its number. Numbers run from zero across all pages, so each names one record of the input.
 */
export function buildClaimCheck({ roleConfig, claimText, atomCheck, pages }: ClaimCheckInput): ClaimCheck {
  const data: string[] = [];
  let number = 0;
  for (const { records, source, tool, args, snapshot, complete } of pages) {
    data.push(sectionLine({ page: { source, tool, args, snapshot, complete } }));
    for (const record of records) {
      data.push(sectionLine({ number, record }));
      number += 1;
    }
  }
  const atoms = atomCheck.atoms.map(({ kind, value, verdict, records }) => ({ kind, value, verdict, records }));
  const content = ['<claim>', sectionLine({ text: claimText, atoms }), '</claim>', '<data>', ...data, '</data>'].join('\n');
  return { instructions: roleConfig.prompt, messages: [{ role: 'user', content }], outputSchema: ClaimAssessmentSchema };
}
