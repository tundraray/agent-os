import { createHash } from 'node:crypto';
import {
  DEDUP_KEY_PREFIX,
  type InputRef,
  type TaskSpec,
} from '@agent-os/contracts';

/** The fields of a `TaskSpec` that identify the same request. */
export type DedupKeySource = Pick<
  TaskSpec,
  'workflowType' | 'workflowVersion' | 'input' | 'expectedOutput' | 'inputRefs'
>;

/** Code-unit order: independent of the locale, the same on every instance. */
const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

/** By `kind`, then `ref`; `snapshot` only breaks the remaining ties, so the order is total. */
const compareInputRefs = (left: InputRef, right: InputRef): number =>
  compareText(left.kind, right.kind) ||
  compareText(left.ref, right.ref) ||
  compareText(left.snapshot, right.snapshot);

/** JSON with the keys of every object sorted recursively; arrays keep their order. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const members = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
    return `{${members.join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * `dedup_key` of a task (design-runtime.md, TaskSpec): `v1:` and the hex sha256 of the canonical
 * JSON of `workflowType`, `workflowVersion`, `input`, `expectedOutput` and `inputRefs` ordered by
 * `kind` and `ref` (AC-06.3). A change of this rule must change the version prefix.
 */
export function computeDedupKey(source: DedupKeySource): string {
  const canonical = canonicalJson({
    workflowType: source.workflowType,
    workflowVersion: source.workflowVersion,
    input: source.input,
    expectedOutput: source.expectedOutput,
    inputRefs: [...source.inputRefs].sort(compareInputRefs),
  });
  const digest = createHash('sha256').update(canonical).digest('hex');
  return `${DEDUP_KEY_PREFIX}${digest}`;
}
