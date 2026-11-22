import { AGENT_TASK_TYPE } from '@agent-os/contracts';

import { BaseAgent } from './base-agent';

/**
 * The ordinary agent: runs an `agent` snapshot — a record of the library started by `start_agent`, or a fork —
 * and a `subagent` snapshot of a deep agent's team. Everything it does is the shared step of `BaseAgent`; what it
 * may call (`start_agent`, the snapshot's tools and servers) is the data of its snapshot.
 */
export class Agent extends BaseAgent {
  readonly type = AGENT_TASK_TYPE;
}
