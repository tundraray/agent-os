import {
  AgentContentSchema,
  RunOriginSchema,
  WorkflowContentSchema,
} from '@agent-os/contracts';
import { z } from 'zod';

/**
 * The snapshot of a run (design-runtime.md, Terms «Снимок», KD-1; run-snapshot.md): the record's
 * content in its library form, the run's name and the origin, frozen at the start and written once into
 * the task input. Steps, tools and restarts read only it. It holds no credentials.
 */

/** One executor of a workflow, as `WorkflowContent` holds it. */
const ExecutorContentSchema = WorkflowContentSchema.shape.executors.element;

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
    content: AgentContentSchema,
    /** The records of `content.agents` visible to the starter at the start, in that order. */
    agents: z.array(StartableAgentSchema),
  }),
  /** The coordinator of a workflow: the whole team is in its content. */
  z.object({ ...snapshotFields, kind: z.literal('workflow'), content: WorkflowContentSchema }),
  z.object({ ...snapshotFields, kind: z.literal('executor'), content: ExecutorContentSchema }),
]);
export type RunSnapshot = z.infer<typeof RunSnapshotSchema>;
export type AgentSnapshot = Extract<RunSnapshot, { kind: 'agent' }>;
export type WorkflowSnapshot = Extract<RunSnapshot, { kind: 'workflow' }>;
export type ExecutorSnapshot = Extract<RunSnapshot, { kind: 'executor' }>;
