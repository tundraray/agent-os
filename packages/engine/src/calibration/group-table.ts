import { type ResearchAnswerConfidence, ResearchAnswerConfidenceSchema } from '@agent-os/contracts';
import { z } from 'zod';
import { type ClaimProfile, ClaimProfileSchema } from '../verify/claim-assessment.js';

/** The group of a profile the calibration did not see, and of every claim without a table (DC-11). */
const LOWEST_GROUP: ResearchAnswerConfidence = 'low';
/** `very_high` exists only in a four-group table. */
const FOURTH_GROUP: ResearchAnswerConfidence = 'very_high';

const share = z.number().min(0).max(1);
const hex12 = z.string().regex(/^[0-9a-f]{12}$/);

/**
 * The group table file (design-research-flow.md, «Таблица групп v3»), built by calibration: the key, the pair
 * `agentFingerprint` + `definitionMemoryFingerprint` of the checker agent, and its model, written to be read; the scenario
 * set, the fingerprint of the pairs `buildCalibrationPairs` returned and the calibration time; the number of groups, 3 or
 * 4; the group of each profile the calibration saw; per group the number of established pairs and the share correct; per
 * pair kind the three shares that matched the key.
 */
export const GroupTableSchema = z
  .strictObject({
    model: z.string().min(1),
    agentFingerprint: hex12,
    definitionMemoryFingerprint: hex12,
    scenarioSet: z.string().min(1),
    pairsFingerprint: hex12,
    calibratedAt: z.iso.datetime(),
    groupCount: z.union([z.literal(3), z.literal(4)]),
    profiles: z.array(z.strictObject({ profile: ClaimProfileSchema, group: ResearchAnswerConfidenceSchema })),
    groups: z.array(
      z.strictObject({
        group: ResearchAnswerConfidenceSchema,
        establishedPairs: z.number().int().min(0),
        correctShare: share,
      }),
    ),
    pairKinds: z.array(
      z.strictObject({
        pairKind: z.string().min(1),
        supportMatch: share,
        typeMatch: share,
        decisionMatch: share,
      }),
    ),
  })
  .superRefine((table, context) => {
    if (table.groupCount === 4) return;
    const named = [...table.profiles.map((entry) => entry.group), ...table.groups.map((entry) => entry.group)];
    if (named.includes(FOURTH_GROUP)) {
      context.addIssue({ code: 'custom', message: `a three-group table has no ${FOURTH_GROUP} group` });
    }
  });
export type GroupTable = z.infer<typeof GroupTableSchema>;

/** The table calibrated for this pair of fingerprints of the checker agent (KD-4 of research-flow, DC-10). */
export function findGroupTableByPair(
  tables: readonly GroupTable[],
  pair: { readonly agentFingerprint: string; readonly definitionMemoryFingerprint: string },
): GroupTable | undefined {
  return tables.find(
    (table) => table.agentFingerprint === pair.agentFingerprint && table.definitionMemoryFingerprint === pair.definitionMemoryFingerprint,
  );
}

const sameProfile = (left: ClaimProfile, right: ClaimProfile): boolean =>
  left.claimType === right.claimType &&
  left.valueCheck === right.valueCheck &&
  left.independentRecords === right.independentRecords &&
  left.contradictions === right.contradictions;

/** The group the table gives the profile; the lowest group without a table or for a profile it lacks (DC-11). */
export function groupOf(table: GroupTable | undefined, profile: ClaimProfile): ResearchAnswerConfidence {
  return table?.profiles.find((entry) => sameProfile(entry.profile, profile))?.group ?? LOWEST_GROUP;
}
