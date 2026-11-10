import { researchEvidence, researchEvidenceContents } from '@agent-os/db';
import type { RuntimeTx } from '@agent-os/runtime';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { ToolRegistryEntry } from '../../agents/tool-registry.js';
import type { ImmediateTool } from '../../agents/tools/tool-context.js';
import { pointerPages, WorkerOutputSchema } from '../../claims/claim.schema.js';
import { claimsRepository } from '../../claims/claims.repository.js';
import { checkPointer, PageSchema } from '../../verify/pointer.js';

const ClaimsWriteArgsSchema = z.strictObject({ claims: WorkerOutputSchema.shape.claims.min(1).max(20) });
type ClaimsWriteArgs = z.infer<typeof ClaimsWriteArgsSchema>;

export const CLAIMS_WRITE_ENTRY: ToolRegistryEntry = {
  name: 'claims_write',
  description:
    'Writes 1 to 20 claims of this run, each with its text, its atoms and the pointer to the records it rests on. ' +
    'Returns the claim ids in the order of the call. When a pointer leads outside the records of this investigation, ' +
    'past the end of a page or to more than 20 records, nothing is written and the call is refused with the positions ' +
    'of such claims.',
  argsSchema: ClaimsWriteArgsSchema,
  effect: 'write',
  resultMaxBytes: 1_024,
};

/** How many records a stored page has; a content that is no page of records has none a pointer could name. */
function recordCount(bytes: Uint8Array): number | undefined {
  try {
    const page = PageSchema.safeParse(JSON.parse(Buffer.from(bytes).toString('utf8')));
    return page.success ? page.data.items.length : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The record count of each of `pageIds` that is a page of this investigation. An id of another investigation, an unknown
 * one and one that is no uuid (the model writes it; Postgres would refuse the whole transaction) are simply absent.
 */
async function ownPageSizes(tx: RuntimeTx, investigationId: string, pageIds: readonly string[]): Promise<Map<string, number>> {
  const ids = [...new Set(pageIds)].filter((id) => z.uuid().safeParse(id).success);
  if (ids.length === 0) return new Map();
  const pages = await tx
    .select({ pageId: researchEvidence.evidenceId, bytes: researchEvidenceContents.bytes })
    .from(researchEvidence)
    .innerJoin(researchEvidenceContents, eq(researchEvidenceContents.evidenceId, researchEvidence.evidenceId))
    .where(and(eq(researchEvidence.investigationId, investigationId), inArray(researchEvidence.evidenceId, ids)));
  const sizes = new Map<string, number>();
  for (const { pageId, bytes } of pages) {
    const size = recordCount(bytes);
    if (size !== undefined) sizes.set(pageId, size);
  }
  return sizes;
}

/**
 * `claims_write` (`write`, design-research-flow.md, DC-6): the first revisions, `unverified`, of the run's claims, written
 * in the call's guarded transaction together with its outcome. All or nothing: one wrong pointer refuses the call with
 * `pointer_invalid` and the positions of such claims. A run may call it many times: each call goes on from the run's last
 * claim number, since a revision is unique by its task and number.
 */
export const claimsWriteTool: ImmediateTool = {
  name: CLAIMS_WRITE_ENTRY.name,
  async run({ tx, run, args }) {
    const { claims } = args as ClaimsWriteArgs;
    const sizes = await ownPageSizes(
      tx,
      run.investigationId,
      claims.flatMap((claim) => pointerPages(claim.pointer)),
    );
    const invalidClaims = claims.flatMap((claim, position) => (checkPointer(claim.pointer, sizes).valid ? [] : [position]));
    if (invalidClaims.length > 0) {
      return { to: 'rejected', outcome: 'rejected', reason: 'pointer_invalid', detail: { invalidClaims } };
    }
    const written = await claimsRepository.writeTaskClaims(tx, {
      investigationId: run.investigationId,
      taskId: run.runTaskId,
      coverage: null,
      claims,
      firstClaimIndex: await claimsRepository.nextClaimIndex(tx, run.runTaskId),
    });
    // The repository returns every claim of the task by number: this call's are the last ones.
    return { to: 'done', outcome: 'success', result: { claimIds: written.slice(-claims.length) } };
  },
};
