import type {
  AgentVersion,
  BuiltinKey,
  RecordHeader,
  RecordKind,
  ResolvedAgent,
  ResolvedRecord,
  ResolvedSkill,
} from '@agent-os/contracts';

/**
 * The catalogue of agents and deep agents as the runtime sees it (data-model design-agents.md, «Порт
 * `RecordLibrary`»; ADR-0016, ADR-0017). A read for a viewer is made on behalf of the employee who starts the
 * run, so the agent's author does not decide the start: an agent the viewer may not see, a deleted and an
 * unknown one all answer `null`. Each answer carries the id and the number of the agent's active version.
 * `apps/api` implements it with `LibraryService`; the tests use `createLibraryDouble`.
 */
export interface RecordLibrary {
  /**
   * The record by its id, with its active version: a restart, a message's chip, a record's mark, its memory.
   * A skill comes back too; every start path answers it as a missing record (agent-guidance KD-5).
   */
  resolve(viewerId: string, recordId: string): Promise<ResolvedRecord | null>;
  /**
   * The agent of `kind` a call names (KD-5): among the agents of that kind the viewer sees, without the chat,
   * by name without case — his own, else a colleague's created earliest (then by id), else the system one —
   * with its active version.
   */
  resolveByName(
    viewerId: string,
    name: string,
    kind: RecordKind,
  ): Promise<ResolvedRecord | null>;
  /** The default agent with this key and its active version: it exists always, read without a visibility check. */
  resolveBuiltin(builtinKey: BuiltinKey): Promise<ResolvedAgent>;
  /**
   * The skills of a version's list with the text of their active versions, in the order of `skillIds`, read
   * without a visibility check — the skills come with the agent (agent-guidance KD-6) — and without the deleted
   * ones; an id of another kind gives nothing. `viewerId` decides only `mine` of each header.
   */
  skills(
    viewerId: string,
    skillIds: readonly string[],
  ): Promise<ResolvedSkill[]>;
  /** Headers of every agent the viewer sees, by name, agents of one name earliest created first. */
  listVisible(viewerId: string): Promise<RecordHeader[]>;
  /**
   * A version by its id, read without a visibility check: the start checked it, and a version never
   * changes. A conversation's version always exists (its foreign key keeps it).
   */
  version(versionId: string): Promise<AgentVersion>;
}
