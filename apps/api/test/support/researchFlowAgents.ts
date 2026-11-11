import { randomUUID } from 'node:crypto';
import type { TokenCounter } from '@agent-os/engine';
import { FIXTURE_SOURCE_ID } from '@agent-os/sources';
import type { MockLanguageModelV4 } from 'ai/test';
import type { AgentPrompt } from './researchFlowConfig.js';

/**
 * The agent program of the shipped v3 for the model doubles of `apps/api` (`selfCheckModels.ts`, `engineScriptedRoles.ts`;
 * design-research-flow.md, Test Strategy). `packages/engine/test/support/scriptedModel.ts` is another package's test file
 * (ADR-0004), so the reading of a call is repeated here.
 *
 * The program is a function of the call: the agent is found by the prompt its system block starts with, and every next
 * step by the results of its own session in the prompt. Concurrent runs of one agent take their steps in arrival order, so
 * no step may depend on a queue or on what another run did. The double reads structure only: the tool results' fields, and
 * the packets' slots through the {@link ResearchScript} that recognises its own script.
 */

type GenerateOptions = Parameters<MockLanguageModelV4['doGenerate']>[0];
type GenerateResult = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>;

/** One tool call of an agent's answer. */
export interface ScriptedToolCall {
  readonly tool: string;
  readonly args: unknown;
}

/** A definition's template as literals around its fields: what every rendering of it holds, whatever the values. */
const literalsOf = (template: string): readonly string[] =>
  template.split(/\{\{[^{}]*\}\}/);

/** Whether `text` starts with a rendering of the template these literals come from. */
function startsWithTemplate(
  text: string,
  [first = '', ...rest]: readonly string[],
): boolean {
  if (!text.startsWith(first)) return false;
  let from = first.length;
  for (const literal of rest) {
    const at = text.indexOf(literal, from);
    if (at < 0) return false;
    from = at + literal.length;
  }
  return true;
}

/** Finds the agent of a turn by its system block; null when none of the known definitions starts it. */
export type AgentRecognizer = (system: string) => string | null;

/**
 * The recogniser of these definitions. It knows each by the literals of its whole template, because `worker` and
 * `subworker` share the text before their first field. Two agents one template would match are refused, loudly.
 */
export function recognizeAgents(
  prompts: readonly AgentPrompt[],
): AgentRecognizer {
  const known = prompts.map(({ agent, prompt }) => ({
    agent,
    literals: literalsOf(prompt),
  }));
  for (const one of known) {
    const twin = known.find(
      (other) =>
        other.agent !== one.agent &&
        startsWithTemplate(one.literals.join(''), other.literals),
    );
    if (twin !== undefined) {
      throw new Error(
        `research-flow double: the prompts of agents ${one.agent} and ${twin.agent} start alike`,
      );
    }
  }
  return (system) =>
    known.find(({ literals }) => startsWithTemplate(system, literals))?.agent ??
    null;
}

/** A tool result of the session: its body as the engine wrote it. */
interface ViewedResult {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly outcome: string;
  readonly result?: unknown;
  readonly reason?: string;
  readonly detail?: unknown;
}

interface ViewedChild {
  readonly agent: string;
  readonly assignment: string;
  readonly outcome: string;
}

interface ViewedRun {
  readonly run: string;
  readonly agent: string;
}

/** An agent's call with its session parsed: the ids a next step needs exist only in the earlier results. */
export interface AgentCallView {
  readonly agent: string;
  /** The run's first message, out of its envelope: the assignment, or the first message of a prologue. */
  readonly assignment: string;
  resultsOf(toolName: string): readonly ViewedResult[];
  /** The page ids of the `gather` calls that returned one. */
  readonly pages: readonly string[];
  /** The claim ids `claims_write` returned, in the order of the calls. */
  readonly claimIds: readonly string[];
  /** The ended `call_agent` calls, refused ones too. */
  readonly children: readonly ViewedChild[];
  /** The finished runs of the investigation, as the session's `investigation_read` calls listed them. */
  readonly runs: readonly ViewedRun[];
}

const unescapeData = (text: string): string =>
  text
    .replaceAll('&quot;', '"')
    .replaceAll('&gt;', '>')
    .replaceAll('&lt;', '<')
    .replaceAll('&amp;', '&');

/** The data of an envelope (`envelope` of session-window.ts); undefined for a text that is not one whole envelope. */
function dataOf(text: string): string | undefined {
  const close = '\n</data>';
  const bodyStart = text.indexOf('>\n');
  if (!text.startsWith('<data source=') || bodyStart < 0) return undefined;
  if (!text.endsWith(close)) return undefined;
  return unescapeData(text.slice(bodyStart + 2, -close.length));
}

function firstUserText(prompt: GenerateOptions['prompt']): string {
  const first = prompt.find((message) => message.role === 'user');
  if (first === undefined) return '';
  return first.content
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join('\n');
}

function viewedResults(
  prompt: GenerateOptions['prompt'],
): readonly ViewedResult[] {
  return prompt.flatMap((message) => {
    if (message.role !== 'tool') return [];
    return message.content.flatMap((part) => {
      if (part.type !== 'tool-result') return [];
      const value = 'value' in part.output ? part.output.value : undefined;
      const text = typeof value === 'string' ? value : JSON.stringify(value);
      const data = dataOf(text);
      if (data === undefined) {
        throw new Error(
          `research-flow double: the result of ${part.toolName} is not whole in this prompt`,
        );
      }
      return [
        {
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          ...(JSON.parse(data) as { outcome: string }),
        },
      ];
    });
  });
}

/** The arguments of each `call_agent` of the prompt, by its call id. */
function calledAgents(
  prompt: GenerateOptions['prompt'],
): ReadonlyMap<
  string,
  { readonly agent: string; readonly assignment: string }
> {
  return new Map(
    prompt.flatMap((message) => {
      if (message.role !== 'assistant' || typeof message.content === 'string') {
        return [];
      }
      return message.content.flatMap((part) =>
        part.type === 'tool-call' && part.toolName === 'call_agent'
          ? [
              [
                part.toolCallId,
                (typeof part.input === 'string'
                  ? JSON.parse(part.input)
                  : part.input) as { agent: string; assignment: string },
              ] as const,
            ]
          : [],
      );
    }),
  );
}

/** {@link AgentCallView} of a call recognised as the turn of `agent`. */
export function agentCallView(
  options: GenerateOptions,
  agent: string,
): AgentCallView {
  const results = viewedResults(options.prompt);
  const resultsOf = (toolName: string): readonly ViewedResult[] =>
    results.filter((result) => result.toolName === toolName);
  const opening = firstUserText(options.prompt);
  const called = calledAgents(options.prompt);
  const listedRuns = resultsOf('investigation_read')
    .map((read) => read.result as { view?: string; items?: ViewedRun[] })
    .filter((body) => body?.view === 'runs')
    .flatMap((body) => body.items ?? []);
  return {
    agent,
    assignment: dataOf(opening) ?? opening,
    resultsOf,
    pages: resultsOf('gather').flatMap((result) => {
      const page = (result.result as { page?: unknown } | undefined)?.page;
      return typeof page === 'string' ? [page] : [];
    }),
    claimIds: resultsOf('claims_write').flatMap(
      (result) =>
        (result.result as { claimIds?: string[] } | undefined)?.claimIds ?? [],
    ),
    children: resultsOf('call_agent').map(({ toolCallId, outcome }) => {
      const callee = called.get(toolCallId);
      if (callee === undefined) {
        throw new Error(
          `research-flow double: call_agent result ${toolCallId} has no call in this prompt`,
        );
      }
      return { ...callee, outcome };
    }),
    runs: [...new Map(listedRuns.map((run) => [run.run, run])).values()],
  };
}

/** One `gather` of the worker: the source, its tool and the tool's arguments. */
export interface WorkerGather {
  readonly sourceId: string;
  readonly toolName: string;
  readonly args: Readonly<Record<string, unknown>>;
}

/** What the program of one scenario does; the double recognises its own texts in the packets. */
export interface ResearchScript {
  /** What the worker collects with `gather` from `fixture`, again until a call returns a page. */
  read(): {
    readonly toolName: string;
    readonly args: Readonly<Record<string, unknown>>;
  };
  /**
   * When given, replaces {@link read}: the worker's gathers in order, the next one chosen by how many `gather` results its
   * session holds, refused ones too. The worker then reads every page it got and points its claims at all of them.
   */
  gathers?(): readonly WorkerGather[];
  /** The claims the worker writes, in this order; none closes the investigation `inconclusive`. */
  claimTexts(): readonly string[];
  /** The checker's closed assessment of the packet (`<claim>`, `<data>`). */
  assess(packet: string): unknown;
  /** The answer agent's draft of the packet (`<assignment>`). */
  draft(packet: string): unknown;
  /** The worker asks a tool outside its definition before it finishes (`tool_not_in_definition`). */
  workerAsksOutsideTool(): boolean;
}

const WORKER_ASSIGNMENT = 'Collect the records and state what they show';
const SYNTHESIS_ASSIGNMENT = 'Write the answer';
/** A tool of the registry the worker's definition does not hold. */
const OUTSIDE_TOOL = 'plan_write';
const NEEDS_VERIFICATION = 'needs_verification';

const callAgent = (agent: string, assignment: string): ScriptedToolCall => ({
  tool: 'call_agent',
  args: { agent, assignment },
});

/** `finish` of the form `text`: no `refs`, so none can be foreign (DC-4). */
const FINISH_TEXT: ScriptedToolCall = {
  tool: 'finish',
  args: { summary: 'The branch is done', refs: [] },
};

function plannerTurn(view: AgentCallView): readonly ScriptedToolCall[] {
  if (view.resultsOf('plan_write').length > 0) return [FINISH_TEXT];
  return [
    {
      tool: 'plan_write',
      args: {
        readinessCriteria: ['the cause is found or ruled out'],
        branches: [
          {
            question: 'What do the records show?',
            approach: 'read',
            sources: [FIXTURE_SOURCE_ID],
            sourceReason: 'it holds the records',
          },
        ],
        reason: 'there is no plan yet',
      },
    },
  ];
}

interface NumberedRecord {
  readonly number: number;
  readonly record?: { readonly traceId?: unknown };
}

/** The records of each `investigation_read` of the session, in the order of the reads: read `i` is of page `i`. */
const readRecords = (view: AgentCallView): readonly NumberedRecord[][] =>
  view
    .resultsOf('investigation_read')
    .map((read) => (read.result as { items?: NumberedRecord[] }).items ?? []);

/** The first record of the session's reads that carries a trace: the record the claims point at, and its read. */
function tracedRecord(reads: readonly NumberedRecord[][]): {
  readonly read: number;
  readonly number: number;
  readonly traceId: string;
} {
  for (const [read, items] of reads.entries()) {
    for (const { number, record } of items) {
      if (typeof record?.traceId === 'string') {
        return { read, number, traceId: record.traceId };
      }
    }
  }
  throw new Error(
    'research-flow double: the worker read no record with a trace',
  );
}

/** The worker's next gather; null once it has gathered what the script asks. */
function nextGather(
  view: AgentCallView,
  script: ResearchScript,
): WorkerGather | null {
  if (script.gathers === undefined) {
    return view.pages.length === 0
      ? { sourceId: FIXTURE_SOURCE_ID, ...script.read() }
      : null;
  }
  return script.gathers()[view.resultsOf('gather').length] ?? null;
}

/**
 * The claims' pointer: the traced record on its page, and the first record of every other page read, so each page the
 * worker got is evidence of the claims.
 */
function claimsPointer(view: AgentCallView): {
  readonly traceId: string;
  readonly pointer: readonly unknown[];
} {
  const reads = readRecords(view);
  const traced = tracedRecord(reads);
  const pointer = view.pages.flatMap((pageId, read) => {
    if (read === traced.read) return [{ pageId, records: [traced.number] }];
    const first = reads[read]?.[0];
    return first === undefined ? [] : [{ pageId, records: [first.number] }];
  });
  return { traceId: traced.traceId, pointer };
}

function workerTurn(
  view: AgentCallView,
  script: ResearchScript,
): readonly ScriptedToolCall[] {
  const gather = nextGather(view, script);
  if (gather !== null) {
    const { sourceId, toolName, args } = gather;
    return [
      {
        tool: 'gather',
        args: { sourceId, toolName, args, completeness: 'sample' },
      },
    ];
  }
  const texts = script.claimTexts();
  if (texts.length > 0 && view.resultsOf('claims_write').length === 0) {
    const read = view.resultsOf('investigation_read').length;
    const page = view.pages[read];
    if (page !== undefined) {
      return [{ tool: 'investigation_read', args: { view: 'records', page } }];
    }
    const { traceId, pointer } = claimsPointer(view);
    return [
      {
        tool: 'claims_write',
        args: {
          claims: texts.map((text) => ({
            text,
            atoms: [{ kind: 'text', value: traceId }],
            pointer,
          })),
        },
      },
    ];
  }
  const unchecked = view.claimIds.find(
    (claimId) => !view.children.some((child) => child.assignment === claimId),
  );
  if (unchecked !== undefined) return [callAgent('verifier', unchecked)];
  if (
    script.workerAsksOutsideTool() &&
    view.resultsOf(OUTSIDE_TOOL).length === 0
  ) {
    return [
      {
        tool: OUTSIDE_TOOL,
        args: { readinessCriteria: [], branches: [], reason: 'out of bounds' },
      },
    ];
  }
  return [FINISH_TEXT];
}

/** The claims a refused close named for verification (`needs_verification`, the draft's new claims). */
function claimsOfRefusedClose(view: AgentCallView): readonly string[] {
  return view.resultsOf('finish').flatMap(({ detail }) => {
    const refused = detail as
      { reason?: string; detail?: { claimIds?: string[] } } | undefined;
    return refused?.reason === NEEDS_VERIFICATION
      ? (refused.detail?.claimIds ?? [])
      : [];
  });
}

/**
 * The root: planner, one worker, then the close — `inconclusive` when the script states nothing, otherwise a draft of the
 * answer agent. A close refused `needs_verification` has its new claims checked and a new draft written: the draft must
 * come after the refusal (gate 3).
 */
function controllerTurn(
  view: AgentCallView,
  script: ResearchScript,
): readonly ScriptedToolCall[] {
  const called = (agent: string) =>
    view.children.filter((child) => child.agent === agent);
  if (called('planner').length === 0) {
    return [callAgent('planner', view.assignment)];
  }
  if (called('worker').length === 0) {
    return [callAgent('worker', WORKER_ASSIGNMENT)];
  }
  if (script.claimTexts().length === 0) {
    return [{ tool: 'finish', args: { inconclusive: true } }];
  }
  const refused = claimsOfRefusedClose(view);
  const unchecked = refused.find(
    (claimId) =>
      !called('verifier').some((child) => child.assignment === claimId),
  );
  if (unchecked !== undefined) return [callAgent('verifier', unchecked)];
  const drafts = refused.length > 0 ? 2 : 1;
  if (called('synthesis').length < drafts) {
    return [callAgent('synthesis', SYNTHESIS_ASSIGNMENT)];
  }
  const listed = view.runs.filter((run) => run.agent === 'synthesis');
  const answer = listed.length < drafts ? undefined : listed.at(-1);
  if (answer === undefined) {
    return [{ tool: 'investigation_read', args: { view: 'runs' } }];
  }
  return [{ tool: 'finish', args: { answer: answer.run } }];
}

/** The tool calls of the turn this view is at. */
export function researchAgentTurn(
  view: AgentCallView,
  script: ResearchScript,
): readonly ScriptedToolCall[] {
  switch (view.agent) {
    case 'controller':
      return controllerTurn(view, script);
    case 'planner':
      return plannerTurn(view);
    case 'worker':
      return workerTurn(view, script);
    case 'verifier':
      return [{ tool: 'finish', args: script.assess(view.assignment) }];
    case 'synthesis':
      return [{ tool: 'finish', args: script.draft(view.assignment) }];
    default:
      throw new Error(`research-flow double: no program for ${view.agent}`);
  }
}

/** The model's answer with these tool calls, each with a fresh id and its arguments as JSON text. */
export function toolCallsAnswer(
  toolCalls: readonly ScriptedToolCall[],
  usage: GenerateResult['usage'],
): GenerateResult {
  return {
    content: toolCalls.map(({ tool, args }) => ({
      type: 'tool-call' as const,
      toolCallId: `call_${randomUUID()}`,
      toolName: tool,
      input: JSON.stringify(args),
    })),
    finishReason: { unified: 'tool-calls', raw: 'tool_use' },
    usage,
    warnings: [],
  };
}

/**
 * One token per character of everything an agent turn sends: its system block, its messages and its tool schemas, as a
 * role call is counted by the characters of its instructions and messages. No provider is called to count.
 */
export const agentTurnCharacters = (
  request: Parameters<TokenCounter['countTurnInputTokens']>[0],
): number =>
  request.system.length +
  JSON.stringify(request.messages).length +
  JSON.stringify(request.tools).length;
