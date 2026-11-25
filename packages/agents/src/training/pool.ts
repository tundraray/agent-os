import type { SessionTaskStatus } from '@agent-os/contracts';
import type { SessionTask, SessionTasksWrite } from '@agent-os/db';

/** The tasks of the pool that code moves; the model works only on the others (design-training.md, «Пул задач тренера»). */
export const CODE_TASKS: readonly number[] = [1, 5, 6];

const POOL: readonly (readonly [subject: string, description: string])[] = [
  [
    'Выбрать прошлые задачи',
    'Платформа выбрала до пяти прошлых задач агента для сравнения.',
  ],
  [
    'Разобрать прошлые запуски',
    'Прочитай прошлые задачи агента, его память и определение; разбери кодом, где запуски ошибались или тратили лишнее. Находки напиши в беседе.',
  ],
  [
    'Проверить догадки и скрипты кодом',
    'Проверь находки кодом и пробными запусками скриптов; оставь только подтверждённые.',
  ],
  [
    'Предложить новую версию',
    'Предложи одну новую версию: промпты и скрипты с объяснением каждого изменения. Если улучшать нечего — так и ответь, с причиной.',
  ],
  [
    'Повторить и сравнить прошлые задачи',
    'Платформа повторяет выбранные задачи на основе и на новой версии и сравнивает ответы.',
  ],
  ['Подвести итог', 'Платформа подводит итог обучения.'],
];

/**
 * The trainer's pool as the start writes it into its conversation's task list: six tasks in order, each blocked
 * by the one before, the first completed by the start itself (AC-28.1).
 */
export const POOL_TASKS: readonly SessionTask[] = POOL.map(
  ([subject, description], index) => ({
    number: index + 1,
    subject,
    description,
    activeForm: null,
    status: index === 0 ? 'completed' : 'pending',
    owner: null,
    blockedBy: index === 0 ? [] : [index],
  }),
);

/** The pool of a test run (design-trainer-dialog.md, KD-7; UXRD MC-5): four tasks, each blocked by the one before, the first in progress. */
export const TEST_RUN_POOL_TASKS: readonly SessionTask[] = (
  [
    [
      'Создать агента',
      'Найди похожего агента или согласуй с сотрудником план и создай агента ровно по нему.',
    ],
    [
      'Проверить первую версию',
      'Платформа запускает тесты плана на первой версии и оценивает ответы.',
    ],
    [
      'Исправить и проверить снова',
      'Исправь агента по ошибкам первого раунда; платформа проверит новую версию.',
    ],
    ['Подвести итог', 'Платформа подводит итог проверки.'],
  ] as const
).map(([subject, description], index) => ({
  number: index + 1,
  subject,
  description,
  activeForm: null,
  status: index === 0 ? 'in_progress' : 'pending',
  owner: null,
  blockedBy: index === 0 ? [] : [index],
}));

/** The tasks of a test run code moves — the pool's 1, 2 and 4 and every task a requested round adds — and the one that keeps the model's turn open. */
export const TEST_RUN_FIXED_TASKS: readonly number[] = [1, 2, 4];
export const TEST_RUN_MODEL_TASKS: readonly number[] = [3];

/** The pool's fix task: the model's, then code's. */
export const FIX_TASK = 3;

/** The subject of the task requested round `round` adds to the pool (KD-7); its presence marks the round requested. */
export function requestedRoundSubject(round: number): string {
  return `Исправление ${round - 1}: исправить и проверить`;
}

/**
 * The test run's pool tasks with new statuses and, where given, a new description, and the task of a requested
 * round with the last number it makes; the other tasks stay.
 */
export function testRunPoolWrite(
  changes: readonly (readonly [
    number: number,
    status: SessionTaskStatus,
    description?: string,
  ])[],
  /** The task requested round `round` adds to the pool, under the number it gets (KD-7). */
  requested?: {
    readonly number: number;
    readonly round: number;
    readonly status: SessionTaskStatus;
  },
): SessionTasksWrite {
  return {
    written: [
      ...changes.map(([number, status, description]) => {
        const task = TEST_RUN_POOL_TASKS[number - 1]!;
        return {
          ...task,
          status,
          description: description ?? task.description,
        };
      }),
      ...(requested === undefined
        ? []
        : [
            {
              number: requested.number,
              subject: requestedRoundSubject(requested.round),
              description:
                'Платформа проверяет версию, исправленную по просьбе сотрудника.',
              activeForm: null,
              status: requested.status,
              owner: null,
              blockedBy: [],
            },
          ]),
    ],
    deleted: [],
    lastNumber: requested?.number ?? TEST_RUN_POOL_TASKS.length,
  };
}
