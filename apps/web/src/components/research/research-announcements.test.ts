import { describe, expect, it } from 'vitest';
import { researchAnnouncement } from './research-announcements';

// AC-27.2 (draw), UXRD Accessibility and KD-9: MC-17 and MC-18 follow the launch's mode; MC-19 and MC-20 do not depend on it.
describe('researchAnnouncement — MC-17…MC-20 by mode', () => {
  it.each([
    { event: 'launched', sourceMode: 'sources', expected: 'Ресерч запущен' },
    { event: 'launched', sourceMode: 'model_knowledge', expected: 'Ресерч запущен. Источники данных не подключены — ответ будет из знаний модели.' },
    { event: 'completed', sourceMode: 'sources', expected: 'Ресерч завершён. Ответ добавлен в конец беседы.' },
    { event: 'completed', sourceMode: 'model_knowledge', expected: 'Ресерч завершён. Ответ из знаний модели добавлен в конец беседы.' },
    { event: 'stopped', sourceMode: 'model_knowledge', expected: 'Ресерч остановлен' },
    { event: 'failed', sourceMode: 'model_knowledge', expected: 'Ресерч не удался' },
  ] as const)('$event, $sourceMode', ({ event, sourceMode, expected }) => {
    expect(researchAnnouncement(event, sourceMode)).toBe(expected);
  });
});
