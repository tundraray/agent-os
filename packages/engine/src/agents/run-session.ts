import { type Database, researchEngineRuns, researchInvestigations, researchLlmTranscripts } from '@agent-os/db';
import type { RuntimeTx } from '@agent-os/runtime';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { type AgentDefinition, type AgentProcessConfig, AgentProcessConfigSchema } from '../config/agent-config.schema.js';
import { renderPromptTemplate } from '../config/prompt-template.js';
import type { SourceMode } from '../config/source-check.js';
import type { AgentToolCall, AgentToolDefinition, JsonValue } from '../model/role-agent.js';
import { type SnapshotEntry, SnapshotSchema } from './fingerprint.js';
import {
  buildSessionView,
  type SessionMessage,
  type SessionOpening,
  type SessionView,
  type WindowStage,
} from './session-window.js';
import type { SessionMessageInput, SessionMessageRow } from './session.repository.js';
import type { ToolCallRow } from './tool-calls.repository.js';

/**
 * What a run's session is made of and how the stored rows become the window rule's input (design-agent-core.md, KD-2,
 * Data Model). A session holds its opening (the assignment or the prologue's first message), the model's answers with
 * their calls, the calls' results and the code's notices; every message is written once and never changed.
 */

/** The investigation as a run of its agent tree sees it. */
export interface RunFrame {
  readonly config: AgentProcessConfig;
  readonly resourceId: string;
  readonly threadId: string;
  readonly query: string;
  readonly sourceMode: SourceMode;
  /** The definition memory snapshot of the start, by agent name (DC-24); empty for a start without one. */
  readonly snapshot: Readonly<Record<string, readonly SnapshotEntry[]>>;
}

/** The frame of the run's investigation: its engine row (frozen agents-form configuration) and its thread and query. */
export async function readRunFrame(db: Database, investigationId: string): Promise<RunFrame> {
  const [row] = await db
    .select({ run: researchEngineRuns, threadId: researchInvestigations.threadId, query: researchInvestigations.query })
    .from(researchEngineRuns)
    .innerJoin(researchInvestigations, eq(researchInvestigations.investigationId, researchEngineRuns.investigationId))
    .where(eq(researchEngineRuns.investigationId, investigationId));
  if (row === undefined) throw new Error(`investigation ${investigationId} has no engine row`);
  return {
    config: AgentProcessConfigSchema.parse(row.run.processConfig),
    resourceId: row.run.resourceId,
    threadId: row.threadId,
    query: row.query,
    sourceMode: row.run.sourceMode as SourceMode,
    snapshot: SnapshotSchema.parse(row.run.definitionMemorySnapshot ?? {}),
  };
}

const HeldStageSchema = z.object({ view: z.object({ stage: z.number().int().min(0).max(4) }) });

/**
 * The window stage the run reached: the stage of the view of its last turn transcript (plan Notes 1.8) — a stage once
 * reached holds to the end of the run, across attempts. 0 before the first turn.
 */
export async function readHeldStage(db: Database | RuntimeTx, runTaskId: string): Promise<WindowStage> {
  const [last] = await db
    .select({ input: researchLlmTranscripts.input })
    .from(researchLlmTranscripts)
    .where(eq(researchLlmTranscripts.taskId, runTaskId))
    .orderBy(desc(researchLlmTranscripts.createdAt), desc(researchLlmTranscripts.callId))
    .limit(1);
  const parsed = HeldStageSchema.safeParse(last?.input);
  return parsed.success ? (parsed.data.view.stage as WindowStage) : 0;
}

/** The notices the code writes into a session without a tool call (Contract «Сообщения кода в сессии»). */
export const NOTICES = {
  no_tool_call: '[no_tool_call] Your answer called no tool. Every turn calls a tool; finish returns the result.',
  last_turn: '[last_turn] This is the last turn: return the result with finish.',
} as const;
export type NoticeCode = keyof typeof NOTICES;

/** A model answer as the session stores it: the turn, the text and the calls with their numbers in the run. */
const AnswerContentSchema = z.object({
  turn: z.number().int().positive(),
  text: z.string(),
  toolCalls: z.array(
    z.object({ toolCallId: z.string(), toolName: z.string(), args: z.unknown(), callIndex: z.number().int().nonnegative() }),
  ),
});
type AnswerContent = z.infer<typeof AnswerContentSchema>;

const TextContentSchema = z.object({ text: z.string() });
const NoticeContentSchema = z.object({ turn: z.number().int().nonnegative(), code: z.string(), text: z.string() });

/** The message of a turn's answer. */
export function answerMessage(
  turn: number,
  answer: { readonly text: string; readonly toolCalls: readonly AgentToolCall[] },
  firstCallIndex: number,
): SessionMessageInput & { readonly content: AnswerContent } {
  return {
    kind: 'model_answer',
    content: {
      turn,
      text: answer.text,
      toolCalls: answer.toolCalls.map((call, index) => ({ ...call, callIndex: firstCallIndex + index })),
    },
  };
}

/** A notice of the code, kept with the turn it follows. */
export function noticeMessage(turn: number, code: NoticeCode): SessionMessageInput {
  return { kind: 'code_notice', content: { turn, code, text: NOTICES[code] } };
}

/** The stored session as the window rule reads it. */
export interface RunSession {
  readonly opening: SessionOpening | null;
  readonly messages: readonly SessionMessage[];
  /** Turns the model answered so far. */
  readonly turnsTaken: number;
  /** Notices already written, as `turn:code`. */
  readonly notices: ReadonlySet<string>;
}

/** What a tool result tells the model: its outcome with the result or the reason, without the row's own fields. */
function resultOutput(content: unknown): JsonValue {
  const { callIndex: _index, toolName: _tool, ...body } = content as Record<string, unknown>;
  return body as JsonValue;
}

/**
 * The window rule's input from the stored rows: each result is matched to its call by the call row (turn and number) and
 * to the model's own call id by the answer of that turn. A child's result comes from the child's agent; every other
 * result from the engine.
 */
export function toRunSession(rows: readonly SessionMessageRow[], calls: readonly ToolCallRow[]): RunSession {
  let opening: SessionOpening | null = null;
  const messages: SessionMessage[] = [];
  const notices = new Set<string>();
  const modelIds = new Map<number, string>();
  const callsById = new Map(calls.map((call) => [call.id, call]));
  let turnsTaken = 0;
  for (const row of rows) {
    switch (row.kind) {
      case 'assignment':
      case 'prologue':
        opening = { kind: row.kind, text: TextContentSchema.parse(row.content).text };
        break;
      case 'model_answer': {
        const answer = AnswerContentSchema.parse(row.content);
        turnsTaken = Math.max(turnsTaken, answer.turn);
        for (const call of answer.toolCalls) modelIds.set(call.callIndex, call.toolCallId);
        const toolCalls = answer.toolCalls.map(({ toolCallId, toolName, args }) => ({ toolCallId, toolName, args }));
        messages.push({ seq: row.seq, kind: 'answer', turn: answer.turn, text: answer.text, toolCalls });
        break;
      }
      case 'tool_result': {
        const call = row.toolCallId === null ? undefined : callsById.get(row.toolCallId);
        if (call === undefined) throw new Error(`result message ${row.seq} of run ${row.runTaskId} has no call`);
        const author = call.toolName === 'call_agent' ? String((call.arguments as { agent?: unknown }).agent) : 'engine';
        messages.push({
          seq: row.seq,
          kind: 'result',
          turn: call.turn,
          toolCallId: modelIds.get(call.callIndex) ?? call.id,
          toolName: call.toolName,
          output: resultOutput(row.content),
          author,
        });
        break;
      }
      case 'code_notice': {
        const notice = NoticeContentSchema.parse(row.content);
        notices.add(`${notice.turn}:${notice.code}`);
        messages.push({ seq: row.seq, kind: 'notice', turn: notice.turn, text: notice.text });
        break;
      }
      default:
        throw new Error(`session message ${row.seq} of run ${row.runTaskId} has an unknown kind ${row.kind}`);
    }
  }
  return { opening, messages, turnsTaken, notices };
}

/**
 * Where the system block of a view comes from: a turn renders the definition's prompt with the value of `{{sources}}`,
 * and a recorded turn keeps the block it went to the model with, so no field is substituted again at the read.
 */
export type ViewSystem = { readonly sourcesValue: string } | { readonly recordedInstructions: string };

/**
 * The view of a run's next turn by the window rule (KD-5), from the held stage: the definition's prompt rendered for the
 * investigation, its `deployment` entries in the system block and its owner's `user` entries in the envelope, its tools
 * and its session. The transcript read rebuilds the view of a recorded turn the same way, over its recorded system block.
 */
export function sessionViewOf(input: {
  readonly frame: RunFrame;
  readonly agentName: string;
  readonly definition: AgentDefinition;
  readonly tools: readonly AgentToolDefinition[];
  readonly session: RunSession;
  readonly heldStage: WindowStage;
  readonly system: ViewSystem;
  /** The window to fit; the definition's by default. */
  readonly windowTokens?: number;
}): SessionView {
  const { frame, definition, session, system } = input;
  if (session.opening === null) throw new Error(`the session of agent ${input.agentName} has no opening message`);
  const entries = frame.snapshot[input.agentName] ?? [];
  return buildSessionView({
    ...('recordedInstructions' in system
      ? { prompt: '', recordedInstructions: system.recordedInstructions }
      : {
          prompt: renderPromptTemplate(
            definition.prompt,
            {
              goal: frame.config.goal,
              query: frame.query,
              sourceMode: frame.sourceMode,
              answerSections: frame.config.answer.sections.join(', '),
              sources: system.sourcesValue,
            },
          ),
        }),
    deploymentEntries: entries.filter((entry) => entry.scope === 'deployment'),
    userEntries: entries.filter((entry) => entry.scope === 'user'),
    tools: input.tools,
    opening: session.opening,
    messages: session.messages,
    windowTokens: input.windowTokens ?? definition.limits.windowTokens,
    marginTokens: definition.limits.marginTokens,
    heldStage: input.heldStage,
  });
}
