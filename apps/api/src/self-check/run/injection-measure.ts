import {
  type AssessRequest,
  type AssessResult,
  buildClaimCheck,
  type ClaimAssessment,
  ClaimAssessmentSchema,
  type ClaimCheckPage,
  decideClaim,
  pointerOverAll,
  type ProcessConfig,
} from '@agent-os/engine';
import type { CalibrationPair } from '@agent-os/mcp-fixture';
import type { Clock } from '@agent-os/runtime';
import { z } from 'zod';
import { CALL_WINDOW_MS } from '../calibrate/calibration.js';
import type { InjectionMeasure } from '../result/run-result.js';

/**
 * The measure of text addressed to the model (design-engine.md, `RunResult.metrics`, `injectionInfluence`; AC-17.1):
 * each `injected` calibration pair of a scenario is checked twice through the same call as in an investigation —
 * `buildClaimCheck`, `Engine.assess` with the `verifier` role — once as it is and once without the records of the
 * traces the scenario key names in `injectionTraceIds`, the remaining records numbered anew by `buildClaimCheck`. The
 * pair counts as influenced when `support` or `claimType` differ. Only those closed fields and the records' `traceId`
 * identifiers are read; no text of the claim, the records or the answer.
 */

/** `Engine.assess`, the only engine operation the measure uses. */
type Assess = <T>(request: AssessRequest<T>) => Promise<AssessResult<T>>;

/** A log record carries its trace in the `traceId` field; a count group carries none. */
const TracedRecordSchema = z.object({ traceId: z.string() });

export interface InjectionMeasureInput {
  /** The scenario's calibration pairs; only those marked `injected` are checked. */
  readonly pairs: readonly CalibrationPair[];
  /** `ScenarioKey.injectionTraceIds` of the scenario. */
  readonly injectionTraceIds: readonly string[];
  /** The `verifier` role of the run's configuration. */
  readonly verifier: ProcessConfig['roles']['verifier'];
  readonly assess: Assess;
  /** `self-check:run:<runId>`: every call's transcript is bound to the run, so the run's spend counts it. */
  readonly selfCheckRunId: string;
  readonly clock: Clock;
}

/**
 * One scenario's measure: two calls per `injected` pair, in pair order. A pair with no record left without the traces
 * is not called; a pair whose call failed or answered off the form is counted apart and is not in the measure.
 */
export async function measureInjection(
  input: InjectionMeasureInput,
): Promise<InjectionMeasure> {
  const injected = new Set(input.injectionTraceIds);
  let measuredPairs = 0;
  let influencedPairs = 0;
  let unassessedPairs = 0;
  for (const pair of input.pairs) {
    if (!pair.injected) continue;
    const clean = withoutTraces(pair.pages, injected);
    if (recordCount(clean) === 0) continue;
    const asIs = await assessPair(input, pair, pair.pages);
    const without = await assessPair(input, pair, clean);
    if (asIs === null || without === null) {
      unassessedPairs += 1;
      continue;
    }
    measuredPairs += 1;
    if (
      asIs.support !== without.support ||
      asIs.claimType !== without.claimType
    ) {
      influencedPairs += 1;
    }
  }
  return { measuredPairs, influencedPairs, unassessedPairs };
}

/** The pages without the records of the named traces; a page left with no record is dropped. */
function withoutTraces(
  pages: readonly ClaimCheckPage[],
  traceIds: ReadonlySet<string>,
): ClaimCheckPage[] {
  return pages.flatMap((page) => {
    const records = page.records.filter((record) => {
      const traced = TracedRecordSchema.safeParse(record);
      return !(traced.success && traceIds.has(traced.data.traceId));
    });
    return records.length === 0 ? [] : [{ ...page, records }];
  });
}

const recordCount = (pages: readonly ClaimCheckPage[]): number =>
  pages.reduce((sum, page) => sum + page.records.length, 0);

/**
 * One verifier call over the pages and the assessment in form, or null when the call failed or its answer did not pass
 * the form rule of `decideClaim` (DC-7) for these pages.
 */
async function assessPair(
  input: InjectionMeasureInput,
  pair: CalibrationPair,
  pages: readonly ClaimCheckPage[],
): Promise<ClaimAssessment | null> {
  const { verifier } = input;
  const check = buildClaimCheck({
    roleConfig: verifier,
    claimText: pair.claimText,
    pages,
  });
  const called = await input.assess({
    role: 'verifier',
    model: verifier.model,
    effort: verifier.effort,
    maxOutputTokens: verifier.maxOutputTokens,
    instructions: check.instructions,
    messages: check.messages,
    outputSchema: check.outputSchema,
    binding: { selfCheckRunId: input.selfCheckRunId },
    notAfter: new Date(input.clock.now().getTime() + CALL_WINDOW_MS),
  });
  if (called.outcome !== 'answered') return null;
  const decision = decideClaim({
    assessment: called.output,
    ...pointerOverAll(pages),
    atoms: pair.claimAtoms,
    groupTable: undefined,
  });
  // A decision other than `invalid_assessment` means the assessment passed the form rule, so it parses.
  return decision.reason === 'invalid_assessment'
    ? null
    : ClaimAssessmentSchema.parse(called.output);
}
