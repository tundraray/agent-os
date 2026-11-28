import type { Question } from '@agent-os/contracts';
import { describe, expect, it } from 'vitest';

import { questionAnswers, type QuestionPick } from './question-answers';

const option = (label: string) => ({ label, description: `О ${label}` });

const one: Question = {
  question: 'Какой сервис разобрать?',
  options: [option('payments'), option('checkout')],
  multiSelect: false,
};
const several: Question = {
  question: 'Что добавить в отчёт?',
  options: [option('График'), option('Сообщения'), option('Топ ошибок')],
  multiSelect: true,
};

const pick = (over: Partial<QuestionPick>): QuestionPick => ({
  selected: [],
  otherChosen: false,
  otherText: '',
  ...over,
});

// DC-1, AC-09.2: the model gets exactly what the employee marked, one answer per question in their order.
describe('questionAnswers', () => {
  it.each([
    {
      name: 'one option of a one-answer question',
      questions: [one],
      picks: [pick({ selected: ['checkout'] })],
      answers: [{ selected: ['checkout'], other: null }],
    },
    {
      name: 'several options go in the options order, with an own answer beside them',
      questions: [several],
      picks: [
        pick({
          selected: ['Топ ошибок', 'График'],
          otherChosen: true,
          otherText: 'только 5xx',
        }),
      ],
      answers: [{ selected: ['График', 'Топ ошибок'], other: 'только 5xx' }],
    },
    {
      name: '«Другое» replaces the option of a one-answer question',
      questions: [one],
      picks: [
        pick({
          selected: ['payments'],
          otherChosen: true,
          otherText: 'billing',
        }),
      ],
      answers: [{ selected: [], other: 'billing' }],
    },
    {
      name: 'text typed while «Другое» is not chosen is not sent',
      questions: [one],
      picks: [
        pick({
          selected: ['payments'],
          otherChosen: false,
          otherText: 'billing',
        }),
      ],
      answers: [{ selected: ['payments'], other: null }],
    },
    {
      name: 'a question without an answer keeps its place, an empty «Другое» included',
      questions: [one, several],
      picks: [pick({ otherChosen: true, otherText: '   ' }), pick({})],
      answers: [
        { selected: [], other: null },
        { selected: [], other: null },
      ],
    },
  ])('$name', ({ questions, picks, answers }) => {
    expect(questionAnswers(questions, picks)).toEqual(answers);
  });
});
