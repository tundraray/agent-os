import type { ConversationChangeSignal } from '@agent-os/contracts';
import type { RuntimeTasksRepository } from '@agent-os/db';

/**
 * The `LISTEN` channel of the conversation's own writes (live-feed design-server.md, KD-2): the title, the
 * notification level, the deletion and the attention events, which the runtime does not know about. Each
 * notification is a ready event with its owner (`ConversationChangeSignal`); the API's live hub sends it to that
 * owner's streams as it is.
 */
export const CONVERSATION_CHANGE_CHANNEL = 'conversation_change';

/**
 * Sends the event to the owner's streams when the open transaction commits; call it in the transaction of the
 * write it tells about. The owner comes from the conversation's row or the step's context, never from a client.
 */
export function signalConversation(
  rows: Pick<RuntimeTasksRepository, 'notify'>,
  signal: ConversationChangeSignal,
): Promise<void> {
  return rows.notify(CONVERSATION_CHANGE_CHANNEL, signal);
}
