'use client';

import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import Link from 'next/link';
import {
  useFormatter,
  useLocale,
  useMessages,
  useTranslations,
} from 'next-intl';
import {
  RunCodeConfirmationContentSchema,
  AGENTS_BRIEF_CONFIRMATION,
  LIBRARY_RECORD_CONFIRMATION,
  type Confirmation,
  type LibraryRecordCard,
  type RunCodeConfirmationContent,
} from '@agent-os/contracts';
import {
  CircleCheckIcon,
  CircleMinusIcon,
  CircleStopIcon,
  CircleXIcon,
  InfoIcon,
  LoaderCircleIcon,
  type LucideIcon,
} from 'lucide-react';
import { z } from 'zod';
import { useStore } from 'zustand';
import {
  AgentStatus,
  FadeSlot,
  StatusGlyph,
} from '@/components/agents/agent-status';
import { useCardThread } from '@/components/agents/run-card';
import { ValueRows } from '@/components/agents/value-rows';
import { DefinitionView } from '@/components/library/definition-view';
import { RecordLabel } from '@/components/library/record-label';
import { useInChat } from '@/components/library/use-in-chat';
import { useShellServices } from '@/components/shell/shell-actions';
import { ShellLink } from '@/components/shell/shell-link';
import { StateBadge } from '@/components/state-badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useResource } from '@/hooks/use-resource';
import { BRIEF_PARTS } from '@/lib/agents/format';
import { builtinName, toolCallLabels } from '@/i18n/builtin-name';
import { formatListTime, type Formatter } from '@/i18n/formats';
import { isRunCode, runCodeView } from '@/lib/agents/run-code';
import { valueRows } from '@/lib/agents/value-rows';
import { recordCardOf, type RecordSave } from '@/lib/feed/to-feed';
import { libraryApi } from '@/lib/library/library-api';
import {
  briefTitleName,
  changedFields,
  type RecordDefinition,
} from '@/lib/library/record-rules';
import { logger } from '@/lib/logger';
import { agentPath, recordPath } from '@/lib/shell-route';
import { cn } from '@/lib/utils';
import type { AgentsTranslator, ChatTranslator } from '@/i18n/catalog';

type CanCall = RunCodeConfirmationContent['canCall'];

/**
 * The «Может вызвать» list of a code run's request, in the order the platform gave it (KD-6); null for
 * any other request and for content outside the contract — such a run does not start (DC-16).
 */
function canCallOf(confirmation: Confirmation): CanCall | null {
  if (!isRunCode(confirmation.tool, confirmation.server)) return null;
  const content = RunCodeConfirmationContentSchema.safeParse(
    confirmation.content,
  );
  if (!content.success) {
    logger.warn('[web-feed] code run confirmation outside the contract', {
      decisionId: confirmation.decisionId,
    });
    return null;
  }
  return content.data.canCall;
}

/**
 * Part 8 of decision-card.md: the tools a code run can call, one phrase per line «{имя} — меняет» or
 * «— читает»; the mark is a word, weight only helps. The same in every state of the card (KD-7).
 */
function CanCallList({ items }: { items: CanCall }) {
  const t = useTranslations('agents.runCode.canCall');
  const titleId = useId();
  return (
    <div data-slot="can-call" className="flex flex-col gap-1">
      <p
        id={titleId}
        className="text-muted-foreground text-xs leading-4 font-medium"
      >
        {t('title')}
      </p>
      {items.length === 0 ? (
        <p className="text-muted-foreground text-sm leading-5">{t('none')}</p>
      ) : (
        <>
          <ul aria-labelledby={titleId} className="flex flex-col gap-0.5">
            {items.map(({ name, changes }) => (
              <li key={name} className="text-sm leading-5">
                <span className="text-foreground font-mono text-[13px] leading-5 break-all">
                  {name}
                </span>
                {' — '}
                <span
                  className={
                    changes
                      ? 'text-foreground font-medium'
                      : 'text-muted-foreground'
                  }
                >
                  {t(changes ? 'changes' : 'reads')}
                </span>
              </li>
            ))}
          </ul>
          <p className="text-muted-foreground text-xs leading-4 font-medium">
            {t('note')}
          </p>
        </>
      )}
    </div>
  );
}

type BriefField = (typeof BRIEF_PARTS)[number];
type BriefText = Record<BriefField, string>;

/**
 * `start_deep_agent` arguments as the confirmation carries them, and the brief card content of the same
 * shape: the deep agent record id travels inside `args` and goes back unchanged with the three fields
 * (design-runtime.md, § Маршруты).
 */
const BriefSchema = z.object({
  deepAgent: z.string().min(1),
  question: z.string(),
  boundaries: z.string(),
  result: z.string(),
});

type Brief = { deepAgent: string; text: BriefText };

const pickText = (value: BriefText): BriefText => ({
  question: value.question,
  boundaries: value.boundaries,
  result: value.result,
});

/**
 * The brief of an `agents.brief` confirmation; null when the shape is not the built one, and the card
 * then shows the request as an action (tool and arguments), which can still be decided.
 */
function briefOf(confirmation: Confirmation): Brief | null {
  if (confirmation.kind !== AGENTS_BRIEF_CONFIRMATION) return null;
  const args = BriefSchema.safeParse(confirmation.args);
  const content = BriefSchema.safeParse(confirmation.content);
  if (!args.success || !content.success) {
    logger.warn('[web-feed] brief confirmation outside the contract', {
      decisionId: confirmation.decisionId,
      argsValid: args.success,
      contentValid: content.success,
    });
    return null;
  }
  // A confirmed brief shows the text it ran with, edits included (decision-card.md, States).
  const ran =
    confirmation.resolution?.approve === true
      ? BriefSchema.safeParse(confirmation.resolution.args)
      : null;
  return {
    deepAgent: args.data.deepAgent,
    text: pickText(ran?.success === true ? ran.data : content.data),
  };
}

/**
 * A decided request's final line. `failed` — an approved record card whose save did not go through: its reason
 * is the platform's text, shown whole (the line wraps), with the icon alone in `--destructive`.
 */
type Outcome = {
  kind: 'approved' | 'rejected' | 'cancelled' | 'failed';
  text: string;
  Icon: LucideIcon;
  tone: string;
  iconTone?: string;
};

/** The final line of a decided request (MC-19, MC-20); null while it is open. */
function outcomeOf(
  t: AgentsTranslator,
  confirmation: Confirmation,
  isBrief: boolean,
  format: Formatter,
): Outcome | null {
  if (confirmation.status === 'open') return null;
  if (confirmation.status === 'cancelled') {
    return {
      kind: 'cancelled',
      text: t('decision.cancelled'),
      Icon: CircleStopIcon,
      tone: 'text-muted-foreground',
    };
  }
  const time = formatListTime(
    format,
    confirmation.resolvedAt ?? confirmation.createdAt,
  );
  if (confirmation.resolution?.approve === true) {
    const text = t(isBrief ? 'decision.briefApproved' : 'decision.approved', {
      time,
    });
    return {
      kind: 'approved',
      text,
      Icon: CircleCheckIcon,
      tone: 'text-success',
    };
  }
  const text = t(isBrief ? 'decision.briefRejected' : 'decision.rejected', {
    time,
  });
  return {
    kind: 'rejected',
    text,
    Icon: CircleMinusIcon,
    tone: 'text-muted-foreground',
  };
}

/** A record card as it reads: the definition after a create or an edit, the saved one before an edit or a delete. */
type RecordView =
  | { action: 'create'; card: LibraryRecordCard; next: RecordDefinition }
  | {
      action: 'edit';
      card: LibraryRecordCard;
      previous: RecordDefinition;
      next: RecordDefinition;
    }
  | { action: 'delete'; card: LibraryRecordCard; previous: RecordDefinition };

function definitionOf(
  card: LibraryRecordCard,
  side: 'next' | 'previous',
): RecordDefinition | null {
  if (card.kind === 'agent') {
    const text = card[side];
    return text === null
      ? null
      : {
          name: text.name,
          description: text.description,
          kind: 'agent',
          content: text.content,
        };
  }
  const text = card[side];
  return text === null
    ? null
    : {
        name: text.name,
        description: text.description,
        kind: 'deep_agent',
        content: text.content,
      };
}

/**
 * The record of a `library.record` confirmation (DA-11); null for any other request. Content outside the contract
 * is warned about, and the card then shows the request as an action (tool and arguments), which can still be decided.
 */
function recordViewOf(confirmation: Confirmation): RecordView | null {
  if (confirmation.kind !== LIBRARY_RECORD_CONFIRMATION) return null;
  const card = recordCardOf(confirmation);
  const next = card === null ? null : definitionOf(card, 'next');
  const previous = card === null ? null : definitionOf(card, 'previous');
  if (card?.action === 'create' && next !== null)
    return { action: 'create', card, next };
  if (card?.action === 'edit' && next !== null && previous !== null)
    return { action: 'edit', card, previous, next };
  if (card?.action === 'delete' && previous !== null)
    return { action: 'delete', card, previous };
  logger.warn('[web-feed] record confirmation outside the contract', {
    decisionId: confirmation.decisionId,
  });
  return null;
}

/** MC-24: «Создать агента», «Изменить «{имя}»», «Удалить «{имя}»» — the action in words, the saved name. */
function recordHeading(t: AgentsTranslator, view: RecordView): string {
  if (view.action === 'create')
    return t('recordCard.create', { kind: view.card.kind });
  return t(view.action === 'edit' ? 'recordCard.edit' : 'recordCard.delete', {
    name: view.previous.name,
  });
}

const RECORD_DONE = {
  create: 'recordCard.created',
  edit: 'recordCard.changedOutcome',
  delete: 'recordCard.deleted',
} as const;

/**
 * The final line of a record card (MC-24): approved and saved — «Создано», «Изменено» or «Удалено»; approved and not
 * saved — «Не сохранено:» and the platform's text as is (KD-4); approved while the save is still on its way — the
 * general «Подтверждено». Rejected and cancelled read as any request.
 */
function recordOutcomeOf(
  {
    t,
    tChat,
    format,
  }: { t: AgentsTranslator; tChat: ChatTranslator; format: Formatter },
  confirmation: Confirmation,
  view: RecordView,
  saved: RecordSave | null,
): Outcome | null {
  const outcome = outcomeOf(t, confirmation, false, format);
  if (outcome?.kind !== 'approved' || saved === null) return outcome;
  const time = formatListTime(
    format,
    confirmation.resolvedAt ?? confirmation.createdAt,
  );
  if (saved.outcome === 'success') {
    return {
      kind: 'approved',
      text: t(RECORD_DONE[view.action], { time }),
      Icon: CircleCheckIcon,
      tone: 'text-success',
    };
  }
  const reason =
    saved.text !== null && saved.text !== ''
      ? saved.text
      : tChat(`tool.outcome.${saved.outcome}`);
  return {
    kind: 'failed',
    text: t('recordCard.notSaved', { reason }),
    Icon: CircleXIcon,
    tone: 'text-foreground',
    iconTone: 'text-destructive',
  };
}

/**
 * The body of «Запись» (decision-card.md, Variants): the name and the definition «В карточке» on a create; the
 * definition «Правка» with what the edit changes on an edit — a new name stands above it, marked, since the
 * definition has no name row; the record label, its description and the phrase on a delete.
 */
function RecordBody({ view }: { view: RecordView }) {
  const t = useTranslations('agents.recordCard');
  if (view.action === 'create') {
    return (
      <>
        <p className="text-foreground text-sm leading-5 font-medium break-words">
          {view.next.name}
        </p>
        <DefinitionView
          definition={view.next}
          missingRights={[]}
          variant="card"
        />
      </>
    );
  }
  if (view.action === 'edit') {
    return (
      <>
        {view.previous.name !== view.next.name && (
          <p className="text-foreground flex flex-wrap items-center gap-1.5 text-sm leading-5 font-medium break-words">
            {view.next.name}
            <StateBadge variant="source">{t('changed')}</StateBadge>
          </p>
        )}
        <DefinitionView
          definition={view.next}
          missingRights={[]}
          variant="edit"
          changes={changedFields(view.previous, view.next)}
        />
      </>
    );
  }
  return (
    <>
      <RecordLabel
        chip={{
          id: view.card.recordId,
          kind: view.card.kind,
          name: view.previous.name,
        }}
        variant="under"
      />
      <p className="text-foreground text-sm leading-5 break-words whitespace-pre-wrap">
        {view.previous.description}
      </p>
      <p className="text-muted-foreground text-xs leading-4 font-medium">
        {t('deleteNote', { kind: view.card.kind })}
      </p>
    </>
  );
}

/**
 * «Выполнено» of a created or changed record: «Использовать в чате» puts the created record as a chip into this
 * conversation's field; «Показать схему» opens the diagram panel (the drawer below 1024 px) with focus on its
 * heading; «Открыть» goes to the record's page.
 */
function RecordDoneActions({
  view,
}: {
  view: Exclude<RecordView, { action: 'delete' }>;
}) {
  const tLibrary = useTranslations('library');
  const t = useTranslations('agents.recordCard');
  const inChat = useInChat();
  const thread = useCardThread();
  const { workspace } = useShellServices();
  const { recordId, kind } = view.card;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      {view.action === 'create' && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="pointer-coarse:h-11"
          onClick={() =>
            inChat(
              { record: { id: recordId, kind, name: view.next.name } },
              thread,
            )
          }
        >
          {tLibrary('row.useInChat')}
        </Button>
      )}
      <button
        type="button"
        onClick={() => workspace.show({ tab: 'schema', focusHeading: true })}
        className="text-foreground focus-visible:ring-ring rounded-sm text-sm leading-5 underline underline-offset-2 outline-none focus-visible:ring-2"
      >
        {t('showDiagram')}
      </button>
      <ShellLink
        href={recordPath(recordId)}
        className="text-foreground focus-visible:ring-ring rounded-sm text-sm leading-5 underline underline-offset-2 outline-none focus-visible:ring-2"
      >
        {tLibrary('open')}
      </ShellLink>
    </div>
  );
}

/**
 * The brief's edit state, local to the card (design-web.md, Contract «DecisionCard»): the draft lives
 * while the card is in «Правка»; «Отмена» and Esc drop it and the text before the edit returns.
 */
function useBriefEdit() {
  const [draft, setDraft] = useState<BriefText | null>(null);
  const [emptyQuestion, setEmptyQuestion] = useState(false);

  return {
    /** The fields' values while editing; null outside «Правка». */
    draft,
    emptyQuestion,
    start: (original: BriefText) => setDraft(original),
    cancel: () => {
      setDraft(null);
      setEmptyQuestion(false);
    },
    change: (field: BriefField, value: string) => {
      setDraft((current) =>
        current === null ? null : { ...current, [field]: value },
      );
      if (field === 'question') setEmptyQuestion(false);
    },
    /** True when the question is empty: the request must not go out (state «Пустой вопрос»). */
    rejectEmpty: (): boolean => {
      const empty = draft !== null && draft.question.trim() === '';
      setEmptyQuestion(empty);
      return empty;
    },
  };
}

type Pressed = 'approve' | 'reject' | 'launch' | 'launchEdited';

/** A row button: in «Отправка» the pressed one shows the spinner in place of its label, at the same width. */
function DecisionButton({
  label,
  variant,
  pressed,
  busy,
  onClick,
  buttonRef,
}: {
  label: string;
  variant: 'default' | 'destructive' | 'outline' | 'ghost';
  pressed: boolean;
  busy: boolean;
  onClick: () => void;
  buttonRef?: (element: HTMLButtonElement | null) => void;
}) {
  return (
    <Button
      ref={buttonRef}
      type="button"
      size="sm"
      variant={variant}
      disabled={busy}
      aria-busy={pressed || undefined}
      onClick={onClick}
      className="relative pointer-coarse:h-11"
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
 * RN-05, deep-agents MC-22: «Задание · {имя}» by the deep agent of the brief's content (design-web.md, «Имя в
 * заголовке задания»), «Задание» while the library list is not read or has no such record; under it the deep agent's
 * record label. The run's origin does not exist before the confirmation, so the live list is the source.
 */
function BriefHeading({ deepAgentId }: { deepAgentId: string }) {
  const { libraryIndex } = useShellServices();
  const locale = useLocale();
  const tLibrary = useTranslations('library');
  // Subscribes to the list: the title follows a read that lands after the card.
  useStore(libraryIndex, (state) => state.records);
  const found = libraryIndex.summaryOf(deepAgentId);
  const live =
    found == null ? found : { ...found, name: builtinName(found, locale) };
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <h3 className="text-base leading-6 font-semibold break-words">
        {briefTitleName(tLibrary, deepAgentId, { summaryOf: () => live })}
      </h3>
      {live != null && (
        <RecordLabel
          summary={live}
          variant="under"
          href={recordPath(live.id)}
        />
      )}
    </div>
  );
}

/**
 * SL-02, MC-9 (self-learning design-web.md, KD-6): the summary in the library list carries no content, so
 * the deep agent's record is read once on mount. While the read is in flight, when it fails (the log is
 * `useResource`'s) and when the flag is off there is no line, and the card decides as before (DC-4).
 */
function SelfLearningNote({ deepAgentId }: { deepAgentId: string }) {
  const t = useTranslations('agents');
  const record = useResource(
    () => libraryApi.get(deepAgentId),
    deepAgentId,
    'library',
  );
  const learns =
    record.data?.kind === 'deep_agent' && record.data.content.selfLearning;
  if (!learns) return null;
  return (
    <p className="text-foreground flex items-start gap-1.5 text-xs leading-4 font-medium">
      <InfoIcon aria-hidden className="text-info mt-px size-3.5 shrink-0" />
      {t('decision.selfLearning')}
    </p>
  );
}

export type DecisionCardProps = {
  confirmation: Confirmation;
  /** The conversation's root asks: «Чат хочет выполнить:» (MC-19). */
  byChat: boolean;
  /** How the call of an approved record card ended; null before its result and for any other request. */
  saved: RecordSave | null;
  /** Sends the decision and re-reads; rejects when the server did not take it. */
  onDecide: (approve: boolean, args?: Record<string, unknown>) => Promise<void>;
};

/**
 * The one decision window of KD-5 (decision-card.md, UXRD CV-03, MC-19, MC-20, MC-21): a mutating action
 * of an agent or the chat, or a deep agent's brief. «Отправка» lasts until the re-read; the outcome comes from the
 * `Confirmation` status, so a decision taken in another copy shows its outcome with no error line.
 * The container is focusable (`tabIndex` −1) and found by `data-decision-id` («К запросу»).
 */
export function DecisionCard({
  confirmation,
  byChat,
  saved,
  onDecide,
}: DecisionCardProps) {
  const brief = briefOf(confirmation);
  const record = brief === null ? recordViewOf(confirmation) : null;
  const format = useFormatter();
  const locale = useLocale();
  const tAgents = useTranslations('agents');
  const tChat = useTranslations('chat');
  const { tools } = useMessages();
  const outcome =
    record === null
      ? outcomeOf(tAgents, confirmation, brief !== null, format)
      : recordOutcomeOf(
          { t: tAgents, tChat, format },
          confirmation,
          record,
          saved,
        );
  const edit = useBriefEdit();
  const editing = edit.draft !== null && outcome === null;
  const [pressed, setPressed] = useState<Pressed | null>(null);
  const [failed, setFailed] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const questionRef = useRef<HTMLTextAreaElement | null>(null);
  const editButtonRef = useRef<HTMLButtonElement | null>(null);
  const decidedHere = useRef(false);
  const pendingFocus = useRef<'question' | 'edit' | null>(null);
  const fieldId = useId();

  // After a decision taken here, focus moves to the card once its outcome shows (decision-card.md, Focus).
  useEffect(() => {
    if (outcome === null || !decidedHere.current) return;
    decidedHere.current = false;
    containerRef.current?.focus();
  }, [outcome]);

  // «Исправить» → the question field; «Отмена» → «Исправить».
  useEffect(() => {
    const target = pendingFocus.current;
    pendingFocus.current = null;
    if (target === 'question') questionRef.current?.focus();
    if (target === 'edit') editButtonRef.current?.focus();
  }, [editing]);

  const busy = pressed !== null;

  async function decide(
    which: Pressed,
    approve: boolean,
    args?: Record<string, unknown>,
  ): Promise<void> {
    if (busy) return;
    setPressed(which);
    setFailed(false);
    decidedHere.current = true;
    try {
      await onDecide(approve, args);
    } catch {
      // The store has logged the failure. The card shows the error line and keeps the pressed button for
      // a retry; an edited brief stays in «Правка» with the typed values (400 `INVALID_ARGUMENTS` included).
      decidedHere.current = false;
      setFailed(true);
    } finally {
      setPressed(null);
    }
  }

  const briefArgs = (text: BriefText): Record<string, unknown> | undefined =>
    brief === null
      ? undefined
      : { deepAgent: brief.deepAgent, ...pickText(text) };

  const startEdit = (): void => {
    if (brief === null) return;
    pendingFocus.current = 'question';
    setFailed(false);
    edit.start(brief.text);
  };
  const cancelEdit = (): void => {
    pendingFocus.current = 'edit';
    setFailed(false);
    edit.cancel();
  };
  const launchEdited = (): void => {
    if (busy || edit.draft === null || edit.rejectEmpty()) return;
    void decide('launchEdited', true, briefArgs(edit.draft));
  };
  const onEditKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Escape' || busy) return;
    event.preventDefault();
    cancelEdit();
  };

  const { tool, server, args } = confirmation;
  const toolTitle = server === null ? undefined : confirmation.toolTitle;
  const { title: toolName, args: argLabels } = toolCallLabels(tools, {
    tool,
    server,
    toolTitle,
    argLabels: confirmation.argLabels,
  });
  const runCode =
    brief === null && isRunCode(tool, server)
      ? runCodeView(args, argLabels)
      : null;
  const canCall = canCallOf(confirmation);
  const recordHeadingText =
    record === null ? null : recordHeading(tAgents, record);
  const groupName =
    brief !== null
      ? tAgents('decision.groupBrief', { question: brief.text.question })
      : tAgents('decision.groupAction', {
          tool: recordHeadingText ?? toolName,
        });

  const header =
    outcome === null ? (
      <div className="flex h-5 min-w-0 items-center justify-between gap-3">
        <AgentStatus
          variant="label"
          status="awaiting_confirmation"
          className="shrink-0"
        />
        <time
          dateTime={confirmation.createdAt}
          className="text-muted-foreground shrink-0 text-xs leading-4 font-medium tabular-nums"
        >
          {formatListTime(format, confirmation.createdAt)}
        </time>
      </div>
    ) : (
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

  const errorLine = failed && outcome === null && (
    <p
      role="alert"
      className="text-foreground flex items-start gap-1.5 text-sm leading-5"
    >
      <CircleXIcon
        aria-hidden
        className="text-destructive mt-0.5 size-4 shrink-0"
      />
      {tAgents('decision.sendFailed')}
    </p>
  );

  let body: ReactNode;
  let actions: ReactNode = null;

  if (record !== null) {
    body = (
      <>
        <h3 className="text-base leading-6 font-semibold break-words">
          {recordHeadingText}
        </h3>
        <RecordBody view={record} />
        {record.action !== 'delete' &&
          outcome?.kind === 'approved' &&
          saved?.outcome === 'success' && <RecordDoneActions view={record} />}
      </>
    );
    if (outcome === null) {
      const primary = {
        create: 'recordCard.createButton',
        edit: 'recordCard.saveButton',
        delete: 'recordCard.deleteButton',
      } as const;
      actions = (
        <>
          <DecisionButton
            label={tAgents(primary[record.action])}
            variant={record.action === 'delete' ? 'destructive' : 'default'}
            pressed={pressed === 'approve'}
            busy={busy}
            onClick={() => void decide('approve', true)}
          />
          <DecisionButton
            label={tAgents('decision.reject')}
            variant="outline"
            pressed={pressed === 'reject'}
            busy={busy}
            onClick={() => void decide('reject', false)}
          />
        </>
      );
    }
  } else if (brief === null) {
    body = (
      <>
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="text-foreground text-sm leading-5">
            {byChat
              ? tAgents('decision.byChat')
              : tAgents.rich('decision.byAgent', {
                  description: confirmation.description,
                  link: (chunks) => (
                    <Link
                      href={agentPath(confirmation.agentId)}
                      className="focus-visible:ring-ring rounded-sm underline-offset-2 outline-none hover:underline focus-visible:ring-2"
                    >
                      {chunks}
                    </Link>
                  ),
                })}
          </p>
          {/* RN-04: the asking agent's record; the chat's own request has none. */}
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
        <div className="flex min-w-0 flex-col">
          <p className="flex min-w-0 items-baseline gap-1.5">
            <span className="text-foreground min-w-0 text-sm leading-5 font-medium break-words">
              {toolName}
            </span>
            {toolTitle === undefined && server !== null && (
              <span className="text-muted-foreground shrink-0 text-xs leading-4 font-medium">
                · {server}
              </span>
            )}
          </p>
          {/* A built-in tool's title stands alone, without the technical line (decision-card.md, part 4). */}
          {toolTitle !== undefined && server !== null && (
            <p className="text-muted-foreground text-xs leading-4 font-medium break-words">{`${tool} · ${server}`}</p>
          )}
        </div>
        <ValueRows
          label={tChat('tool.arguments')}
          rows={runCode?.rows ?? valueRows(args, argLabels)}
          script={runCode?.script}
          raw={typeof args === 'string' ? args : JSON.stringify(args, null, 2)}
          disclosure
          density="ui"
        />
        {canCall !== null && <CanCallList items={canCall} />}
      </>
    );
    if (outcome === null) {
      actions = (
        <>
          <DecisionButton
            label={tAgents('decision.approve')}
            variant="default"
            pressed={pressed === 'approve'}
            busy={busy}
            onClick={() => void decide('approve', true)}
          />
          <DecisionButton
            label={tAgents('decision.reject')}
            variant="outline"
            pressed={pressed === 'reject'}
            busy={busy}
            onClick={() => void decide('reject', false)}
          />
        </>
      );
    }
  } else if (editing && edit.draft !== null) {
    const values = edit.draft;
    const errorId = `${fieldId}-question-error`;
    body = (
      <>
        <BriefHeading deepAgentId={brief.deepAgent} />
        <div className="flex flex-col gap-2" onKeyDown={onEditKeyDown}>
          {BRIEF_PARTS.map((field) => {
            const id = `${fieldId}-${field}`;
            const invalid = field === 'question' && edit.emptyQuestion;
            return (
              <div key={field} className="flex flex-col gap-1">
                <label
                  htmlFor={id}
                  className="text-muted-foreground text-xs leading-4 font-medium"
                >
                  {tAgents(`brief.${field}`)}
                </label>
                <Textarea
                  id={id}
                  ref={field === 'question' ? questionRef : undefined}
                  value={values[field]}
                  disabled={busy}
                  aria-invalid={invalid || undefined}
                  aria-describedby={invalid ? errorId : undefined}
                  onChange={(event) => edit.change(field, event.target.value)}
                  className="min-h-0 text-sm leading-5 md:text-sm"
                />
                {invalid && (
                  <p
                    id={errorId}
                    className="text-destructive text-xs leading-4 font-medium"
                  >
                    {tAgents('decision.emptyQuestion')}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </>
    );
    actions = (
      <>
        <DecisionButton
          label={tAgents('decision.launchEdited')}
          variant="default"
          pressed={pressed === 'launchEdited'}
          busy={busy}
          onClick={launchEdited}
        />
        <DecisionButton
          label={tAgents('decision.cancelEdit')}
          variant="outline"
          pressed={false}
          busy={busy}
          onClick={cancelEdit}
        />
      </>
    );
  } else {
    body = (
      <>
        <BriefHeading deepAgentId={brief.deepAgent} />
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
          {BRIEF_PARTS.map((field) => (
            <div key={field} className="contents">
              <dt className="text-muted-foreground pt-0.5 text-xs leading-4 font-medium">
                {tAgents(`brief.${field}`)}
              </dt>
              <dd className="text-foreground text-sm leading-5 break-words whitespace-pre-wrap">
                {brief.text[field]}
              </dd>
            </div>
          ))}
        </dl>
      </>
    );
    if (outcome === null) {
      actions = (
        <>
          <DecisionButton
            label={tAgents('decision.launch')}
            variant="default"
            pressed={pressed === 'launch'}
            busy={busy}
            onClick={() => void decide('launch', true, briefArgs(brief.text))}
          />
          <DecisionButton
            label={tAgents('decision.edit')}
            variant="outline"
            pressed={false}
            busy={busy}
            onClick={startEdit}
            buttonRef={(element) => {
              editButtonRef.current = element;
            }}
          />
          <DecisionButton
            label={tAgents('decision.reject')}
            variant="ghost"
            pressed={pressed === 'reject'}
            busy={busy}
            onClick={() => void decide('reject', false)}
          />
        </>
      );
    }
  }

  return (
    <div
      ref={containerRef}
      role="group"
      aria-label={groupName}
      tabIndex={-1}
      data-slot="decision-card"
      data-decision-id={confirmation.decisionId}
      data-state={outcome?.kind ?? (editing ? 'editing' : 'open')}
      className={cn(
        'mx-auto flex w-full max-w-(--prose-max-width) min-w-0 flex-col gap-2 rounded-lg border p-3 outline-none',
        'focus-visible:ring-ring transition-colors duration-(--duration-fast) focus-visible:ring-2 motion-reduce:transition-none',
        outcome === null
          ? 'bg-approval-subtle border-approval-border'
          : 'bg-card text-card-foreground border-border',
      )}
    >
      {header}
      {body}
      {/* Mounted here, outside the branches, so «Правка» and back keep the one read; a decided card drops it. */}
      {brief !== null && outcome === null && (
        <SelfLearningNote deepAgentId={brief.deepAgent} />
      )}
      {errorLine}
      {actions !== null && (
        <div
          className={cn(
            'flex flex-wrap items-center gap-2',
            // A record's buttons stand in a full-width column below 480 px (decision-card.md, Sizes).
            record !== null && 'max-[30rem]:flex-col max-[30rem]:items-stretch',
          )}
        >
          {actions}
        </div>
      )}
    </div>
  );
}
