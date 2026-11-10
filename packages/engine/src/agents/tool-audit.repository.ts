import { randomUUID } from 'node:crypto';
import { agentToolAudit } from '@agent-os/db';
import type { RuntimeTx } from '@agent-os/runtime';

/**
 * The outcome of a tool call (design-agent-core.md, KD-3): the five audit classes of the project — `success`, `empty`,
 * `tool_error`, `transport_failure`, `access_denied` — and `rejected`, a refusal by code with its reason.
 */
export const AUDIT_OUTCOMES = ['success', 'empty', 'tool_error', 'transport_failure', 'access_denied', 'rejected'] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

/** One audit row: only the fact of a call (business constraint 3) — no arguments, no investigation, no run. */
export interface AuditFact {
  /** The owner of the investigation the call was made in. */
  readonly resourceId: string;
  readonly toolName: string;
  /** The source the tool called; null for a tool without one. */
  readonly sourceId: string | null;
  readonly outcome: AuditOutcome;
}

/**
 * `agent_tool_audit` (KD-3, invariant 12): written by the same guarded transaction as the call's outcome, never on its
 * own. The table has no link to the investigation, so deleting a conversation leaves it as it is.
 */
export const toolAuditRepository = {
  /** Writes the row and returns its id, which the call row references. */
  async insert(tx: RuntimeTx, fact: AuditFact): Promise<string> {
    const id = randomUUID();
    await tx.insert(agentToolAudit).values({
      id,
      resourceId: fact.resourceId,
      toolName: fact.toolName,
      sourceId: fact.sourceId,
      outcome: fact.outcome,
    });
    return id;
  },
};
