import {
  AGENT_TASK_TYPE,
  type AgentVersion,
  CHAT_TASK_TYPE,
  DEEP_AGENT_TASK_TYPE,
} from '@agent-os/contracts';
import type { Logger } from '@agent-os/common';
import { SettingsRepository } from '@agent-os/db';
import { type LiveTaskIdentity, Trackers } from '@agent-os/runtime';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';

import { AGENTS_CONFIG, AGENTS_LOGGER, RECORD_LIBRARY } from '../agents.tokens';
import type { AgentsConfig } from '../config';
import { DeepAgent, type DeepAgentDeps } from '../deep/deep-agent';
import type { RecordLibrary } from '../start/record-library';
import type { RunStart } from '../start/run-definition';
import { type SessionInput, sessionInputOf } from '../store/sessions';
import { createStartChild } from '../tools/system/start-child';
import { readToolResultSettings } from '../tools/tool-result-settings';
import { ToolRunner } from '../tools/tool-runner';
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

  constructor(
    @Inject(AgentDeps) private readonly agent: AgentDeps,
    /** The version of a task the runtime has no object for is read from it (`restore`). */
    @Inject(RECORD_LIBRARY)
    private readonly library: Pick<RecordLibrary, 'version'>,
    @Inject(Trackers) trackers: Pick<Trackers, 'list'>,
    /** The settings of large results, read for each `task` ending (tool-result-reading R-5). */
    @Inject(SettingsRepository) settingsRows: Pick<SettingsRepository, 'read'>,
    @Inject(ToolRunner)
    private readonly runner: Pick<ToolRunner, 'useStartChild'>,
    @Inject(AGENTS_CONFIG)
    private readonly config: Pick<AgentsConfig, 'maxDepth'>,
    @Inject(AGENTS_LOGGER) logger: Logger,
  ) {
    this.logger = logger.child({ service: 'agents.factory' });
    // The holder has fields only: a copy with what the class adds is all a class needs.
    this.chat = Object.assign({}, agent, { logger });
    this.deep = Object.assign({}, agent, {
      trackers,
      resultSettings: () => readToolResultSettings(settingsRows),
      maxDepth: config.maxDepth,
    });
  }

  /**
   * Gives the tool runner the start of a child agent. The runner is among what an agent works with, so the
   * factory cannot be one of the runner's own dependencies: it registers the start here instead.
   */
  onModuleInit(): void {
    this.runner.useStartChild(
      createStartChild({
        maxDepth: this.config.maxDepth,
        childType: childTypeOf,
        createIn: (type, task, input, version) =>
          this.createIn(type, task, input, version),
      }),
    );
  }

  /**
   * The object of a task just created, inside the transaction that created it, on the version its start
   * resolved: writes the agent's session with whatever its class adds to a new one, and takes the written rows
   * in. The caller hands the object over once the transaction commits (`LiveTasks.adopt`, or `effects.adopt` in
   * a step's commit).
   */
  async createIn(
    type: string,
    task: Omit<LiveTaskIdentity, 'type' | 'input'>,
    input: SessionInput,
    version: AgentVersion,
  ): Promise<BaseAgent> {
    const startedAt = Date.now();
    const agent = this.build({
      task: { ...task, type, input },
      input,
      version,
    });
    await agent.createSession();
    await agent.absorb();
    this.logger.info('agent object created', {
      ...agent.held(),
      durationMs: Date.now() - startedAt,
    });
    return agent;
  }

  /**
   * The object of an existing task, from the database, with the version its input names, read once. An agent
   * without a session yet comes back empty: its first step makes the session.
   */
  async restore(task: LiveTaskIdentity): Promise<BaseAgent> {
    const startedAt = Date.now();
    const input = sessionInputOf(task.input);
    const version = await this.library.version(input.versionId);
    const agent = this.build({ task, input, version });
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
      default:
        throw new Error(
          `Task ${run.task.taskId} of type "${run.task.type}" is not an agent's`,
        );
    }
  }
}
