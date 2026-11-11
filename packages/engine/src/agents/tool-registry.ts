import { z } from 'zod';
import type { AgentToolDefinition } from '../model/role-agent.js';

/** What a tool does to the world (design-agent-core.md, KD-3, Terms «Класс эффекта»). */
export type ToolEffectClass = 'read' | 'write' | 'task' | 'finish';

/** The result of any tool is at most 16 KiB (design-agent-core.md, Реестр инструментов). */
const TOOL_RESULT_MAX_BYTES = 16 * 1_024;

/** One entry of the closed tool registry: the model sees name, description and schema; the code runs it. */
export interface ToolRegistryEntry {
  readonly name: string;
  /** What the model reads about the tool. */
  readonly description: string;
  /** The schema the arguments of a call must pass; `finish` takes its schema from the definition's result form. */
  readonly argsSchema: z.ZodType<unknown> | 'result_form';
  readonly effect: ToolEffectClass;
  /** Bytes of a result before it is paged or cut; at most {@link TOOL_RESULT_MAX_BYTES}. */
  readonly resultMaxBytes: number;
  /** Allows `{{sources}}` in the prompt of a definition that has the tool (KD-9); the model does not see the mark. */
  readonly readsRunSources?: boolean;
  /**
   * Allows `{{catalog}}` in the prompt of a definition that has the tool: the tool checks the plan against the run's
   * catalog (design-catalog-planning.md, KD-3). The model does not see the mark; the fingerprint does not take it.
   */
  readonly readsRunCatalog?: boolean;
}

/** The closed list of tools by name; a definition names tools only from it (ADR-0009). */
export type ToolRegistry = ReadonlyMap<string, ToolRegistryEntry>;

const NOTE_KINDS = ['finding', 'tried', 'dead_end', 'note'] as const;
const agentName = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);

/** A reference of a note to a record or a claim of this investigation. */
const NoteRefSchema = z.strictObject({ type: z.enum(['record', 'claim']), id: z.string().min(1) });

const INVESTIGATION_VIEWS = ['plan', 'claims', 'record_pages', 'records', 'runs'] as const;

/** The fields each view of `investigation_read` takes besides `view`; `page` is required by `records`. */
const INVESTIGATION_VIEW_FIELDS: Readonly<Record<(typeof INVESTIGATION_VIEWS)[number], readonly string[]>> = {
  plan: [],
  claims: ['cursor'],
  record_pages: ['cursor'],
  records: ['page', 'from', 'cursor'],
  runs: ['cursor', 'run', 'from'],
};

/**
 * The arguments of `investigation_read`: one object at the root, as the provider takes tool arguments (DC-30). The
 * fields a view does not take, and `records` without `page`, are refused here, as a union of one object per view would.
 */
const InvestigationReadArgsSchema = z
  .strictObject({
    view: z.enum(INVESTIGATION_VIEWS),
    cursor: z.string().optional(),
    page: z.string().min(1).optional(),
    run: z.string().min(1).optional(),
    from: z.number().int().nonnegative().optional(),
  })
  .superRefine((args, ctx) => {
    const allowed = INVESTIGATION_VIEW_FIELDS[args.view];
    const foreign = Object.keys(args).filter((key) => key !== 'view' && !allowed.includes(key));
    if (foreign.length > 0) {
      ctx.addIssue({ code: 'unrecognized_keys', keys: foreign, message: `view ${args.view} does not take ${foreign.join(', ')}` });
    }
    if (args.view === 'records' && args.page === undefined) {
      ctx.addIssue({ code: 'invalid_type', expected: 'string', path: ['page'], message: 'view records requires page' });
    }
  });

/** The base tools (design-agent-core.md, Базовые инструменты); their execution is the `ToolExecutor`'s. */
export const BASE_TOOLS: readonly ToolRegistryEntry[] = [
  {
    name: 'memory_read',
    description:
      'Reads the notes of this investigation, newest last, up to 50 per call. Filter by kind, by the authoring agent, ' +
      'or to the notes after a note number.',
    argsSchema: z.strictObject({
      kind: z.enum(NOTE_KINDS).optional(),
      author: agentName.optional(),
      after: z.number().int().nonnegative().optional(),
    }),
    effect: 'read',
    resultMaxBytes: TOOL_RESULT_MAX_BYTES,
  },
  {
    name: 'memory_write',
    description:
      'Writes a note to the memory of this investigation: its kind, a text of up to 2000 characters and up to 20 ' +
      'references to records and claims of this investigation. Returns the note number.',
    argsSchema: z.strictObject({
      kind: z.enum(NOTE_KINDS),
      text: z.string().min(1).max(2_000),
      refs: z.array(NoteRefSchema).max(20),
    }),
    effect: 'write',
    resultMaxBytes: 1_024,
  },
  {
    name: 'investigation_read',
    description:
      'Reads the data of this investigation: the current plan, the claims with their latest statuses, the list of ' +
      'record pages, the records of one page from a number, or the results of finished agent runs. A long result ' +
      'comes in pages with a cursor to continue. The whole result of one run, of any size, comes in pieces of its ' +
      'JSON text: view "runs" with the run and a byte offset - from 0, then the "next" of each piece until it is null.',
    argsSchema: InvestigationReadArgsSchema,
    effect: 'read',
    resultMaxBytes: TOOL_RESULT_MAX_BYTES,
  },
  {
    name: 'call_agent',
    description:
      'Calls another agent with an assignment of up to 8000 characters and returns its result once it finishes, or ' +
      'the reason it was refused or failed.',
    argsSchema: z.strictObject({ agent: agentName, assignment: z.string().min(1).max(8_000) }),
    effect: 'task',
    resultMaxBytes: TOOL_RESULT_MAX_BYTES,
  },
  {
    name: 'finish',
    description:
      'Returns the result of this run in the form of its definition. Call it alone in its turn: next to other calls ' +
      'it is refused.',
    argsSchema: 'result_form',
    effect: 'finish',
    resultMaxBytes: 1_024,
  },
];

/** The registry of `entries`; a repeated name or a result limit over 16 KiB is a defect of the engine's code. */
export function createToolRegistry(entries: readonly ToolRegistryEntry[]): ToolRegistry {
  const registry = new Map<string, ToolRegistryEntry>();
  for (const entry of entries) {
    if (registry.has(entry.name)) {
      throw new Error(`tool ${entry.name} is registered twice`);
    }
    if (entry.resultMaxBytes > TOOL_RESULT_MAX_BYTES) {
      throw new Error(
        `tool ${entry.name} allows a result of ${entry.resultMaxBytes} bytes, over ${TOOL_RESULT_MAX_BYTES}`,
      );
    }
    registry.set(entry.name, entry);
  }
  return registry;
}

/**
 * The tools a definition's model sees: its listed tools from the registry and `finish` with the schema of its result
 * form. A listed tool outside the registry is left out: the load refuses such a definition first.
 */
export function agentToolsOf(
  tools: readonly string[],
  context: { readonly registry: ToolRegistry; readonly resultSchema: z.ZodType<unknown> },
): AgentToolDefinition[] {
  const named = [...tools, 'finish'].flatMap((name) => {
    const entry = context.registry.get(name);
    return entry === undefined ? [] : [entry];
  });
  return named.map((entry) => ({
    name: entry.name,
    description: entry.description,
    inputSchema: entry.argsSchema === 'result_form' ? context.resultSchema : entry.argsSchema,
  }));
}
