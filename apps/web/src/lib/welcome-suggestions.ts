import type { SuggestionConfig } from '@assistant-ui/react';
import type { ChatTranslator } from '@/lib/i18n/messages';

const STARTERS = ['meetingPlan', 'clientLetter', 'explainOkr', 'teamBuilding'] as const;

/** TH-03 starter suggestions (UXRD 10.4) in the page's language: the card shows title and label, a click sends the prompt. */
export function welcomeSuggestions(t: ChatTranslator): SuggestionConfig[] {
  return STARTERS.map((starter) => ({
    title: t(`starter.${starter}.title`),
    label: t(`starter.${starter}.label`),
    prompt: t(`starter.${starter}.prompt`),
  }));
}
