'use client';

import { useId, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import {
  SetPersonalInstructionsArgsSchema,
  type Confirmation,
  type DecisionRequest,
} from '@agent-os/contracts';
import {
  CircleCheckIcon,
  CircleMinusIcon,
  CircleStopIcon,
  CircleXIcon,
} from 'lucide-react';
import {
  CardHeader,
  DecisionButton,
  ErrorLine,
  frameClass,
  useCardEdit,
  useDecisionSend,
  type Outcome,
} from '@/components/agents/card-parts';
import {
  instructionOverflow,
  InstructionField,
} from '@/components/instruction-field';
import { formatListTime } from '@/i18n/formats';
import type { RecordSave } from '@/lib/feed/to-feed';
import { logger } from '@/lib/logger';

type Pressed = 'save' | 'saveEdited' | 'reject';

const REJECT: DecisionRequest = { approve: false };

/**
 * The text a card shows: the one it was saved with, edits included, once approved; the proposed one otherwise
 * (design-web.md KD-8). Null for content outside the contract.
 */
function shownTextOf(confirmation: Confirmation): string | null {
  const content = SetPersonalInstructionsArgsSchema.safeParse(
    confirmation.content,
  );
  if (!content.success) return null;
  if (confirmation.resolution?.approve !== true) return content.data.text;
  const saved = SetPersonalInstructionsArgsSchema.safeParse(
    confirmation.resolution.args,
  );
  return saved.success ? saved.data.text : content.data.text;
}

export type InstructionsCardProps = {
  confirmation: Confirmation;
  /** How the call after an approval ended; null before its result. */
  saved: RecordSave | null;
  /** Sends the decision and re-reads; rejects when the server did not take it. */
  onDecide: (decision: DecisionRequest) => Promise<void>;
};

/**
 * PI-01 «Как со мной работать» (UXRD Screen 2, MC-6; design-web.md KD-8, Flow 4): the card of an
 * `identity.instructions` decision in the main chat's feed. Buttons and «Правка» are the brief's; the body is the
 * instruction field «В карточке». The outcome comes from the re-read card, and a call that ended other than
 * `success` after the approval reads «Не сохранено: {причина}».
 */
export function InstructionsCard({
  confirmation,
  saved,
  onDecide,
}: InstructionsCardProps) {
  const t = useTranslations('agents.instructions');
  const tAgents = useTranslations('agents');
  const tChat = useTranslations('chat');
  const format = useFormatter();
  const titleId = useId();
  const text = shownTextOf(confirmation);
  const outcome = ((): Outcome | null => {
    if (confirmation.status === 'open') return null;
    if (confirmation.status === 'cancelled')
      return {
        kind: 'cancelled',
        text: t('cancelled'),
        Icon: CircleStopIcon,
        tone: 'text-muted-foreground',
      };
    const time = formatListTime(
      format,
      confirmation.resolvedAt ?? confirmation.createdAt,
    );
    if (confirmation.resolution?.approve !== true)
      return {
        kind: 'rejected',
        text: t('rejected', { time }),
        Icon: CircleMinusIcon,
        tone: 'text-muted-foreground',
      };
    if (saved !== null && saved.outcome !== 'success') {
      const reason =
        saved.text !== null && saved.text !== ''
          ? saved.text
          : tChat(`tool.outcome.${saved.outcome}`);
      return {
        kind: 'failed',
        text: t('notSaved', { reason }),
        Icon: CircleXIcon,
        tone: 'text-foreground',
        iconTone: 'text-destructive',
      };
    }
    return {
      kind: 'approved',
      text: t('saved', { time }),
      Icon: CircleCheckIcon,
      tone: 'text-success',
    };
  })();
  const { pressed, busy, failed, containerRef, decide, clearFailure } =
    useDecisionSend<Pressed>({ onDecide, decided: outcome !== null });
  const [tooLong, setTooLong] = useState(false);
  const { draft, setDraft, fieldRef, editButtonRef, start, cancel, onKeyDown } =
    useCardEdit<string>({
      busy,
      onCancel: () => {
        clearFailure();
        setTooLong(false);
      },
    });

  if (text === null) {
    logger.error('[web-feed] instructions card outside the contract', {
      decisionId: confirmation.decisionId,
    });
    return null;
  }

  const editing = draft !== null && outcome === null;
  const send = (which: Pressed, decision: DecisionRequest): void => {
    // The log names the card and the action, never the text (Security Considerations).
    logger.info('[web-feed] instructions card decision', {
      decisionId: confirmation.decisionId,
      action: which,
    });
    void decide(which, decision);
  };
  const saveEdited = (): void => {
    if (busy || draft === null) return;
    // State «Больше предела»: the request must not go out, the focus goes to the field.
    if (instructionOverflow(draft) > 0) {
      setTooLong(true);
      fieldRef.current?.focus();
      return;
    }
    send('saveEdited', { approve: true, args: { text: draft } });
  };

  const title = t('title');
  return (
    <div
      ref={containerRef}
      role="group"
      aria-label={tAgents('decision.groupAction', { tool: title })}
      tabIndex={-1}
      data-slot="decision-card"
      data-variant="instructions"
      data-decision-id={confirmation.decisionId}
      data-state={outcome?.kind ?? (editing ? 'editing' : 'open')}
      className={frameClass(outcome)}
      onKeyDown={editing ? onKeyDown : undefined}
    >
      <CardHeader outcome={outcome} createdAt={confirmation.createdAt} />
      <div className="flex min-w-0 flex-col gap-0.5">
        <h3 id={titleId} className="text-base leading-6 font-semibold">
          {title}
        </h3>
        <p className="text-muted-foreground text-xs leading-4 font-medium">
          {t('description')}
        </p>
      </div>
      <InstructionField
        variant="card"
        text={text}
        draft={editing ? draft : null}
        onDraftChange={(next) => {
          setDraft(next);
          setTooLong(false);
        }}
        fieldRef={fieldRef}
        tooLong={tooLong}
        busy={busy}
        labelledBy={titleId}
        emptyText={t('empty')}
        placeholder={t('placeholder')}
      />
      {failed && outcome === null && (
        <ErrorLine>{tAgents('decision.sendFailed')}</ErrorLine>
      )}
      {outcome === null && (
        <div className="flex flex-wrap items-center gap-2 max-[30rem]:flex-col max-[30rem]:items-stretch">
          {editing ? (
            <>
              <DecisionButton
                label={t('saveEdited')}
                variant="default"
                pressed={pressed === 'saveEdited'}
                busy={busy}
                onClick={saveEdited}
              />
              <DecisionButton
                label={t('cancel')}
                variant="outline"
                pressed={false}
                busy={busy}
                onClick={cancel}
              />
            </>
          ) : (
            <>
              <DecisionButton
                label={t('save')}
                variant="default"
                pressed={pressed === 'save'}
                busy={busy}
                onClick={() => send('save', { approve: true, args: { text } })}
              />
              <DecisionButton
                label={t('edit')}
                variant="outline"
                pressed={false}
                busy={busy}
                onClick={() => {
                  clearFailure();
                  start(text);
                }}
                buttonRef={(element) => {
                  editButtonRef.current = element;
                }}
              />
              <DecisionButton
                label={t('reject')}
                variant="ghost"
                pressed={pressed === 'reject'}
                busy={busy}
                onClick={() => send('reject', REJECT)}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}
