import type { Question, QuestionAnswer } from '@agent-os/contracts';

/**
 * What the employee marked on one question of a question card: the chosen option labels, whether «Другое» is
 * chosen, and the text typed into its field — kept while «Другое» is not chosen, but then not sent.
 */
export type QuestionPick = {
  selected: readonly string[];
  otherChosen: boolean;
  otherText: string;
};

export const EMPTY_PICK: QuestionPick = {
  selected: [],
  otherChosen: false,
  otherText: '',
};

/**
 * The `answers` of «Ответить» (design-web.md DC-1): one per question in their order. The chosen labels go in the
 * options' order; «Другое» with text is `other`, an empty field is no own answer; on a one-answer question «Другое»
 * replaces the option. A question without an answer goes with an empty `selected` and `other: null`.
 */
export function questionAnswers(
  questions: readonly Question[],
  picks: readonly QuestionPick[],
): QuestionAnswer[] {
  return questions.map((question, index) => {
    const pick = picks[index] ?? EMPTY_PICK;
    const other =
      pick.otherChosen && pick.otherText.trim() !== '' ? pick.otherText : null;
    const selected = question.options
      .map((option) => option.label)
      .filter((label) => pick.selected.includes(label));
    return {
      selected: !question.multiSelect && other !== null ? [] : selected,
      other,
    };
  });
}

/** The question has an answer to send: an option or an own text. */
export const isAnswered = (answer: QuestionAnswer): boolean =>
  answer.selected.length > 0 || answer.other !== null;
