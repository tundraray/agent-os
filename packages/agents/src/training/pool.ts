import type { SessionTask } from '@agent-os/db';

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
