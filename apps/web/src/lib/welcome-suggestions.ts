import type { SuggestionConfig } from '@assistant-ui/react';

/** TH-03 starter suggestions (UXRD 10.4): the card shows title and label, a click sends the prompt. */
export const WELCOME_SUGGESTIONS: SuggestionConfig[] = [
  {
    title: 'Составь план встречи',
    label: 'по запуску нового проекта',
    prompt: 'Составь план встречи по запуску нового проекта',
  },
  {
    title: 'Напиши письмо',
    label: 'клиенту о переносе сроков',
    prompt: 'Напиши письмо клиенту о переносе сроков',
  },
  {
    title: 'Объясни простыми словами',
    label: 'что такое OKR и как их ставить',
    prompt: 'Объясни простыми словами, что такое OKR и как их ставить',
  },
  {
    title: 'Предложи идеи',
    label: 'для тимбилдинга команды из 15 человек',
    prompt: 'Предложи идеи для тимбилдинга команды из 15 человек',
  },
];
