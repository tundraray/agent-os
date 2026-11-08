import { type InvestigationStatus, InvestigationStatusSchema } from '@agent-os/contracts';
import type { z } from 'zod';
import { type InvestigationAnswer, InvestigationAnswerSchema } from '../answer/code-answer.js';
import { AgentProcessConfigSchema, hasAgentsKey } from '../config/agent-config.schema.js';
import { type AnyProcessConfig, type ProcessConfig, ProcessConfigSchema } from '../config/process-config.schema.js';
import type { SourceMode } from '../config/source-check.js';
import type { ModelRole } from '../model/ledger.js';
import type { EngineRunStatus } from '../runs/engine-runs.repository.js';
import type { RoleModelUsageRow } from './usage.repository.js';

export type InvestigationViewStatus = 'running' | 'completed' | 'failed' | 'cancelled';

type AnswerSection = ProcessConfig['answer']['sections'][number];

/**
 * A stored answer as any version of the engine wrote it. The view always fills `summaryItems`, `confidence` and
 * `causal` — an answer written before agent-quality reads as an empty list, null and false — but the type keeps them
 * optional, so a reader or a double written before them still compiles.
 */
type StoredAnswer = z.input<typeof InvestigationAnswerSchema>;

/**
 * The answer as the view shows it: `outcome` and `stopReason`, then the sections the investigation's configuration
 * names, in its order (ProcessConfig `answer`); a section the configuration leaves out is absent. The section `summary`
 * is the summary string of an answer written before agent-quality and the summary items after it (KD-4).
 */
type InvestigationAnswerView = Pick<StoredAnswer, 'answerId' | 'outcome' | 'stopReason'> &
  Partial<Pick<StoredAnswer, AnswerSection | 'summaryItems'>>;

/**
 * An investigation as the engine shows it (design-engine.md, InvestigationView). `processId`, `version` and
 * `sourceMode` are the ones recorded at the start, never the engine's current ones (DC-15, DC-16).
 */
export interface InvestigationView {
  readonly investigationId: string;
  readonly status: InvestigationViewStatus;
  /** Null only between the engine row and the controller task of a start that has not finished yet. */
  readonly controllerTaskId: string | null;
  readonly processId: string;
  readonly version: number;
  readonly sourceMode: SourceMode;
  /**
   * Null until the investigation is answered; then its `outcome`, `stopReason` (null, or why the engine stopped it) and
   * the sections of its configuration in their order.
   */
  readonly answer: InvestigationAnswerView | null;
  readonly usage: InvestigationUsage;
}

/** Calls of one role on one model, as the ledger recorded them. */
interface RoleModelUsage {
  readonly role: ModelRole;
  readonly model: string;
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly costUsd: number;
}

/** The ledger of the investigation by role and model, its total and its budget (AC-11.1). */
interface InvestigationUsage {
  /** In the order of the roles (`plan`, `controller`, `worker`, `verifier`, `synthesis`), then by model. */
  readonly byRoleAndModel: readonly RoleModelUsage[];
  /**
   * Charged plus the open reservations: a cancelled investigation keeps the reservation of its interrupted call open in
   * the ledger, and it counts as spent (DC-9).
   */
  readonly totalTokens: number;
  readonly totalCostUsd: number;
  readonly tokenBudget: number;
}

export type ReadInvestigationResult =
  | { readonly outcome: 'found'; readonly view: InvestigationView }
  | { readonly outcome: 'rejected'; readonly code: 'investigation_not_found' };

/**
 * The status of the view follows the investigation's own status (design-lifecycle.md, KD-1): `running` while it is
 * `active`, its closed status once closed, and `cancelled` for one whose conversation is being deleted. The outcome of
 * the controller task does not decide it: an investigation is `completed` only once `engine.lifecycle` has closed it.
 */
const VIEW_STATUS_OF: Readonly<Record<InvestigationStatus, InvestigationViewStatus>> = {
  active: 'running',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
  deleting: 'cancelled',
};

function viewStatus(investigationStatus: string): InvestigationViewStatus {
  return VIEW_STATUS_OF[InvestigationStatusSchema.parse(investigationStatus)];
}

export function toInvestigationView(
  { run, investigationStatus }: EngineRunStatus,
  usageRows: readonly RoleModelUsageRow[],
): InvestigationView {
  return {
    investigationId: run.investigationId,
    status: viewStatus(investigationStatus),
    controllerTaskId: run.controllerTaskId,
    processId: run.processId,
    version: run.processVersion,
    sourceMode: recordedSourceMode(run.sourceMode),
    answer: run.answer === null ? null : answerView(InvestigationAnswerSchema.parse(run.answer), run.processConfig),
    usage: usageView(run, usageRows),
  };
}

const ROLE_ORDER: readonly ModelRole[] = ['plan', 'controller', 'worker', 'verifier', 'synthesis', 'agent'];

function usageView(run: EngineRunStatus['run'], rows: readonly RoleModelUsageRow[]): InvestigationUsage {
  const byRoleAndModel = rows
    .map((row): RoleModelUsage => ({ ...row, role: recordedRole(row.role), costUsd: Number(row.costUsd) }))
    .sort((left, right) => ROLE_ORDER.indexOf(left.role) - ROLE_ORDER.indexOf(right.role) || left.model.localeCompare(right.model));
  return {
    byRoleAndModel,
    totalTokens: run.tokensSpent + run.tokensReserved,
    totalCostUsd: byRoleAndModel.reduce((sum, row) => sum + row.costUsd, 0),
    tokenBudget: run.tokenBudget,
  };
}

/** The column's CHECK allows only the five roles; anything else is a defect. */
function recordedRole(value: string): ModelRole {
  const role = ROLE_ORDER.find((candidate) => candidate === value);
  if (role === undefined) {
    throw new Error(`research_llm_calls.role holds an unknown role ${value}`);
  }
  return role;
}

/**
 * The frozen configuration of an investigation, of either form (DC-29, ADR-0009, KD-7): one with the `agents` key
 * through the agents schema, any other through `ProcessConfigSchema` — the same choice the load makes.
 */
export function frozenProcessConfig(data: unknown): AnyProcessConfig {
  return hasAgentsKey(data) ? AgentProcessConfigSchema.parse(data) : ProcessConfigSchema.parse(data);
}

/**
 * The stored answer (a `jsonb` keeps no key order) laid out in the sections of the recorded configuration (DC-15), of
 * either form (DC-29). An answer written before agent-quality reads with the same schema: no summary items, no group, no
 * causal flag (UC-E5).
 */
function answerView(answer: InvestigationAnswer, processConfig: unknown): InvestigationAnswerView {
  const sections: Partial<Pick<InvestigationAnswer, AnswerSection | 'summaryItems'>> = {};
  const copy = <Section extends AnswerSection>(section: Section): void => {
    sections[section] = answer[section];
    if (section === 'summary') sections.summaryItems = answer.summaryItems;
  };
  frozenProcessConfig(processConfig).answer.sections.forEach(copy);
  return { answerId: answer.answerId, outcome: answer.outcome, stopReason: answer.stopReason, ...sections };
}

/** The column's CHECK allows only the two modes; anything else is a defect, not a mode to guess. */
function recordedSourceMode(value: string): SourceMode {
  if (value === 'sources' || value === 'model_knowledge') {
    return value;
  }
  throw new Error(`research_engine_runs.source_mode holds an unknown mode ${value}`);
}
