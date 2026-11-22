import {
  AgentContentSchema,
  DeepAgentContentSchema,
  ModelIdSchema,
  RunOriginSchema,
} from '@agent-os/contracts';
import { z } from 'zod';

/**
 * The snapshot of a run (design-runtime.md, Terms «Снимок», KD-1; run-snapshot.md): the record's
 * content in its library form, the run's name and the origin, frozen at the start and written once into
 * the task input. Steps, tools and restarts read only it. It holds no credentials.
 */

/**
 * Every model of a snapshot is a model id: a record's `null` became the default chat model when the
 * snapshot was taken (model-providers design-core.md KD-5), so a run keeps it whatever the default becomes.
 */
const snapshotModel = { model: ModelIdSchema };

const AgentSnapshotContentSchema = AgentContentSchema.extend(snapshotModel);

/** One subagent of a deep agent, as `DeepAgentContent` holds it, with its model. */
const SubagentContentSchema =
  DeepAgentContentSchema.shape.subagents.element.extend(snapshotModel);

const DeepAgentSnapshotContentSchema = DeepAgentContentSchema.safeExtend({
  ...snapshotModel,
  subagents: z.array(SubagentContentSchema),
});

/** A record of an agent's `agents` the starter saw at the start: what its `start_agent` lists. */
const StartableAgentSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  description: z.string(),
});
export type StartableAgent = z.infer<typeof StartableAgentSchema>;

const snapshotFields = {
  /** The run's name: the record's name, or the subagent's name in its team. */
  name: z.string().min(1),
  origin: RunOriginSchema,
};

export const RunSnapshotSchema = z.discriminatedUnion('kind', [
  z.object({
    ...snapshotFields,
    kind: z.literal('agent'),
    content: AgentSnapshotContentSchema,
    /** The records of `content.agents` visible to the starter at the start, in that order. */
    agents: z.array(StartableAgentSchema),
  }),
  /** A deep agent: its whole team is in its content (deep-agents design-agent-types.md KD-1). */
  z.object({
    ...snapshotFields,
    kind: z.literal('deep_agent'),
    content: DeepAgentSnapshotContentSchema,
  }),
  z.object({
    ...snapshotFields,
    kind: z.literal('subagent'),
    content: SubagentContentSchema,
    /**
     * The run learns (self-learning design-core.md KD-2): the servers of the deep agent and its whole
     * team; `null` — it does not.
     */
    learning: z
      .object({ servers: SubagentContentSchema.shape.servers })
      .nullable(),
  }),
]);
export type RunSnapshot = z.infer<typeof RunSnapshotSchema>;
export type AgentSnapshot = Extract<RunSnapshot, { kind: 'agent' }>;
export type DeepAgentSnapshot = Extract<RunSnapshot, { kind: 'deep_agent' }>;
export type SubagentSnapshot = Extract<RunSnapshot, { kind: 'subagent' }>;
