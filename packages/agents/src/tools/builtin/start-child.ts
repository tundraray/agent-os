import { AGENT_TASK_TYPE } from '@agent-os/contracts';

import type { Database } from '@agent-os/db';

import type { AccessAudit, AccessGate } from '../../access-gate.js';
import type { DefinitionCatalog } from '../../definitions/catalog.js';
import { AgentsError } from '../../errors.js';
import { chooseModel } from '../../model/model-choice.js';
import { type SessionInput, sessions } from '../../store/sessions.repository.js';
import type { StartChild, StartChildRequest } from '../tool.js';
import type { StartChildScope } from '../tool-runner.js';

/** What the session input of a new agent needs: the catalog, the depth limit and the default model. */
export interface SessionInputDeps {
  readonly catalog: DefinitionCatalog;
  /** `AGENT_MAX_DEPTH`. */
  readonly maxDepth: number;
  /** `AGENT_DEFAULT_MODEL`. */
  readonly defaultModel: string;
}

/** What a start inside a step needs: the session input, and the gate `start_agent` checks the model with. */
export interface StartChildDeps extends SessionInputDeps {
  /** `start_agent` reads the caller's session before the commit: a fork runs on the caller's model. */
  readonly database: Database;
  /** `start_agent` asks it about the child's model (design-access.md KD-4). */
  readonly access: Pick<AccessGate, 'model'>;
  /** Gets the `access_denied` record of a start refused for its model (KD-6). */
  readonly audit: AccessAudit;
}

/**
 * The only start of a child agent inside a step's commit transaction (overview, Common Processing
 * Points): the same fields and refusals as the `start` operation (`sessionInputOf`), then
 * `effects.spawn` of an `agent` task and the child's session with its `task`
 * entry in the same transaction (plan Notes 11), so the caller gets the `agentId` at once. Owner and
 * parent are the caller's. Bound to one call's scope by the tool runner (`startChildFor`).
 */
export function createStartChild(deps: StartChildDeps): (scope: StartChildScope) => StartChild {
  return ({ tx, effects, caller }) =>
    async (request) => {
      const input = sessionInputOf(deps, caller.depth, request);
      const agentId = await effects.spawn({ type: AGENT_TASK_TYPE, input });
      await sessions.ensureSession(tx, agentId, input, caller.ownerId);
      return { agentId };
    };
}

/**
 * The session input of a new agent, for the `start` operation and the spawn helper alike: the
 * definition is in the catalog (`UNKNOWN_DEFINITION`) and a child is not deeper than `AGENT_MAX_DEPTH`
 * (`DEPTH_LIMIT`); the model is chosen by `chooseModel` and checked at its calls (KD-4). `parentDepth` —
 * `null` for a root session.
 */
export function sessionInputOf(
  deps: SessionInputDeps,
  parentDepth: number | null,
  request: StartChildRequest,
): SessionInput {
  const definition = deps.catalog.get(request.definition);
  if (definition === undefined) {
    throw new AgentsError('UNKNOWN_DEFINITION', `No definition ${request.definition} in the catalog`);
  }
  if (parentDepth !== null && parentDepth + 1 > deps.maxDepth) {
    throw new AgentsError(
      'DEPTH_LIMIT',
      `A child of an agent at depth ${parentDepth} is deeper than AGENT_MAX_DEPTH ${deps.maxDepth}`,
    );
  }
  return {
    definition: definition.name,
    description: request.description,
    prompt: request.prompt,
    model: chooseModel({
      launchModel: request.model ?? null,
      definitionModel: definition.model ?? null,
      defaultModel: deps.defaultModel,
    }),
    ...(request.limits === undefined ? {} : { limits: request.limits }),
    ...(request.forkedFrom === undefined ? {} : { forkedFrom: request.forkedFrom }),
  };
}
