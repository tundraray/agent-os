import type { ProcessConfig } from '@agent-os/engine';
import { z } from 'zod';
import shippedSettings from './self-check.settings.json' with { type: 'json' };

type Effort = ProcessConfig['roles']['worker']['effort'];

/** The same effort levels a process role takes; `satisfies` keeps the list inside the engine's type. */
const EFFORTS = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const satisfies readonly Effort[];

const positiveInteger = z.number().int().positive();
const prompt = z.string().min(1);

/** «Настройки самопроверки» (design-self-check.md, Contract Definitions); an unknown key is a fault, not ignored. */
const SelfCheckSettingsSchema = z.strictObject({
  judge: z.strictObject({
    /** `provider/model`, a key of the model catalog. */
    model: z.string().min(1),
    effort: z.enum(EFFORTS),
    maxOutputTokens: positiveInteger,
    prompts: z.strictObject({
      /** Instructions of the judge that fills the form with the scenario key. */
      withKey: prompt,
      /** Instructions of the judge that answers yes, partly or no without a key. */
      withoutKey: prompt,
    }),
  }),
  /** Failure signals of an investigation without a key: each fires at or above its threshold. */
  signals: z.strictObject({
    /** Share of discarded claims among all claims of the investigation. */
    discardedShare: z.number().gt(0).lte(1),
    /** Number of rejected controller decisions. */
    controllerRejections: positiveInteger,
  }),
  /** Bootstrap of the comparison interval: how many resamples and their constant seed. */
  resampling: z.strictObject({
    resamples: positiveInteger,
    seed: z.number().int().nonnegative().lte(0xffff_ffff),
  }),
});

export type SelfCheckSettings = z.infer<typeof SelfCheckSettingsSchema>;

/** The first fault's path, with an unknown key named at its own path rather than at the object that holds it. */
function faultPath(issue: z.core.$ZodIssue): string {
  const path = issue.path.filter(
    (segment): segment is string | number => typeof segment !== 'symbol',
  );
  const full =
    issue.code === 'unrecognized_keys' ? [...path, issue.keys[0] ?? ''] : path;
  return full.length === 0 ? '(root)' : full.join('.');
}

/** Checks settings data with the schema; a fault throws with the path to the field, so the program does not start. */
function parseSelfCheckSettings(data: unknown): SelfCheckSettings {
  const parsed = SelfCheckSettingsSchema.safeParse(data);
  if (parsed.success) return parsed.data;
  const [firstIssue] = parsed.error.issues;
  if (firstIssue === undefined)
    throw new Error('zod reported a failure without issues');
  throw new Error(
    `self-check settings rejected at ${faultPath(firstIssue)}: ${firstIssue.message}`,
  );
}

/**
 * The settings file shipped next to the program. It is imported, so the compiler emits it into `dist` beside
 * `settings.js`; it is still raw data and goes through the schema at every start.
 */
export function loadSelfCheckSettings(): SelfCheckSettings {
  return parseSelfCheckSettings(shippedSettings);
}
