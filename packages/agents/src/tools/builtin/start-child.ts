import { AGENT_TASK_TYPE } from '@agent-os/contracts';

import type { DefinitionCatalog } from '../../definitions/catalog.js';
import { AgentsError } from '../../errors.js';
import { chooseModel } from '../../model/model-choice.js';
import { type SessionInput, sessions } from '../../store/sessions.repository.js';
import type { StartChild, StartChildRequest } from '../tool.js';
import type { StartChildScope } from '../tool-runner.js';

/** What the spawn helper needs besides the transaction, the effects and the caller. */
export interface StartChildDeps {
  readonly catalog: DefinitionCatalog;
  /** `AGENT_MAX_DEPTH`. */
  readonly maxDepth: number;
  /** `AGENT_DEFAULT_MODEL`. */
  readonly defaultModel: string;
  /** `ledger.pricedModels()` of the runtime. */
  readonly pricedModels: () => readonly string[];
}

/**
 * The only start of a child agent inside a step's commit transaction (overview, Common Processing
 * Points): the same fields and refusals as the `start` operation — `UNKNOWN_DEFINITION`, `DEPTH_LIMIT`,
 * `UNKNOWN_MODEL` — then `effects.spawn` of an `agent` task and the child's session with its `task`
 * entry in the same transaction (plan Notes 11), so the caller gets the `agentId` at once. Owner and
 * parent are the caller's. Bound to one call's scope by the tool runner (`startChildFor`).
 */
export function createStartChild(deps: StartChildDeps): (scope: StartChildScope) => StartChild {
  return ({ tx, effects, caller }) =>
    async (request) => {
      const input = childInput(deps, caller.depth, request);
      const agentId = await effects.spawn({ type: AGENT_TASK_TYPE, input });
      await sessions.ensureSession(tx, agentId, input, caller.ownerId);
      return { agentId };
    };
}

function childInput(
  deps: StartChildDeps,
  callerDepth: number,
  request: StartChildRequest,
): SessionInput {
  const definition = deps.catalog.get(request.definition);
  if (definition === undefined) {
    throw new AgentsError('UNKNOWN_DEFINITION', `No definition ${request.definition} in the catalog`);
  }
  if (callerDepth + 1 > deps.maxDepth) {
    throw new AgentsError(
      'DEPTH_LIMIT',
      `A child of an agent at depth ${callerDepth} is deeper than AGENT_MAX_DEPTH ${deps.maxDepth}`,
    );
  }
  const choice = chooseModel({
    launchModel: request.model ?? null,
    definitionModel: definition.model ?? null,
    defaultModel: deps.defaultModel,
    pricedModels: deps.pricedModels(),
  });
  if (choice.kind === 'refused') {
    throw new AgentsError(
      'UNKNOWN_MODEL',
      `Model ${request.model ?? definition.model ?? deps.defaultModel} has no price in the prices file`,
    );
  }
  return {
    definition: definition.name,
    description: request.description,
    prompt: request.prompt,
    model: choice.model,
    ...(request.limits === undefined ? {} : { limits: request.limits }),
    ...(request.forkedFrom === undefined ? {} : { forkedFrom: request.forkedFrom }),
  };
}
