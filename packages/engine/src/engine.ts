import type { Database } from '@agent-os/db';
import type { Clock } from '@agent-os/runtime';
import type { SourceRegistry } from '@agent-os/sources';
import { z } from 'zod';
import { readAgentTree, type ReadAgentTreeResult } from './agents/agent-tree.js';
import type { AssessAgent, AssessAgentRequest, AssessAgentResult } from './agents/assess-agent.js';
import type {
  DefinitionMemory,
  DefinitionMemoryRecord,
  ListDefinitionMemoryInput,
  RemoveDefinitionMemoryInput,
  RemoveDefinitionMemoryResult,
  WriteDefinitionMemoryInput,
  WriteDefinitionMemoryResult,
} from './agents/definition-memory.js';
import { readAnswerMessage, type ReadAnswerMessageResult } from './answer/answer-message.js';
import type { Assess, AssessRequest, AssessResult } from './assess/assess.js';
import type { ResultFormRegistry } from './agents/result-forms.js';
import type { ProcessSet } from './config/process-set.js';
import type { SourceMode } from './config/source-check.js';
import type { EngineLogger } from './ports.js';
import { engineRunsRepository as runs } from './runs/engine-runs.repository.js';
import {
  type EngineRuntimePorts,
  startInvestigation,
  type StartInvestigationInput,
  type StartInvestigationResult,
} from './runs/start-investigation.js';
import { type ReadInvestigationResult, toInvestigationView } from './view/investigation-view.js';
import { usageRepository as usage } from './view/usage.repository.js';

/** The research engine (design-engine.md, Contract Definitions). */
export interface Engine {
  /**
   * The mode every new investigation of this engine starts in (KD-8): set by `connectedSources` at creation and
   * unchanged for the engine's lifetime, whatever the connected sources answer.
   */
  readonly sourceMode: SourceMode;
  startInvestigation(input: StartInvestigationInput): Promise<StartInvestigationResult>;
  /**
   * The owner's investigation; `investigation_not_found` for another owner's or an unknown one. Reads no evidence: the
   * answer message is not part of the view.
   */
  readInvestigation(input: { investigationId: string; resourceId: string }): Promise<ReadInvestigationResult>;
  /**
   * The answer message for the chat, read by the chat server's delivery only (design-engine.md, KD-8): the stored message
   * of an investigation completed with an answer. `investigation_not_found` for another owner's or an unknown
   * investigation, `no_answer` for one not completed with an answer; a database read that fails throws. The chat server adds only `launch`.
   */
  readAnswerMessage(input: { investigationId: string; resourceId: string }): Promise<ReadAnswerMessageResult>;
  /**
   * One model call with a JSON answer outside an investigation task (design-self-check.md, `Engine.assess`): the
   * self-check judge or a calibration call. Only the `assessModels` of `createEngine` are called; any other model is
   * `failed` with `model_unavailable` before a write or a provider call. Writes no ledger row; the caller counts the
   * spend.
   */
  assess<T>(request: AssessRequest<T>): Promise<AssessResult<T>>;
  /**
   * Writes a record of an agent definition's memory (design-agent-core.md, FR-22): the scope `deployment` by a holder of
   * the memory admin role, a `user` scope by its user only. Refused without a write: `unknown_definition` — no loaded
   * definition of the process has that agent; `no_write_right`; `scope_not_allowed` — a `user` record for a
   * definition whose result form forbids that memory (DC-24); `limit_reached` — a text over 2000 characters, or the scope's
   * active texts would pass 8 KiB (DC-15).
   */
  writeDefinitionMemory(input: WriteDefinitionMemoryInput): Promise<WriteDefinitionMemoryResult>;
  /**
   * Marks a record removed; snapshots of investigations already started keep it. `not_found` for an unknown or removed
   * record, `no_write_right` for a remover without the right to its scope.
   */
  removeDefinitionMemory(input: RemoveDefinitionMemoryInput): Promise<RemoveDefinitionMemoryResult>;
  /** The active records of the definition in the scopes the reader may read: `deployment` with the admin role, its own `user`. */
  listDefinitionMemory(input: ListDefinitionMemoryInput): Promise<DefinitionMemoryRecord[]>;
  /**
   * The agent tree of the owner's investigation (design-agent-core.md, «Операции движка», DC-11, DC-16): its runs with
   * their parents and calls, assignments, statuses, results or failures, spending, turns and tool calls, the definition
   * memory snapshot of the start and `budgetExhausted`. `investigation_not_found` for another owner's or an unknown one.
   */
  readAgentTree(input: { investigationId: string; resourceId: string }): Promise<ReadAgentTreeResult>;
  /**
   * The turns of one definition outside an investigation (design-agent-core.md, DC-25), beside `assess`
   * and for the same aims — calibration and measuring the influence of a text: the prologue's `build`, turns with the
   * view, tools and turn limit of an investigation, `evaluate` on each `finish`; no `collect`, `write`, forced end,
   * reserve or token count. The binding «table by the definition's fingerprint pair» is replaced by the calibrating
   * mark. Refused before a turn with `agent_not_detachable` (tools besides `finish`, or a closure with `collect`) and
   * `model_unavailable` (a model outside `assessModels`). Each turn writes a transcript of role `agent` with its whole
   * input and the agent's name; no task, run row, session or ledger row.
   */
  assessAgent(request: AssessAgentRequest): Promise<AssessAgentResult>;
  /**
   * The server start's check (design-research-flow.md, KD-4, DC-10), called only by `EngineModule.onModuleInit` before
   * the task handlers start: the highest loaded version of each process needs the group table of its checker agent's
   * `agentFingerprint` and the
   * `definitionMemoryFingerprint` of that agent's current `deployment` records. Rejects with `calibration_missing`
   * naming the process, the version and both fingerprints, or with the failure of the read; either stops the start.
   */
  checkCalibration(): Promise<void>;
}

/** What a created engine runs on, after `createEngine` has checked it. */
export interface EngineDeps {
  readonly database: Database;
  readonly runtime: EngineRuntimePorts;
  readonly processes: ProcessSet;
  readonly sourceMode: SourceMode;
  /** `Engine.assess` over the `assessModels` of `createEngine`. */
  readonly assess: Assess;
  /** `Engine.assessAgent` over the same `assessModels` and the engine's registries. */
  readonly assessAgent: AssessAgent;
  /** `Engine.checkCalibration` over the loaded processes and the engine's group tables. */
  readonly checkCalibration: () => Promise<void>;
  /** The engine's result forms: a start takes its definition memory snapshot by them (DC-24). */
  readonly forms: ResultFormRegistry;
  /** The definition memory over the loaded processes and the engine's result forms. */
  readonly definitionMemory: DefinitionMemory;
  /** Serves the slice of each configured source the start records (KD-7). */
  readonly sourceRegistry: Pick<SourceRegistry, 'currentSnapshot'>;
  readonly clock: Clock;
  readonly logger: EngineLogger;
}

const NOT_FOUND = { outcome: 'rejected', code: 'investigation_not_found' } as const;

export function buildEngine(deps: EngineDeps): Engine {
  const { database, sourceMode } = deps;
  return {
    sourceMode,
    assess: deps.assess,
    assessAgent: deps.assessAgent,
    checkCalibration: deps.checkCalibration,
    startInvestigation: startInvestigation({
      database,
      sourceMode,
      processes: deps.processes,
      forms: deps.forms,
      ...deps.runtime,
      sources: deps.sourceRegistry,
      clock: deps.clock,
      logger: deps.logger,
    }),
    async readInvestigation({ investigationId, resourceId }) {
      if (!z.uuid().safeParse(investigationId).success) {
        return NOT_FOUND;
      }
      const status = await runs.readStatus(database, investigationId, resourceId);
      if (status === undefined) {
        return NOT_FOUND;
      }
      const usageRows = await usage.byRoleAndModel(database, investigationId);
      return { outcome: 'found', view: toInvestigationView(status, usageRows) };
    },
    readAnswerMessage: (input) => readAnswerMessage(database, input),
    writeDefinitionMemory: (input) => deps.definitionMemory.write(input),
    removeDefinitionMemory: (input) => deps.definitionMemory.remove(input),
    listDefinitionMemory: (input) => deps.definitionMemory.list(input),
    readAgentTree: (input) => readAgentTree(database, input),
  };
}
