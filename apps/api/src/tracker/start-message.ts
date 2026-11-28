import { type Language, TRACKER_REPORT_TOOL } from '@agent-os/contracts';

/** How many of the task's last comments the start message carries, the delegation's note included. */
export const START_MESSAGE_COMMENTS = 3;

/** A comment of the start message: the employee's, or an agent's under its name (`null` — the chat agent). */
export interface StartMessageComment {
  readonly author: 'employee' | { readonly agentName: string | null };
  readonly text: string;
}

export interface StartMessageInput {
  readonly language: Language;
  readonly title: string;
  readonly description: string;
  /** The last comments of the feed, oldest first; the delegation's note is the last of them. */
  readonly comments: readonly StartMessageComment[];
  /** An agent of the «+» menu was chosen: its chip goes with the message. */
  readonly withAgent: boolean;
}

const TEXTS = {
  en: {
    task: 'Task from the tracker',
    title: 'Title',
    description: 'Description',
    comments: 'Last comments',
    you: 'you',
    chat: 'chat',
    work: (withAgent: boolean) =>
      withAgent
        ? 'Start the agent of the chip on this task and carry its result over to the task.'
        : 'Work on this task yourself.',
    rules: [
      `Report on the task with ${TRACKER_REPORT_TOOL}: a comment on how the work goes;`,
      'status in_review when the work is done, needs_decision when the employee must decide something.',
      'The task changes only through these calls.',
    ],
  },
  ru: {
    task: 'Задача из трекера',
    title: 'Название',
    description: 'Описание',
    comments: 'Последние комментарии',
    you: 'вы',
    chat: 'чат',
    work: (withAgent: boolean) =>
      withAgent
        ? 'Запусти над задачей агента из чипа и перенеси его итог на задачу.'
        : 'Поработай над задачей сам.',
    rules: [
      `Отчитывайся на задаче вызовом ${TRACKER_REPORT_TOOL}: комментарий о ходе работы;`,
      'статус in_review, когда работа готова, needs_decision, когда нужно решение сотрудника.',
      'Задача меняется только этими вызовами.',
    ],
  },
} as const;

/**
 * The first message of a task's conversation (task-tracker design-server.md, «Стартовое сообщение»): the title and
 * the description, the last comments with their authors, the rules of the report and what to do with the chosen
 * agent. The chip itself goes with the send as a typed message's does.
 */
export function startMessage(input: StartMessageInput): string {
  const text = TEXTS[input.language];
  const lines = [
    `${text.task}`,
    `${text.title}: ${input.title}`,
    ...(input.description === ''
      ? []
      : [`${text.description}:`, input.description]),
  ];
  if (input.comments.length > 0)
    lines.push(
      '',
      `${text.comments}:`,
      ...input.comments.map(({ author, text: comment }) => {
        const name =
          author === 'employee' ? text.you : (author.agentName ?? text.chat);
        return `- ${name}: ${comment}`;
      }),
    );
  lines.push('', text.work(input.withAgent), ...text.rules);
  return lines.join('\n');
}
