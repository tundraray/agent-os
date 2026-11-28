'use client';

import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import Link from 'next/link';
import { useFormatter, useLocale } from 'next-intl';
import type { Confirmation, DecisionRequest } from '@agent-os/contracts';
import { CircleXIcon, LoaderCircleIcon, type LucideIcon } from 'lucide-react';
import {
  AgentStatus,
  FadeSlot,
  StatusGlyph,
} from '@/components/agents/agent-status';
import { RecordLabel } from '@/components/library/record-label';
import { Button } from '@/components/ui/button';
import { builtinName } from '@/i18n/builtin-name';
import { formatListTime } from '@/i18n/formats';
import { agentPath, recordPath } from '@/lib/shell-route';
import { cn } from '@/lib/utils';

/**
 * A decided card's final line. `failed` — an approved card whose save did not go through: its reason is the
 * platform's text, shown whole (the line wraps), with the icon alone in `--destructive`.
 */
export type Outcome = {
  kind: 'approved' | 'rejected' | 'cancelled' | 'failed';
  text: string;
  Icon: LucideIcon;
  tone: string;
  iconTone?: string;
};

/** Parts 1–2 while open, the outcome once decided: shared by every card (decision-card.md, Anatomy). */
export function CardHeader({
  outcome,
  createdAt,
}: {
  outcome: Outcome | null;
  createdAt: string;
}) {
  const format = useFormatter();
  if (outcome === null)
    return (
      <div className="flex h-5 min-w-0 items-center justify-between gap-3">
        <AgentStatus
          variant="label"
          status="awaiting_confirmation"
          className="shrink-0"
        />
        <time
          dateTime={createdAt}
          className="text-muted-foreground shrink-0 text-xs leading-4 font-medium tabular-nums"
        >
          {formatListTime(format, createdAt)}
        </time>
      </div>
    );
  return (
    <p
      className={cn(
        'flex min-w-0 gap-1 text-xs leading-4 font-medium tabular-nums',
        outcome.kind === 'failed' ? 'items-start' : 'h-5 items-center',
        outcome.tone,
      )}
    >
      <FadeSlot swapKey={outcome.kind} className={outcome.iconTone}>
        <outcome.Icon aria-hidden className="size-3.5" />
      </FadeSlot>
      <span
        className={cn(
          'min-w-0 animate-in fade-in-0 duration-(--duration-fast) motion-reduce:animate-none',
          outcome.kind === 'failed'
            ? 'break-words whitespace-pre-wrap'
            : 'truncate',
        )}
      >
        {outcome.text}
      </span>
    </p>
  );
}

/** Part 9: the line after a failed send of the decision. */
export function ErrorLine({ children }: { children: ReactNode }) {
  return (
    <p
      role="alert"
      className="text-foreground flex items-start gap-1.5 text-sm leading-5"
    >
      <CircleXIcon
        aria-hidden
        className="text-destructive mt-0.5 size-4 shrink-0"
      />
      {children}
    </p>
  );
}

/** The card's frame: «Ждёт» while open, `--card` once decided (decision-card.md, States). */
export const frameClass = (outcome: Outcome | null): string =>
  cn(
    'mx-auto flex w-full max-w-(--prose-max-width) min-w-0 flex-col gap-2 rounded-lg border p-3 outline-none',
    'focus-visible:ring-ring transition-colors duration-(--duration-fast) focus-visible:ring-2 motion-reduce:transition-none',
    outcome === null
      ? 'bg-approval-subtle border-approval-border'
      : 'bg-card text-card-foreground border-border',
  );

/** The agent's name in a source phrase: a link to its page. */
type AgentLink = (chunks: ReactNode) => ReactNode;

/**
 * Part 3: who asks — the card's own phrase, where the agent's name links to its page, and under it the asking
 * agent's record (RN-04); the chat's own request has none.
 */
export function CardSource({
  confirmation,
  byChat,
  phrase,
}: {
  confirmation: Confirmation;
  byChat: boolean;
  phrase: (link: AgentLink) => ReactNode;
}) {
  const locale = useLocale();
  const link: AgentLink = (chunks) => (
    <Link
      href={agentPath(confirmation.agentId)}
      className="focus-visible:ring-ring rounded-sm underline-offset-2 outline-none hover:underline focus-visible:ring-2"
    >
      {chunks}
    </Link>
  );
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <p className="text-foreground text-sm leading-5">{phrase(link)}</p>
      {!byChat && confirmation.origin !== null && (
        <RecordLabel
          origin={{
            ...confirmation.origin,
            name: builtinName(confirmation.origin, locale),
          }}
          variant="under"
          href={recordPath(confirmation.origin.recordId)}
        />
      )}
    </div>
  );
}

/**
 * A row button: in «Отправка» the pressed one shows the spinner in place of its label, at the same width.
 * `unavailable` keeps it in the Tab order (`aria-disabled`), its reason in `describedBy`.
 */
export function DecisionButton({
  label,
  variant,
  pressed,
  busy,
  onClick,
  buttonRef,
  unavailable,
  describedBy,
}: {
  label: string;
  variant: 'default' | 'destructive' | 'outline' | 'ghost';
  pressed: boolean;
  busy: boolean;
  onClick: () => void;
  buttonRef?: (element: HTMLButtonElement | null) => void;
  unavailable?: boolean;
  describedBy?: string;
}) {
  return (
    <Button
      ref={buttonRef}
      type="button"
      size="sm"
      variant={variant}
      disabled={busy}
      aria-busy={pressed || undefined}
      aria-disabled={unavailable || undefined}
      aria-describedby={describedBy}
      onClick={onClick}
      className="relative aria-disabled:opacity-50 pointer-coarse:h-11"
    >
      <span className={cn(pressed && 'opacity-0')}>{label}</span>
      {pressed && (
        <span
          aria-hidden
          className="absolute inset-0 flex items-center justify-center"
        >
          <StatusGlyph Icon={LoaderCircleIcon} spinning />
        </span>
      )}
    </Button>
  );
}

/**
 * Sending a card's decision (design-web.md KD-8): the pressed button for «Отправка», the failure for the error line,
 * and focus on the card once the outcome of a decision taken here shows (decision-card.md, Focus). The outcome itself
 * comes only from the re-read card. `decided` — the card shows an outcome.
 */
export function useDecisionSend<Which extends string>({
  onDecide,
  decided,
}: {
  onDecide: (decision: DecisionRequest) => Promise<void>;
  decided: boolean;
}) {
  const [pressed, setPressed] = useState<Which | null>(null);
  const [failed, setFailed] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const decidedHere = useRef(false);

  useEffect(() => {
    if (!decided || !decidedHere.current) return;
    decidedHere.current = false;
    containerRef.current?.focus();
  }, [decided]);

  const busy = pressed !== null;

  async function decide(
    which: Which,
    decision: DecisionRequest,
  ): Promise<void> {
    if (busy) return;
    setPressed(which);
    setFailed(false);
    decidedHere.current = true;
    try {
      await onDecide(decision);
    } catch {
      // The store has logged the failure. The card shows the error line and keeps what was typed and chosen
      // for a retry with the same button.
      decidedHere.current = false;
      setFailed(true);
    } finally {
      setPressed(null);
    }
  }

  return {
    pressed,
    busy,
    failed,
    containerRef,
    decide,
    clearFailure: () => setFailed(false),
  };
}

/**
 * A card's «Правка», local to the card (design-web.md KD-8): the draft lives while the card is in «Правка» (null
 * outside it). «Изменить» puts focus in the field; «Отмена» and Esc drop the draft and return focus to «Изменить».
 * Each card checks its own draft. `onCancel` runs with every cancel; Esc does nothing while a send is on its way.
 */
export function useCardEdit<Draft>({
  busy,
  onCancel,
}: {
  busy: boolean;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const fieldRef = useRef<HTMLTextAreaElement | null>(null);
  const editButtonRef = useRef<HTMLButtonElement | null>(null);
  const pendingFocus = useRef<'field' | 'edit' | null>(null);
  const editing = draft !== null;

  useEffect(() => {
    const target = pendingFocus.current;
    pendingFocus.current = null;
    if (target === 'field') fieldRef.current?.focus();
    if (target === 'edit') editButtonRef.current?.focus();
  }, [editing]);

  const cancel = (): void => {
    pendingFocus.current = 'edit';
    onCancel();
    setDraft(null);
  };

  return {
    draft,
    setDraft,
    fieldRef,
    editButtonRef,
    start: (original: Draft): void => {
      pendingFocus.current = 'field';
      setDraft(original);
    },
    cancel,
    onKeyDown: (event: KeyboardEvent<HTMLElement>): void => {
      if (event.key !== 'Escape' || busy) return;
      event.preventDefault();
      cancel();
    },
  };
}
