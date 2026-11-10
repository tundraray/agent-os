import type { AtomCheck } from './check-atoms.js';

/**
 * A page of records the checker reads: where it came from and its records. The same shape as
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

/**
 * The check packet of one claim (DC-14), the first message of the checker agent's run and the packet calibration
 * measures: the claim as JSON in `<claim>` — its text and its atoms, each with its kind,
 * value, verdict of `checkAtoms` and the numbers of the records it was found in — then the `<data>` section, where each
 * page is a JSON line with its source, tool, arguments, snapshot and completeness, followed by its records, each a JSON
 * object with its number. Numbers run from zero across all pages, so each names one record of the input.
 */
export function buildClaimCheck({ claimText, atomCheck, pages }: ClaimCheckInput): string {
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
  return ['<claim>', sectionLine({ text: claimText, atoms }), '</claim>', '<data>', ...data, '</data>'].join('\n');
}
