import type { Verdict } from '@agent-os/contracts';
import type { StepContext } from '@agent-os/runtime';
import { z } from 'zod';

import { callUnlessAborted } from '../agent/step-common';
import type {
  ModelAnswer,
  ModelCallRequest,
  ModelCallResult,
  ModelClient,
} from '../model/model-client';
import type { AgentTurnMessage } from '../model/mastra-turn';
import { envelope, MODEL_AUTHOR } from '../model/provider-messages';

/** The most characters of each text the judge gets (design-training.md, KD-4). */
const JUDGE_DOCUMENT_MAX_CHARS = 40_000;

const EMPLOYEE_AUTHOR = 'employee';

const REASON_MAX_CHARS = 1000;

const JUDGE_TOOL = {
  name: 'verdict',
  description:
    'Give your verdict on the two answers: which one serves the employee better, or that they are equal, and why in one sentence.',
  schema: z.object({
    better: z
      .enum(['first', 'second', 'equal'])
      .describe(
        'first — answer 1 is better, second — answer 2, equal — neither',
      ),
    reason: z
      .string()
      .trim()
      .min(1)
      .max(REASON_MAX_CHARS)
      .describe('Why, in one sentence'),
  }),
};
type JudgeAnswer = z.infer<typeof JUDGE_TOOL.schema>;

const INSTRUCTIONS = [
  'You judge two answers to the same task an employee gave an agent.',
  "The original task, the report the employee got then and the employee's later messages show what the employee wanted.",
  'Answer 1 and answer 2 are reports of two new runs of the same task. A run that failed shows its failure instead of a report.',
  'Decide which answer serves what the employee wanted better, or that they are equal. Do not prefer an answer for its length.',
  'In the reason, describe the difference itself: never refer to the answers by number or position.',
  'Call the verdict tool once.',
].join('\n');

/** What the judge compares: the past task, its report and re-asks, and the reports of its two replays. */
export interface Pair {
  readonly task: string;
  readonly original: string;
  readonly reAsks: readonly string[];
  readonly base: string;
  readonly proposed: string;
}

/** A decided pair: the verdict in terms of the versions and its reason. */
export interface Decision {
  readonly verdict: Verdict;
  readonly reason: string;
}

/** How one structured answer of the model ended (tool-call-answer.md, «Раунд»). */
type Round<T> =
  | { readonly kind: 'answer'; readonly value: T }
  | { readonly kind: 'invalid_answer' }
  | Exclude<ModelCallResult, ModelAnswer>;

/**
 * One structured answer of the model by a tool call (tool-call-answer.md): the model is offered the one tool; an
 * answer without its call, with arguments that do not fit, or cut off gets one more attempt with the error — as
 * the result of its calls, or as a new message when it made none; a second such answer is `invalid_answer`.
 * `undefined` — the step was cut off.
 */
async function toolAnswer<T>(
  modelClient: Pick<ModelClient, 'call'>,
  ctx: StepContext,
  request: Omit<ModelCallRequest, 'messages' | 'tools'>,
  tool: {
    readonly name: string;
    readonly description: string;
    readonly schema: z.ZodType<T>;
  },
  message: string,
): Promise<Round<T> | undefined> {
  const messages: AgentTurnMessage[] = [{ role: 'user', content: message }];
  for (let attempt = 1; ; attempt += 1) {
    const result = await callUnlessAborted(ctx, () =>
      modelClient.call({
        ...request,
        messages,
        tools: [
          {
            name: tool.name,
            description: tool.description,
            inputSchema: tool.schema,
          },
        ],
      }),
    );
    if (result === undefined || result.kind !== 'answer') return result;
    const call = result.toolCalls.find((each) => each.toolName === tool.name);
    const parsed =
      call === undefined || result.cutOff
        ? undefined
        : tool.schema.safeParse(call.args);
    if (parsed?.success === true) return { kind: 'answer', value: parsed.data };
    ctx.logger.info('structured answer refused', {
      tool: tool.name,
      attempt,
      called: call !== undefined,
      cutOff: result.cutOff,
    });
    if (attempt === 2) return { kind: 'invalid_answer' };
    const error =
      parsed === undefined
        ? `Call the ${tool.name} tool once, with short arguments.`
        : `The arguments of ${tool.name} do not fit: ${z.prettifyError(parsed.error)}. Call it again.`;
    messages.push({
      role: 'assistant',
      content: result.text,
      toolCalls: result.toolCalls,
    });
    messages.push(
      result.toolCalls.length === 0
        ? { role: 'user', content: error }
        : {
            role: 'tool',
            results: result.toolCalls.map((each) => ({
              toolCallId: each.toolCallId,
              toolName: each.toolName,
              output: error,
            })),
          },
    );
  }
}

/** A text cut to the judge's limit, with a note when it was cut. */
function cut(text: string): string {
  return text.length <= JUDGE_DOCUMENT_MAX_CHARS
    ? text
    : `${text.slice(0, JUDGE_DOCUMENT_MAX_CHARS)}\n[Cut: only the first ${JUDGE_DOCUMENT_MAX_CHARS} characters are shown.]`;
}

/** The judge's answer in terms of the versions, by the order the pair was shown in. */
export function verdictOf(
  answer: JudgeAnswer,
  proposedFirst: boolean,
): Verdict {
  if (answer.better === 'equal') return 'equal';
  return (answer.better === 'first') === proposedFirst
    ? 'proposed_better'
    : 'base_better';
}

/**
 * The blind judge of one pair (design-training.md, KD-4): one structured answer of the model on the given request
 * — the training's model, its starter, the trainer's task and the training budget — with the two replays as
 * answer 1 and answer 2 in random order and no version named. A model error, a refused call or a second invalid
 * answer decide the pair `not_compared`. `undefined` — the step was cut off, nothing is decided.
 */
export async function judgePair(
  modelClient: Pick<ModelClient, 'call'>,
  ctx: StepContext,
  request: Omit<ModelCallRequest, 'messages' | 'tools' | 'instructions'>,
  pair: Pair,
): Promise<Decision | undefined> {
  const proposedFirst = Math.random() < 0.5;
  const [first, second] = proposedFirst
    ? [pair.proposed, pair.base]
    : [pair.base, pair.proposed];
  const message = [
    envelope('original task', EMPLOYEE_AUTHOR, cut(pair.task)),
    envelope('original report', MODEL_AUTHOR, cut(pair.original)),
    ...(pair.reAsks.length === 0
      ? []
      : [
          envelope(
            "employee's messages after the report",
            EMPLOYEE_AUTHOR,
            cut(pair.reAsks.join('\n\n')),
          ),
        ]),
    envelope('answer 1', MODEL_AUTHOR, cut(first)),
    envelope('answer 2', MODEL_AUTHOR, cut(second)),
  ].join('\n\n');
  const round = await toolAnswer(
    modelClient,
    ctx,
    { ...request, instructions: INSTRUCTIONS },
    JUDGE_TOOL,
    message,
  );
  if (round === undefined) return undefined;
  switch (round.kind) {
    case 'answer': {
      // The model may still name the answers by position: say which was which in this pair.
      const order = proposedFirst
        ? ' (first answer: proposed version; second answer: base version)'
        : ' (first answer: base version; second answer: proposed version)';
      return {
        verdict: verdictOf(round.value, proposedFirst),
        reason:
          round.value.reason.slice(0, REASON_MAX_CHARS - order.length) + order,
      };
    }
    case 'invalid_answer':
      return {
        verdict: 'not_compared',
        reason: 'The judge gave no valid verdict twice.',
      };
    case 'not_started':
      return {
        verdict: 'not_compared',
        reason: `The judge's model call was refused: ${round.verdict.reason}.`,
      };
    case 'model_error':
      return {
        verdict: 'not_compared',
        reason: `The judge's model failed: ${round.reason}.`,
      };
  }
}
