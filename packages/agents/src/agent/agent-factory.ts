import {
  AGENT_TASK_TYPE,
  CHAT_TASK_TYPE,
  DEEP_AGENT_TASK_TYPE,
  TRAINER_TASK_TYPE,
} from '@agent-os/contracts';
import type { Logger } from '@agent-os/common';
import {
  AgentsRepository,
  DocumentsRepository,
  SettingsRepository,
  TrainingsRepository,
} from '@agent-os/db';
import { type LiveTaskIdentity, TaskControl } from '@agent-os/runtime';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';

import type { AccessGate } from '../access-gate';
import {
  ACCESS_GATE,
  AGENTS_CONFIG,
  AGENTS_LOGGER,
  RECORD_LIBRARY,
} from '../agents.tokens';
import type { AgentsConfig } from '../config';
import { DeepAgent, type DeepAgentDeps } from '../deep/deep-agent';
import { AgentsProviders } from '../providers/provider-registry';
import type { RecordLibrary } from '../start/record-library';
import type { RunStart } from '../start/run-definition';
import {
  type AgentTaskInput,
  agentTaskInputOf,
  type SessionStart,
} from '../store/sessions';
import { createStartChild } from '../tools/system/start-child';
import { readToolResultSettings } from '../tools/tool-result-settings';
import type { StartChild } from '../tools/tool';
import { type StartChildScope, ToolRunner } from '../tools/tool-runner';
import { Trainer } from '../training/trainer';
import type { TrainerDeps } from '../training/trainer-step';
import { inTrainingTree } from '../training/training-tree';
import { Agent } from './agent';
import { AgentDeps } from './agent-deps';
import type { AgentRun } from './agent-state';
import type { BaseAgent } from './base-agent';
import { ChatAgent, type ChatAgentDeps } from './chat-agent';

/**
 * The task type a run under a parent is created with: a deep agent's version runs as `DeepAgent`, any other run
 * — a team member of a deep agent's version among them — as `Agent`.
 */
export function childTypeOf(run: RunStart): string {
  return run.version.kind === 'deep_agent' && run.subagent === null
    ? DEEP_AGENT_TASK_TYPE
    : AGENT_TASK_TYPE;
}

/**
 * Makes the agent objects, one per task; the class is picked by the task's type. Whoever creates an agent's
 * task makes its object in the same transaction (`createIn`) and hands it to the runtime, which then runs the
 * task's steps on it; a task the runtime has no object for gets one from the database (`restore`). Both fill the
 * object through `BaseAgent.absorb`, so the two hold the same state for the same rows.
 */
@Injectable()
export class AgentFactory implements OnModuleInit {
  private readonly logger: Logger;
  /** What the agents of each class work with, shared by every object of the class. */
  private readonly chat: ChatAgentDeps;
  private readonly deep: DeepAgentDeps;
  private readonly trainer: TrainerDeps;
  /** The start of a child agent in a step's commit: a tool call's, and a trainer's replay. */
  private readonly startChild: (scope: StartChildScope) => StartChild;

  constructor(
    @Inject(AgentDeps) private readonly agent: AgentDeps,
    /**
     * The version of a task the runtime has no object for is read from it by its session's id (`restore`); a
     * trainer starts its replays through it.
     */
    @Inject(RECORD_LIBRARY)
    private readonly library: RecordLibrary,
    /** The final subagent's answer of a deep agent is read from its task; the root's type marks a training tree. */
    @Inject(TaskControl)
    private readonly tasks: Pick<TaskControl, 'get' | 'listTree'>,
    /** The settings of large results, read for each `task` ending (tool-result-reading R-5). */
    @Inject(SettingsRepository) settingsRows: Pick<SettingsRepository, 'read'>,
    /** A deep agent's end of turn looks up its run's report document. */
    @Inject(DocumentsRepository)
    documentRows: Pick<DocumentsRepository, 'latestReport' | 'findInRun'>,
    @Inject(ToolRunner)
    private readonly runner: Pick<ToolRunner, 'useStartChild'>,
    @Inject(AGENTS_CONFIG) config: Pick<AgentsConfig, 'maxDepth'>,
    @Inject(AGENTS_LOGGER) logger: Logger,
    /** A trainer's training row, the version it proposed, and the start check of its replays. */
    @Inject(TrainingsRepository)
    trainingRows: Pick<TrainingsRepository, 'find' | 'writeComparisons'>,
    @Inject(AgentsRepository)
    agentRows: Pick<AgentsRepository, 'findTrainingVersion'>,
    @Inject(ACCESS_GATE) access: AccessGate,
    @Inject(AgentsProviders) providers: Pick<AgentsProviders, 'connection'>,
  ) {
    this.logger = logger.child({ service: 'agents.factory' });
    this.startChild = createStartChild({
      maxDepth: config.maxDepth,
      childType: childTypeOf,
      createIn: (type, task, input, start) =>
        this.createIn(type, task, input, start),
    });
    // The holder has fields only: a copy with what the class adds is all a class needs.
    this.chat = Object.assign({}, agent, { logger });
    this.deep = Object.assign({}, agent, {
      tasks,
      documentRows,
      resultSettings: () => readToolResultSettings(settingsRows),
      maxDepth: config.maxDepth,
    });
    this.trainer = Object.assign({}, agent, {
      trainingRows,
      agentRows,
      documentRows,
      start: { library, access, providers },
      startChild: this.startChild,
    });
  }

  /**
   * Gives the tool runner the start of a child agent. The runner is among what an agent works with, so the
   * factory cannot be one of the runner's own dependencies: it registers the start here instead.
   */
  onModuleInit(): void {
    this.runner.useStartChild(this.startChild);
  }

  /**
   * The object of a task just created, inside the transaction that created it, on the run its start resolved:
   * writes the agent's session from the start's request with whatever its class adds to a new one, and takes
   * the written rows in. The caller hands the object over once the transaction commits (`LiveTasks.adopt`, or
   * `effects.adopt` in a step's commit).
   */
  async createIn(
    type: string,
    task: Omit<LiveTaskIdentity, 'type' | 'input'>,
    input: AgentTaskInput,
    start: SessionStart,
  ): Promise<BaseAgent> {
    const startedAt = Date.now();
    const { run, ...request } = start;
    const identity = { ...task, type, input };
    const agent = this.build({
      task: identity,
      input,
      run,
      training: await inTrainingTree(this.tasks, identity),
    });
    await agent.createSession(request);
    await agent.absorb();
    this.logger.info('agent object created', {
      ...agent.held(),
      durationMs: Date.now() - startedAt,
    });
    return agent;
  }

  /**
   * The object of an existing task, from the database: the version, name, team member and model are its
   * session's (KD-8), the version read once. An agent task without a session is a defect: the restore throws,
   * and the step fails with `handler_error`.
   */
  async restore(task: LiveTaskIdentity): Promise<BaseAgent> {
    const startedAt = Date.now();
    const input = agentTaskInputOf(task.input);
    const session = await this.agent.sessions.get(task.taskId);
    if (session === undefined)
      throw new Error(`Agent ${task.taskId} has no session`);
    const run: RunStart = {
      version: await this.library.version(session.versionId),
      name: session.name,
      subagent: session.origin.subagent,
      model: session.model,
    };
    const agent = this.build({
      task,
      input,
      run,
      training: await inTrainingTree(this.tasks, task),
    });
    await agent.absorb();
    this.logger.info('agent object restored', {
      ...agent.held(),
      durationMs: Date.now() - startedAt,
    });
    return agent;
  }

  private build(run: AgentRun): BaseAgent {
    switch (run.task.type) {
      case CHAT_TASK_TYPE:
        return new ChatAgent(this.chat, run);
      case AGENT_TASK_TYPE:
        return new Agent(this.agent, run);
      case DEEP_AGENT_TASK_TYPE:
        return new DeepAgent(this.deep, run);
      case TRAINER_TASK_TYPE:
        return new Trainer(this.trainer, run);
      default:
        throw new Error(
          `Task ${run.task.taskId} of type "${run.task.type}" is not an agent's`,
        );
    }
  }
}
