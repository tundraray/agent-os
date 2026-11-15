import { RUN_CODE_TOOL } from '@agent-os/contracts';
import { z } from 'zod';

import { ALL_SERVERS, type AgentDefinition, AgentDefinitionSchema } from './definition.js';

/**
 * The catalog of definitions (Terms): kept in process memory, filled by `register` before `start()`
 * and checked once by `checkCatalog` at the start.
 */
export interface DefinitionCatalog {
  /** Adds a definition; a repeated name or a registration after `seal()` throws. */
  register(definition: AgentDefinition): void;
  get(name: string): AgentDefinition | undefined;
  /** All definitions, in registration order. */
  all(): readonly AgentDefinition[];
  /** Closes registration; `start()` calls it. */
  seal(): void;
}

export function createCatalog(): DefinitionCatalog {
  const definitions = new Map<string, AgentDefinition>();
  let sealed = false;
  return {
    register(definition) {
      if (sealed) {
        throw new Error(
          `Definition ${definition.name} is registered after start(): register definitions before it`,
        );
      }
      if (definitions.has(definition.name)) {
        throw new Error(`Definition ${definition.name} is registered twice`);
      }
      definitions.set(definition.name, parseDefinition(definition));
    },
    get: (name) => definitions.get(name),
    all: () => [...definitions.values()],
    seal() {
      sealed = true;
    },
  };
}

/** The definition of a session's agent; a session whose definition left the catalog is a defect. */
export function definitionOf(
  catalog: DefinitionCatalog,
  session: { readonly taskId: string; readonly definition: string },
): AgentDefinition {
  const definition = catalog.get(session.definition);
  if (definition === undefined) {
    throw new Error(
      `Agent ${session.taskId} has definition ${session.definition}, which is not in the catalog`,
    );
  }
  return definition;
}

function parseDefinition(definition: AgentDefinition): AgentDefinition {
  const result = AgentDefinitionSchema.safeParse(definition);
  if (result.success) return result.data;
  throw new Error(
    `Definition ${definition.name} is invalid — ${z.prettifyError(result.error)}`,
  );
}

export interface CatalogCheckInput {
  readonly definitions: readonly AgentDefinition[];
  /** Names of the built-in and registered tools. */
  readonly toolNames: readonly string[];
  /** Ids of the servers in `MCP_SERVERS_FILE`. */
  readonly serverIds: readonly string[];
  /** `ledger.pricedModels()`. */
  readonly pricedModels: readonly string[];
  /** `AGENT_DEFAULT_MODEL`. */
  readonly defaultModel: string;
}

/**
 * The start check of the catalog (Contract Definitions, `start()`): every tool, agent, server and model
 * a definition names exists, and no definition names `run_code` (code-execution DC-1; `register` already
 * refused a repeated name). The first problem throws, naming the definition
 * (or `AGENT_DEFAULT_MODEL`), and the start stops.
 */
export function checkCatalog(input: CatalogCheckInput): void {
  const priced = new Set(input.pricedModels);
  if (!priced.has(input.defaultModel)) {
    throw new Error(
      `AGENT_DEFAULT_MODEL ${input.defaultModel} has no price in the prices file`,
    );
  }
  const tools = new Set(input.toolNames);
  const servers = new Set(input.serverIds);
  const names = new Set(input.definitions.map((definition) => definition.name));
  for (const definition of input.definitions) {
    const problem = findProblem(definition, { tools, servers, names, priced });
    if (problem !== undefined) {
      throw new Error(`Definition ${definition.name}: ${problem}`);
    }
  }
}

interface Known {
  readonly tools: ReadonlySet<string>;
  readonly servers: ReadonlySet<string>;
  readonly names: ReadonlySet<string>;
  readonly priced: ReadonlySet<string>;
}

function findProblem(definition: AgentDefinition, known: Known): string | undefined {
  if (definition.tools.includes(RUN_CODE_TOOL)) {
    return `names ${RUN_CODE_TOOL} in tools, which every session has without naming it`;
  }
  const tool = definition.tools.find((name) => !known.tools.has(name));
  if (tool !== undefined) return `unknown tool ${tool}`;
  const agent = definition.agents.find((name) => !known.names.has(name));
  if (agent !== undefined) return `unknown agent ${agent}`;
  const server = definition.mcpServers.find(
    (id) => id !== ALL_SERVERS && !known.servers.has(id),
  );
  if (server !== undefined) return `unknown MCP server ${server}`;
  if (definition.model !== undefined && !known.priced.has(definition.model)) {
    return `model ${definition.model} has no price in the prices file`;
  }
  return undefined;
}
