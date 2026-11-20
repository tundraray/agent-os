import {
  AgentContentSchema,
  ModelIdSchema,
  RunOriginSchema,
  WorkflowContentSchema,
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

/** One executor of a workflow, as `WorkflowContent` holds it, with its model. */
const ExecutorContentSchema = WorkflowContentSchema.shape.executors.element.extend(snapshotModel);

const WorkflowSnapshotContentSchema = WorkflowContentSchema.safeExtend({
  coordinator: WorkflowContentSchema.shape.coordinator.extend(snapshotModel),
  executors: z.array(ExecutorContentSchema),
});

/** A record of an agent's `agents` the starter saw at the start: what its `start_agent` lists. */
const StartableAgentSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  description: z.string(),
});
export type StartableAgent = z.infer<typeof StartableAgentSchema>;

const snapshotFields = {
  /** The run's name: the record's name, or the executor's name in its team. */
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
  /** The coordinator of a workflow: the whole team is in its content. */
  z.object({ ...snapshotFields, kind: z.literal('workflow'), content: WorkflowSnapshotContentSchema }),
  z.object({
    ...snapshotFields,
    kind: z.literal('executor'),
    content: ExecutorContentSchema,
    /**
     * The run learns (self-learning design-core.md KD-2): the servers of the whole team; `null` — it does
     * not. A snapshot written before the field reads as `null`.
     */
    learning: z
      .object({ servers: ExecutorContentSchema.shape.servers })
      .nullable()
      .default(null),
  }),
]);
export type RunSnapshot = z.infer<typeof RunSnapshotSchema>;
export type AgentSnapshot = Extract<RunSnapshot, { kind: 'agent' }>;
export type WorkflowSnapshot = Extract<RunSnapshot, { kind: 'workflow' }>;
export type ExecutorSnapshot = Extract<RunSnapshot, { kind: 'executor' }>;
