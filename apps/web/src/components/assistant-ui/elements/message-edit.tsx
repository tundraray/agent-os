'use client';

import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type FC,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useAuiState, type AssistantState } from '@assistant-ui/react';
import { ChipRecordSchema, type ForkRequest } from '@agent-os/contracts';
import { LoaderCircle, PencilIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { TooltipIconButton } from '@/components/tooltip-icon-button';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { messageTextOf } from '@/components/shell/to-main-chat';
import { useOpenBranch } from '@/components/shell/use-open-branch';
import { useFeedSelector } from '@/lib/feed/feed-context';
import type { FeedState } from '@/lib/feed/feed-store';
import {
  canFork,
  feedSeqOf,
  isComposerMessage,
  selectThreadId,
} from '@/lib/feed/to-feed';

/**
 * «Изменить» (improvements UXRD IM-13, design-web.md KD-2, Flow 2): the field in place of an employee's own message
 * that forks the conversation with the corrected text and enters the branch. The conversation itself does not change.
 */

type EditState = {
  /** `seq` of the message being edited in this conversation; null — none. One field at a time. */
  editingSeq: number | null;
  /** The message whose «Изменить» takes focus back after «Отмена» or Esc. */
  restoreFocusSeq: number | null;
  open: (seq: number) => void;
  close: (restoreFocus: boolean) => void;
  focusRestored: () => void;
};

const EditContext = createContext<EditState | null>(null);

const threadIdOf = (state: FeedState): string | null =>
  selectThreadId(state.view);

/** Holds which message of the open conversation is edited; another conversation starts with none. */
export function MessageEditProvider({ children }: { children: ReactNode }) {
  const threadId = useFeedSelector(threadIdOf, null);
  const [editing, setEditing] = useState<{
    threadId: string | null;
    seq: number | null;
    restoreFocusSeq: number | null;
  }>({ threadId, seq: null, restoreFocusSeq: null });
  // The shell keeps one Thread for every conversation: a switch drops the field of the previous one.
  if (editing.threadId !== threadId)
    setEditing({ threadId, seq: null, restoreFocusSeq: null });

  const state: EditState = {
    editingSeq: editing.seq,
    restoreFocusSeq: editing.restoreFocusSeq,
    open: (seq) => setEditing({ threadId, seq, restoreFocusSeq: null }),
    close: (restoreFocus) =>
      setEditing((current) => ({
        threadId,
        seq: null,
        restoreFocusSeq: restoreFocus ? current.seq : null,
      })),
    focusRestored: () =>
      setEditing((current) => ({ ...current, restoreFocusSeq: null })),
  };
  return <EditContext.Provider value={state}>{children}</EditContext.Provider>;
}

function useEditState(): EditState {
  const state = useContext(EditContext);
  if (state === null)
    throw new Error('MessageEdit used outside MessageEditProvider');
  return state;
}

/** The message's history number when it is the employee's own, sent from the composer; null for any other. */
const editableSeqOf = (s: AssistantState): number | null => {
  const custom = s.message.metadata.custom;
  // A test run's description was not written in the composer either (IM-13).
  if (!isComposerMessage(custom) || custom['testRun'] === true) return null;
  return feedSeqOf(s.message.id);
};

const recordIdOf = (s: AssistantState): string | null => {
  const record = ChipRecordSchema.safeParse(
    s.message.metadata.custom['record'],
  );
  return record.success ? record.data.id : null;
};

/** «Изменить» in the action bar of an employee's own message while the conversation can be forked (AC-14.2). */
export const EditMessageButton: FC = () => {
  const t = useTranslations('chat.edit');
  const { open, restoreFocusSeq, focusRestored } = useEditState();
  const seq = useAuiState(editableSeqOf);
  const forkable = useFeedSelector((state) => canFork(state.view), false);
  const ref = useRef<HTMLButtonElement>(null);
  const shown = seq !== null && forkable;

  useEffect(() => {
    if (!shown || restoreFocusSeq !== seq) return;
    ref.current?.focus();
    focusRestored();
  }, [shown, seq, restoreFocusSeq, focusRestored]);

  if (!shown) return null;
  return (
    <TooltipIconButton
      ref={ref}
      tooltip={t('action')}
      onClick={() => open(seq)}
    >
      <PencilIcon />
    </TooltipIconButton>
  );
};

/** The message's bubble, or the edit field in its place while this message is edited. */
export const EditableUserMessage: FC<{ children: ReactNode }> = ({
  children,
}) => {
  const { editingSeq } = useEditState();
  const seq = useAuiState(editableSeqOf);
  if (seq === null || seq !== editingSeq) return children;
  return <MessageEditField seq={seq} />;
};

const MessageEditField: FC<{ seq: number }> = ({ seq }) => {
  const t = useTranslations('chat.edit');
  const { close } = useEditState();
  const initialText = useAuiState(messageTextOf);
  const recordId = useAuiState(recordIdOf);
  const threadId = useFeedSelector(threadIdOf, null);
  const openBranch = useOpenBranch();
  const [text, setText] = useState(initialText);
  const [sending, setSending] = useState(false);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const hintId = useId();

  useEffect(() => {
    const field = fieldRef.current;
    if (field === null) return;
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
  }, []);

  const trimmed = text.trim();
  const submit = async (): Promise<void> => {
    if (trimmed === '' || sending || threadId === null) return;
    setSending(true);
    const edit: NonNullable<ForkRequest['edit']> =
      recordId === null
        ? { seq, text: trimmed }
        : { seq, text: trimmed, recordId };
    const opened = await openBranch(threadId, { edit });
    // A refusal keeps the field with its text (IM-13, «Отказ ветки»); the branch replaces the screen otherwise.
    setSending(false);
    if (opened) close(false);
    else fieldRef.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
      return;
    }
    if (
      event.key === 'Enter' &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      void submit();
    }
  };

  return (
    <div
      data-slot="aui_user-message-edit"
      // `pt-1`: the message root paints nothing outside its box (`content-visibility`), the focus ring needs the room.
      className="col-span-full col-start-1 flex min-w-0 flex-col gap-2 pt-1"
    >
      <Textarea
        ref={fieldRef}
        aria-label={t('action')}
        aria-describedby={hintId}
        value={text}
        disabled={sending}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        className="rounded-(--composer-radius) px-4 py-2"
      />
      <p id={hintId} className="text-muted-foreground text-xs leading-4">
        {t('hint')}
      </p>
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          disabled={sending}
          onClick={() => close(true)}
        >
          {t('cancel')}
        </Button>
        <Button
          type="button"
          disabled={sending || trimmed === ''}
          onClick={() => void submit()}
        >
          {sending && <LoaderCircle className="animate-spin" aria-hidden />}
          {t('send')}
        </Button>
      </div>
    </div>
  );
};
