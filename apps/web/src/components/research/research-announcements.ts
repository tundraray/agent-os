import type { ResearchSourceMode } from '@agent-os/contracts';

export type ResearchAnnouncementEvent = 'launched' | 'completed' | 'stopped' | 'failed';

/**
 * Text of the screen's polite announcement of a launch event (deep-research UXRD, Accessibility, MC-17…MC-20). Without
 * sources the start and the result say so, or a screen reader user would learn of the mode only on reaching the card (KD-9).
 */
export function researchAnnouncement(event: ResearchAnnouncementEvent, sourceMode: ResearchSourceMode): string {
  const withoutSources = sourceMode === 'model_knowledge';
  switch (event) {
    case 'launched':
      return withoutSources
        ? 'Ресерч запущен. Источники данных не подключены — ответ будет из знаний модели.'
        : 'Ресерч запущен';
    case 'completed':
      return withoutSources
        ? 'Ресерч завершён. Ответ из знаний модели добавлен в конец беседы.'
        : 'Ресерч завершён. Ответ добавлен в конец беседы.';
    case 'stopped':
      return 'Ресерч остановлен';
    case 'failed':
      return 'Ресерч не удался';
  }
}
