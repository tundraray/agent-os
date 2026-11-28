import type { Logger } from '@agent-os/common';
import {
  AGENTS_QUESTION_CONFIRMATION,
  ASK_USER_TOOL,
  type AskUserArgs,
  AskUserArgsSchema,
  type Question,
  type QuestionAnswer,
} from '@agent-os/contracts';

import type { OutsideAgentTool } from '../tool';

const DESCRIPTION = [
  'Ask the employee you work for up to four questions with answer options, when the work depends on a choice only they can make and guessing would likely be wrong.',
  'Each question gets two to four short options; the employee may also write their own answer. Ask only what you cannot find out yourself, and ask all you need in one call.',
  'The call returns the answers. A question the employee did not answer, or a run where nobody can answer, means you act on your best judgment.',
].join('\n');

/** What the model reads when the call ran without anyone to answer (agent-guidance KD-2, AC-02.1, AC-02.2). */
const NOBODY_TEXT =
  'Nobody can answer questions in this run. Act on your best judgment and list the assumptions you made in your answer.';

/** Added when at least one question stayed without an answer (AC-01.3). */
const UNANSWERED_RULE =
  'For each question without an answer, act on your best judgment and name your assumptions in your answer.';

/** One question with its answer, as the model reads it (Flow 1). */
function answerLine(
  question: Question,
  answer: QuestionAnswer | undefined,
  index: number,
): string {
  const parts = [
    ...(answer?.selected ?? []),
    ...(answer?.other == null ? [] : [`own answer: ${answer.other}`]),
  ];
  const text = parts.length === 0 ? 'no answer' : parts.join('; ');
  return `${index + 1}. ${question.question}\nAnswer: ${text}`;
}

function isAnswered(answer: QuestionAnswer | undefined): boolean {
  return (
    answer !== undefined &&
    (answer.selected.length > 0 || answer.other !== null)
  );
}

/**
 * The result of an answered or skipped card: each question with the chosen options, the employee's own text or
 * «no answer», then the rule for the unanswered ones when there are any.
 */
function answersText(
  questions: readonly Question[],
  answers: readonly QuestionAnswer[] | null,
): string {
  const lines = questions.map((question, index) =>
    answerLine(question, answers?.[index], index),
  );
  const unanswered = questions.some(
    (_question, index) => !isAnswered(answers?.[index]),
  );
  return [
    'The employee answered:',
    ...lines,
    ...(unanswered ? [UNANSWERED_RULE] : []),
  ].join('\n');
}

/**
 * `ask_user` (agent-guidance design-server.md, KD-1, KD-2, Flow 1, Flow 2): a card of the kind `agents.question`
 * with the questions of the arguments, never edited. The call runs on the employee's decision with his answers
 * (`answers` of the input; `null` — he skipped the card), or without a decision when nobody can answer — a
 * training tree, a schedule's run — and then tells the model to act on its own. The answers stay out of the log.
 */
export function createAskUserTool(deps: {
  readonly logger: Logger;
}): OutsideAgentTool<AskUserArgs> {
  const logger = deps.logger.child({ service: 'agents.questions' });
  return {
    name: ASK_USER_TOOL,
    description: DESCRIPTION,
    argsSchema: AskUserArgsSchema,
    mode: 'outside',
    confirmation: {
      kind: AGENTS_QUESTION_CONFIRMATION,
      content: (args) => ({ questions: args.questions }),
      editableArgs: false,
    },
    async execute({ args, caller, callId, answers }) {
      const decided = answers !== undefined;
      logger.info('questions closed', {
        agentId: caller.agentId,
        rootId: caller.rootId,
        ownerId: caller.ownerId,
        callId,
        questions: args.questions.length,
        decided,
        answered: decided
          ? args.questions.filter((_question, index) =>
              isAnswered(answers?.[index]),
            ).length
          : 0,
      });
      return {
        kind: 'done',
        outcome: 'success',
        text: decided ? answersText(args.questions, answers) : NOBODY_TEXT,
      };
    },
  };
}
