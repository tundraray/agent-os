import type { AssistantState } from '@assistant-ui/react';

/** The list item of the open conversation: the main thread by its local or its remote id. */
export const selectMainItem = (s: AssistantState) =>
  s.threads.threadItems.find(
    (item) =>
      item.id === s.threads.mainThreadId ||
      item.remoteId === s.threads.mainThreadId,
  );
