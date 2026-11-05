import { createHash } from 'node:crypto';
import type { TaskSpec } from '@agent-os/contracts';
import type { Decision } from '../controller/decision.schema.js';

export const SOURCE_FETCH_WORKFLOW = 'source.fetch';
/** Kind of the input reference that pins the source's snapshot; `source.fetch` fails `snapshot_pin_missing` without it. */
const SOURCE_REF_KIND = 'source';

/** An accepted `requestEvidence` decision: the request of one gather task. */
export type GatherRequest = Extract<Decision, { kind: 'requestEvidence' }>;

/** The fields of a `source.fetch` task that enter the runtime's dedup key, apart from the budget. */
export type GatherKeyFields = Pick<TaskSpec, 'workflowType' | 'workflowVersion' | 'input' | 'inputRefs' | 'expectedOutput'>;

/** The value with the keys of every object sorted (arrays keep their order); own properties only, `__proto__` included. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
  );
}

/**
 * The key half of a gather task (DC-4): `FetchInput` of the tool and its arguments, the snapshot pinned in the input
 * reference, and an expected output built by code from the tool and the arguments. Nothing else of the decision —
 * `rationale`, `evidenceIds`, `await` — reaches the task, and the arguments are in canonical key order, so the same
 * request with the same snapshot always has the same dedup key.
 */
export function gatherKeyFields(request: GatherRequest, snapshot: string): GatherKeyFields {
  // The arguments came in as JSON (the controller output), so their canonical form is a JSON object.
  const args = canonical(request.args) as TaskSpec['input'];
  // A digest keeps the description within its 2 000 characters whatever the size of the arguments.
  const argsDigest = createHash('sha256').update(JSON.stringify(args)).digest('hex');
  return {
    workflowType: SOURCE_FETCH_WORKFLOW,
    workflowVersion: 1,
    input: { sourceId: request.sourceId, toolName: request.toolName, args },
    inputRefs: [{ kind: SOURCE_REF_KIND, ref: request.sourceId, snapshot }],
    expectedOutput: {
      description: `Records of ${request.toolName} from ${request.sourceId} for the arguments with sha256 ${argsDigest}`,
      completeness: request.completeness,
    },
  };
}
