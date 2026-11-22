import { AGENT_TASK_TYPE, CHAT_TASK_TYPE, DEEP_AGENT_TASK_TYPE } from '@agent-os/contracts';
import type { Logger } from '@agent-os/common';
import type { Transaction } from '@agent-os/db';
import { type LiveTaskIdentity, Trackers } from '@agent-os/runtime';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';

import { AGENTS_CONFIG, AGENTS_LOGGER, RECORD_LIBRARY } from '../agents.tokens';
import type { AgentsConfig } from '../config';
import { DeepAgent, type DeepAgentDeps } from '../deep/deep-agent';
import type { RecordLibrary } from '../start/record-library';
import type { RunSnapshot } from '../start/snapshot';
import { type SessionInput, sessionInputOf } from '../store/sessions';
import { createStartChild } from '../tools/system/start-child';
import { ToolRunner } from '../tools/tool-runner';
import { Agent } from './agent';
import { AgentDeps } from './agent-deps';
import type { AgentRun } from './agent-state';
import type { BaseAgent } from './base-agent';
import { ChatAgent, type ChatAgentDeps } from './chat-agent';

/** The task type a run under a parent is created with: a deep agent's snapshot runs as `DeepAgent`, any other as `Agent`. */
export function childTypeOf(snapshot: RunSnapshot): string {
  return snapshot.kind === 'deep_agent' ? DEEP_AGENT_TASK_TYPE : AGENT_TASK_TYPE;
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
    @Inject(RECORD_LIBRARY) library: Pick<RecordLibrary, 'listVisible'>,
    @Inject(Trackers) trackers: Pick<Trackers, 'list'>,
    @Inject(ToolRunner) private readonly runner: Pick<ToolRunner, 'useStartChild'>,
    @Inject(AGENTS_CONFIG) private readonly config: Pick<AgentsConfig, 'maxDepth'>,
    @Inject(AGENTS_LOGGER) logger: Logger,
  ) {
    this.logger = logger.child({ service: 'agents.factory' });
    // The holder has fields only: a copy with what the class adds is all a class needs.
    this.chat = Object.assign({}, agent, { library, logger });
    this.deep = Object.assign({}, agent, {
      trackers,
      resultSettings: () => agent.toolResultRows.readSettings(agent.database),
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
        createIn: (tx, type, task, input) => this.createIn(tx, type, task, input),
      }),
    );
  }

  /**
   * The object of a task just created, inside the transaction that created it: writes the agent's session with
   * whatever its class adds to a new one, and takes the written rows in. The caller hands the object over once the
   * transaction commits (`LiveTasks.adopt`, or `effects.adopt` in a step's commit).
   */
  async createIn(
    tx: Transaction,
    type: string,
    task: Omit<LiveTaskIdentity, 'type' | 'input'>,
    input: SessionInput,
  ): Promise<BaseAgent> {
    const startedAt = Date.now();
    const agent = this.build({ task: { ...task, type, input }, input });
    await agent.createSession(tx);
    await agent.absorb(tx);
    this.logger.info('agent object created', { ...agent.held(), durationMs: Date.now() - startedAt });
    return agent;
  }

  /**
   * The object of an existing task, from the database. An agent without a session yet comes back empty: its
   * first step makes the session.
   */
  async restore(task: LiveTaskIdentity): Promise<BaseAgent> {
    const startedAt = Date.now();
    const agent = this.build({ task, input: sessionInputOf(task.input) });
    await agent.absorb(this.agent.database);
    this.logger.info('agent object restored', { ...agent.held(), durationMs: Date.now() - startedAt });
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
        throw new Error(`Task ${run.task.taskId} of type "${run.task.type}" is not an agent's`);
    }
  }
}
