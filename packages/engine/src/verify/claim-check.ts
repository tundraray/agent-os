import type { ProcessConfig } from '../config/process-config.schema.js';
import type { RoleMessage } from '../model/token-counter.js';
import { ClaimAssessmentSchema } from './claim-assessment.js';

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
  readonly pages: readonly ClaimCheckPage[];
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
 * records travel only in the message: the claim as JSON in `<claim>`, then the `<data>` section, where each page is a
 * JSON line with its source, tool, arguments, snapshot and completeness, followed by its records, each a JSON object
 * with its number. Numbers run from zero across all pages, so each names one record of the input.
 */
export function buildClaimCheck({ roleConfig, claimText, pages }: ClaimCheckInput): ClaimCheck {
  const data: string[] = [];
  let number = 0;
  for (const { records, source, tool, args, snapshot, complete } of pages) {
    data.push(JSON.stringify({ page: { source, tool, args, snapshot, complete } }));
    for (const record of records) {
      data.push(JSON.stringify({ number, record }));
      number += 1;
    }
  }
  const content = ['<claim>', JSON.stringify({ text: claimText }), '</claim>', '<data>', ...data, '</data>'].join('\n');
  return { instructions: roleConfig.prompt, messages: [{ role: 'user', content }], outputSchema: ClaimAssessmentSchema };
}
