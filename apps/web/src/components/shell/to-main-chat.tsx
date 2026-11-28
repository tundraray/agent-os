'use client';

import {
  useCallback,
  useEffect,
  useState,
  type FC,
  type RefObject,
} from 'react';
import { useAuiState, type AssistantState } from '@assistant-ui/react';
import { Check } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { useStore } from 'zustand';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent } from '@/components/ui/popover';
import { useShellServices } from './shell-actions';

/**
 * «В основной чат» (improvements design-web.md KD-7, Flow 1; UXRD IM-07, MC-7): text of the side chat's feed — a
 * selection or a whole answer — goes as the next message of the conversation the side chat was asked from.
 */

/** How long the button shows «Отправлено» (IM-07). */
const SENT_MS = 2000;

type Transfer = 'idle' | 'pending' | 'sent' | 'failed';

/**
 * Sends through the main conversation's own store in the quiet mode of the cards' buttons: a busy agent puts the text
 * in the queue tray, and a refusal never returns it to the main composer. The store logs the refusal.
 */
function useSendToMain(): {
  transfer: Transfer;
  send: (text: string) => Promise<boolean>;
} {
  const { workspace, feeds, announcer } = useShellServices();
  const threadId = useStore(workspace, (state) => state.aside?.threadId);
  const [transfer, setTransfer] = useState<Transfer>('idle');

  useEffect(() => {
    if (transfer !== 'sent') return;
    const timer = setTimeout(() => setTransfer('idle'), SENT_MS);
    return () => clearTimeout(timer);
  }, [transfer]);

  const send = async (text: string): Promise<boolean> => {
    if (threadId === undefined) return false;
    setTransfer('pending');
    try {
      await feeds.forThread(threadId).send(text, undefined, { quiet: true });
    } catch {
      // Logged once by the store's command with the conversation's ids and the refusal's code.
      setTransfer('failed');
      return false;
    }
    setTransfer('sent');
    announcer.getState().announce('announce.sentToMain');
    return true;
  };

  return { transfer, send };
}

const ToMainLabel: FC<{ transfer: Transfer }> = ({ transfer }) => {
  const t = useTranslations('chat.aside');
  return transfer === 'sent' ? (
    <>
      <Check aria-hidden />
      {t('sent')}
    </>
  ) : (
    t('toMain')
  );
};

/** A message's text parts: the whole answer «В основной чат» sends, the text an edit starts from. */
export const messageTextOf = (s: AssistantState): string =>
  s.message.parts
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join('\n');

/**
 * «В основной чат» in the action bar of a side chat's answer: the keyboard's way (UXRD Accessibility); a refusal is a
 * notice, the popover is not there.
 */
export const ToMainChatButton: FC = () => {
  const t = useTranslations('chat.aside');
  const text = useAuiState(messageTextOf);
  const { transfer, send } = useSendToMain();

  if (text.trim() === '') return null;

  const sendAnswer = async (): Promise<void> => {
    if (!(await send(text))) toast.error(t('toMainFailed'));
  };

  return (
    <Button
      variant="outline"
      size="sm"
      disabled={transfer === 'pending'}
      onClick={() => void sendAnswer()}
    >
      <ToMainLabel transfer={transfer} />
    </Button>
  );
};

type Picked = {
  text: string;
  /** The selection's live range: the popover follows it while the feed scrolls. */
  range: Range;
  /** The message the selection lies in: the positioner watches the scrolling of its ancestors, the feed. */
  message: Element;
};

/** The selection when it lies within one message of the feed under `root`, otherwise null. */
function pickedIn(root: HTMLElement): Picked | null {
  const selection = document.getSelection();
  if (selection === null || selection.isCollapsed || selection.rangeCount === 0)
    return null;
  const text = selection.toString().trim();
  if (text === '') return null;
  const messageOf = (node: Node | null): Element | null =>
    (node instanceof Element ? node : (node?.parentElement ?? null))?.closest(
      '[data-role]',
    ) ?? null;
  const message = messageOf(selection.anchorNode);
  if (
    message === null ||
    message !== messageOf(selection.focusNode) ||
    !root.contains(message)
  )
    return null;
  return { text, range: selection.getRangeAt(0), message };
}

/**
 * The popover over a selection inside a message of the side chat's feed under `root` (IM-07): one button, no focus
 * taken, closed with the selection; a refusal is the MC-7 line under the button.
 */
export function ToMainChatPopover({
  root,
}: {
  root: RefObject<HTMLElement | null>;
}) {
  const [picked, setPicked] = useState<Picked | null>(null);

  const follow = useCallback(() => {
    const element = root.current;
    setPicked(element === null ? null : pickedIn(element));
  }, [root]);

  useEffect(() => {
    document.addEventListener('selectionchange', follow);
    return () => document.removeEventListener('selectionchange', follow);
  }, [follow]);

  return (
    <Popover
      open={picked !== null}
      onOpenChange={(open) => {
        if (!open) setPicked(null);
      }}
    >
      {picked !== null && (
        <PopoverContent
          side="top"
          anchor={{
            getBoundingClientRect: () => picked.range.getBoundingClientRect(),
            contextElement: picked.message,
          }}
          initialFocus={false}
          finalFocus={false}
          className="w-auto gap-1 p-1"
        >
          {/* A new selection starts with a fresh button and no error line. */}
          <PickedTransfer key={picked.text} text={picked.text} />
        </PopoverContent>
      )}
    </Popover>
  );
}

function PickedTransfer({ text }: { text: string }) {
  const t = useTranslations('chat.aside');
  const { transfer, send } = useSendToMain();
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        disabled={transfer === 'pending'}
        // The selection and the focus stay where they are (UXRD Accessibility).
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => void send(text)}
      >
        <ToMainLabel transfer={transfer} />
      </Button>
      {transfer === 'failed' && (
        <p className="text-destructive max-w-60 px-1 text-xs leading-4">
          {t('toMainFailed')}
        </p>
      )}
    </>
  );
}
