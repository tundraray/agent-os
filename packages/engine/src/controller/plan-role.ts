import type { TaskContext } from '@agent-os/runtime';
import { z } from 'zod';
import type { StopReason } from '../answer/code-answer.js';
import type { ProcessConfig } from '../config/process-config.schema.js';
import type { SourceMode } from '../config/source-check.js';
import { type PromptField, renderPromptTemplate } from '../config/prompt-template.js';
import type { ContextBuilder } from '../context/context-builder.js';
import type { ModelGateway } from '../model/model-gateway.js';
import { controllerRepository as repository, type PlanRevisionRow } from './decisions.repository.js';
import { callOrReplay } from './role-call.js';

/** What the `plan` role returns (design-engine.md, DecisionInput `planRevision`: readiness criteria and branches). */
const PlanOutputSchema = z.object({
  readinessCriteria: z.array(z.string()),
  branches: z.array(z.object({ question: z.string(), approach: z.string() })),
});

/** A plan revision as stored: the goal of the configuration with the criteria and branches of the revision. */
export interface PlanContent extends z.infer<typeof PlanOutputSchema> {
  readonly goal: string;
}

/** The investigation as the roles of the controller task see it: its frozen configuration, mode and query. */
export interface InvestigationFrame {
  readonly investigationId: string;
  readonly config: ProcessConfig;
  readonly sourceMode: SourceMode;
  readonly query: string;
  /** No role call starts at or after it (invariant 5). */
  readonly notAfter: Date;
}

export interface PlanRoleDeps {
  readonly gateway: ModelGateway;
  readonly contextBuilder: ContextBuilder;
}

export type PlanRevisionResult =
  | { readonly outcome: 'revised'; readonly revision: number }
  | { readonly outcome: 'stop'; readonly reason: StopReason }
  | { readonly outcome: 'abandon'; readonly cause: 'cancelled' | 'fenced' };

/** The prompt fields of a role, rendered from the investigation's own configuration (DC-15). */
export function promptValues(frame: InvestigationFrame): Record<PromptField, string> {
  return {
    goal: frame.config.goal,
    query: frame.query,
    sourceMode: frame.sourceMode,
    answerSections: frame.config.answer.sections.join(', '),
  };
}

function assignment(previous: PlanRevisionRow | undefined, reason: string | null): string {
  if (previous === undefined) {
    return 'Write the first revision of the investigation plan.';
  }
  return `Revise the investigation plan.\nReason: ${reason ?? ''}\nCurrent plan (revision ${previous.revision}):\n${JSON.stringify(previous.plan)}`;
}

/**
 * Writes the next plan revision by the `plan` role; its answer goes to the checkpoint before the guarded write, so a
 * replayed attempt writes the same revision without a second call (invariant 3). A role input that does not fit its
 * window and an output that stays invalid after the gateway's retry end the investigation by code. Only a configuration
 * with the `plan` capability gets here: without it code seeds the first revision (`seedPlan`, KD-8) and the gate refuses
 * `replan`.
 */
export async function writePlanRevision(
  deps: PlanRoleDeps,
  ctx: TaskContext,
  input: { readonly frame: InvestigationFrame; readonly previous: PlanRevisionRow | undefined; readonly reason: string | null },
): Promise<PlanRevisionResult> {
  const { frame, previous, reason } = input;
  const revision = (previous?.revision ?? 0) + 1;
  if (!frame.config.capabilities.includes('plan')) {
    throw new Error(`investigation ${frame.investigationId} has no plan capability to write revision ${revision}`);
  }
  const roleConfig = frame.config.roles.plan;
  const instructions = renderPromptTemplate(roleConfig.prompt, promptValues(frame));
  const call = `plan:${revision}`;
  const packet = await deps.contextBuilder.buildSlotPacket(
    { roleConfig, instructions, outputSchema: PlanOutputSchema, signal: ctx.signal },
    { assignment: assignment(previous, reason), evidence: [] },
  );
  if (packet.outcome === 'needs_narrowing') return { outcome: 'stop', reason: 'context_overflow' };
  if (packet.outcome === 'count_failed') return { outcome: 'stop', reason: 'model_unavailable' };
  const answered = await callOrReplay(deps.gateway, {
    ctx,
    role: 'plan',
    roleConfig,
    call,
    instructions,
    messages: packet.messages,
    outputSchema: PlanOutputSchema,
    notAfter: frame.notAfter,
  });
  if (answered.outcome === 'invalid') return { outcome: 'stop', reason: 'controller_invalid' };
  if (answered.outcome !== 'answered') return answered;
  const content: PlanContent = { goal: frame.config.goal, ...answered.output };
  const written = await ctx.withAttemptGuard((tx) =>
    repository.insertPlanRevision(tx, { investigationId: frame.investigationId, revision, plan: content, reason }),
  );
  return written.outcome === 'fenced' ? { outcome: 'abandon', cause: 'fenced' } : { outcome: 'revised', revision };
}
