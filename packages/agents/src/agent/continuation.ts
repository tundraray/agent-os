import type { StepMessage } from '@agent-os/runtime';

import type { ResumeMark } from '../resume';
import type { Session } from '../store/sessions';
import { resumeMarkOf } from './deliver';

/** A finished agent continues with this step (Flow 6); `stop` is set when the runtime had stopped it (Flow 7). */
export interface Continuation {
  readonly stop: { readonly withParent: boolean } | null;
}

export interface ContinuationInput {
  readonly session: Session;
  readonly messages: readonly StepMessage[];
}

/**
 * Whether this step continues a finished agent: its session is `closed` (it completed or failed by
 * itself) or a message carries the `resume.stopped` mark (plan Notes 5). Pure, so the step knows
 * before its commit that the open calls of a stopped agent are closed, not run.
 */
export function continuationOf(
  input: ContinuationInput,
): Continuation | undefined {
  const mark = input.messages
    .map(resumeMarkOf)
    .find((resume): resume is ResumeMark => resume !== undefined);
  if (mark !== undefined) return { stop: { withParent: mark.withParent } };
  if (input.session.closed) return { stop: null };
  return undefined;
}
