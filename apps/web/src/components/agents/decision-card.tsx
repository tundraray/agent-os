'use client';

import { useEffect, useId, useState, type ReactNode } from 'react';
import {
  useFormatter,
  useLocale,
  useMessages,
  useTranslations,
} from 'next-intl';
import {
  RunCodeConfirmationContentSchema,
  AGENTS_BRIEF_CONFIRMATION,
  AGENTS_TOOL_CONFIRMATION,
  isCodeRunCall,
  LIBRARY_RECORD_CONFIRMATION,
  type Confirmation,
  type DecisionRequest,
  type LibraryRecordCard,
  type RunCodeConfirmationContent,
} from '@agent-os/contracts';
import {
  CircleCheckIcon,
  CircleMinusIcon,
  CircleStopIcon,
  CircleXIcon,
  InfoIcon,
} from 'lucide-react';
import { z } from 'zod';
import {
  CardHeader,
  CardSource,
  DecisionButton,
  ErrorLine,
  frameClass,
  useCardEdit,
  useDecisionSend,
  type Outcome,
} from '@/components/agents/card-parts';
import {
  useCardThread,
  useLiveRecord,
  useRecordNamed,
} from '@/components/agents/run-card';
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
import { useStore } from 'zustand';
import { BRIEF_PARTS } from '@/lib/agents/format';
import { builtinName, toolCallLabels } from '@/i18n/builtin-name';
import { formatListTime, type Formatter } from '@/i18n/formats';
import { runCodeView } from '@/lib/agents/run-code';
import { valueRows } from '@/lib/agents/value-rows';
import { describeApiError } from '@/lib/api/api-request';
import { useFeed, useFeedSelector } from '@/lib/feed/feed-context';
import {
  recordCardOf,
  type OfferPartData,
  type PlanPartData,
  type RecordSave,
} from '@/lib/feed/to-feed';
import { libraryApi } from '@/lib/library/library-api';
import { describeLibraryError } from '@/lib/library/library-errors';
import {
  briefTitleName,
  changedFields,
  type RecordDefinition,
} from '@/lib/library/record-rules';
import { logger } from '@/lib/logger';
import { recordPath } from '@/lib/shell-route';
import { NEW_THREAD_TARGET } from '@/lib/threads/composer-seed';
import { cn } from '@/lib/utils';
import type { AgentsTranslator, ChatTranslator } from '@/i18n/catalog';

type CanCall = RunCodeConfirmationContent['canCall'];

/**
 * The «Может вызвать» list of a code run's request, in the order the platform gave it (KD-6); null for
 * any other request and for content outside the contract — such a run does not start (DC-16).
 */
function canCallOf(confirmation: Confirmation): CanCall | null {
  if (!isCodeRunCall(confirmation.tool, confirmation.server)) return null;
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
 * shape: the deep agent's name travels inside `args` and goes back unchanged with the three fields
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

/**
 * MC-4: the outcome of «Разрешить в этой беседе», from the re-read decision; null for any other outcome, which
 * `outcomeOf` gives.
 */
function allowedOutcomeOf({
  t,
  format,
  confirmation,
  toolName,
}: {
  t: AgentsTranslator;
  format: Formatter;
  confirmation: Confirmation;
  toolName: string;
}): Outcome | null {
  if (
    confirmation.status !== 'resolved' ||
    confirmation.resolution?.allowInConversation !== true
  )
    return null;
  const time = formatListTime(
    format,
    confirmation.resolvedAt ?? confirmation.createdAt,
  );
  return {
    kind: 'approved',
    text: t('decision.allowedInConversation', { tool: toolName, time }),
    Icon: CircleCheckIcon,
    tone: 'text-success',
  };
}

/**
 * The third answer stands only on an MCP tool's action card — the server takes it on no other (KD-6): a code
 * run and an agent's script come without a server, a brief and a record card are other kinds.
 */
const allowsInConversation = (confirmation: Confirmation): boolean =>
  confirmation.kind === AGENTS_TOOL_CONFIRMATION &&
  confirmation.server !== null;

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

type Pressed = 'approve' | 'allow' | 'reject' | 'launch' | 'launchEdited';

const APPROVE: DecisionRequest = { approve: true };
const REJECT: DecisionRequest = { approve: false };
const ALLOW_IN_CONVERSATION: DecisionRequest = {
  approve: true,
  allowInConversation: true,
};

/**
 * RN-05, deep-agents MC-22: «Задание · {имя}» by the name of the brief's content (design-web.md, «Имя в
 * заголовке задания»); under it the label of the deep agent record that name starts, from the live list (the
 * run's origin does not exist before the confirmation), none for a temporary one.
 */
function BriefHeading({ deepAgentName }: { deepAgentName: string }) {
  const locale = useLocale();
  const tLibrary = useTranslations('library');
  const found = useRecordNamed('deep_agent', deepAgentName);
  const live =
    found == null ? found : { ...found, name: builtinName(found, locale) };
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <h3 className="text-base leading-6 font-semibold break-words">
        {briefTitleName(tLibrary, deepAgentName)}
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
 * SL-02, MC-9 (self-learning design-web.md, KD-6) for the deep agent record the brief's name starts; a
 * temporary deep agent has no record and learns nothing, so it has no line.
 */
function SelfLearningNote({ deepAgentName }: { deepAgentName: string }) {
  const found = useRecordNamed('deep_agent', deepAgentName);
  return found == null ? null : <SelfLearningLine deepAgentId={found.id} />;
}

/**
 * The summary in the library list carries no content, so the deep agent's record is read once on mount. While
 * the read is in flight, when it fails (the log is `useResource`'s) and when the flag is off there is no line,
 * and the card decides as before (DC-4).
 */
function SelfLearningLine({ deepAgentId }: { deepAgentId: string }) {
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
  onDecide: (decision: DecisionRequest) => Promise<void>;
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
  const tAgents = useTranslations('agents');
  const tChat = useTranslations('chat');
  const { tools } = useMessages();
  const { tool, server, args } = confirmation;
  const toolTitle = server === null ? undefined : confirmation.toolTitle;
  const { title: toolName, args: argLabels } = toolCallLabels(tools, {
    tool,
    server,
    toolTitle,
    argLabels: confirmation.argLabels,
  });
  const thirdAnswer =
    brief === null && record === null && allowsInConversation(confirmation);
  const outcome =
    record === null
      ? (allowedOutcomeOf({ t: tAgents, format, confirmation, toolName }) ??
        outcomeOf(tAgents, confirmation, brief !== null, format))
      : recordOutcomeOf(
          { t: tAgents, tChat, format },
          confirmation,
          record,
          saved,
        );
  const { pressed, busy, failed, containerRef, decide, clearFailure } =
    useDecisionSend<Pressed>({
      onDecide,
      decided: outcome !== null,
    });
  const [emptyQuestion, setEmptyQuestion] = useState(false);
  const { draft, setDraft, fieldRef, editButtonRef, start, cancel, onKeyDown } =
    useCardEdit<BriefText>({
      busy,
      onCancel: () => {
        clearFailure();
        setEmptyQuestion(false);
      },
    });
  const editing = draft !== null && outcome === null;
  const fieldId = useId();

  const launchDecision = (text: BriefText): DecisionRequest =>
    brief === null
      ? APPROVE
      : {
          approve: true,
          args: { deepAgent: brief.deepAgent, ...pickText(text) },
        };

  const startEdit = (): void => {
    if (brief === null) return;
    clearFailure();
    start(brief.text);
  };
  const changeField = (field: BriefField, value: string): void => {
    setDraft((current) =>
      current === null ? null : { ...current, [field]: value },
    );
    if (field === 'question') setEmptyQuestion(false);
  };
  const launchEdited = (): void => {
    if (busy || draft === null) return;
    // State «Пустой вопрос»: the request must not go out.
    const empty = draft.question.trim() === '';
    setEmptyQuestion(empty);
    if (empty) return;
    void decide('launchEdited', launchDecision(draft));
  };

  const runCode = brief === null ? runCodeView(confirmation, tools) : null;
  const canCall = canCallOf(confirmation);
  const recordHeadingText =
    record === null ? null : recordHeading(tAgents, record);
  const groupName =
    brief !== null
      ? tAgents('decision.groupBrief', { question: brief.text.question })
      : tAgents('decision.groupAction', {
          tool: recordHeadingText ?? toolName,
        });

  const header = (
    <CardHeader outcome={outcome} createdAt={confirmation.createdAt} />
  );

  const errorLine = failed && outcome === null && (
    <ErrorLine>{tAgents('decision.sendFailed')}</ErrorLine>
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
            onClick={() => void decide('approve', APPROVE)}
          />
          <DecisionButton
            label={tAgents('decision.reject')}
            variant="outline"
            pressed={pressed === 'reject'}
            busy={busy}
            onClick={() => void decide('reject', REJECT)}
          />
        </>
      );
    }
  } else if (brief === null) {
    body = (
      <>
        <CardSource
          confirmation={confirmation}
          byChat={byChat}
          phrase={(link) =>
            byChat
              ? tAgents('decision.byChat')
              : tAgents.rich('decision.byAgent', {
                  description: confirmation.description,
                  link,
                })
          }
        />
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
      // IM-04: with the third answer «Отклонить» steps down to `ghost`, «Подтвердить» stays the default.
      actions = (
        <>
          <DecisionButton
            label={tAgents('decision.approve')}
            variant="default"
            pressed={pressed === 'approve'}
            busy={busy}
            onClick={() => void decide('approve', APPROVE)}
          />
          {thirdAnswer && (
            <DecisionButton
              label={tAgents('decision.allowInConversation')}
              variant="outline"
              pressed={pressed === 'allow'}
              busy={busy}
              onClick={() => void decide('allow', ALLOW_IN_CONVERSATION)}
            />
          )}
          <DecisionButton
            label={tAgents('decision.reject')}
            variant={thirdAnswer ? 'ghost' : 'outline'}
            pressed={pressed === 'reject'}
            busy={busy}
            onClick={() => void decide('reject', REJECT)}
          />
        </>
      );
    }
  } else if (editing && draft !== null) {
    const values = draft;
    const errorId = `${fieldId}-question-error`;
    body = (
      <>
        <BriefHeading deepAgentName={brief.deepAgent} />
        <div className="flex flex-col gap-2" onKeyDown={onKeyDown}>
          {BRIEF_PARTS.map((field) => {
            const id = `${fieldId}-${field}`;
            const invalid = field === 'question' && emptyQuestion;
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
                  ref={field === 'question' ? fieldRef : undefined}
                  value={values[field]}
                  disabled={busy}
                  aria-invalid={invalid || undefined}
                  aria-describedby={invalid ? errorId : undefined}
                  onChange={(event) => changeField(field, event.target.value)}
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
          onClick={cancel}
        />
      </>
    );
  } else {
    body = (
      <>
        <BriefHeading deepAgentName={brief.deepAgent} />
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
            onClick={() => void decide('launch', launchDecision(brief.text))}
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
            onClick={() => void decide('reject', REJECT)}
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
      className={frameClass(outcome)}
    >
      {header}
      {body}
      {/* Mounted here, outside the branches, so «Правка» and back keep the one read; a decided card drops it. */}
      {brief !== null && outcome === null && (
        <SelfLearningNote deepAgentName={brief.deepAgent} />
      )}
      {errorLine}
      {actions !== null && (
        <div
          className={cn(
            'flex flex-wrap items-center gap-2',
            // A record's buttons, and the three answers, stand in a full-width column below 480 px
            // (decision-card.md, Sizes; UXRD Responsive «Карточка IM-04»).
            (record !== null || thirdAnswer) &&
              'max-[30rem]:flex-col max-[30rem]:items-stretch',
          )}
        >
          {actions}
        </div>
      )}
    </div>
  );
}

/**
 * Flow 2 «Взять этого агента» (the offer card and the line instead of the field): the take route, then the agent's
 * chip in the field of the conversation it returns — a new chat without one. Rejects with the refusal, logged here.
 */
export function useTakeAgent(): () => Promise<void> {
  const inChat = useInChat();
  const testRunId = useFeedSelector(
    (state) => state.view?.training?.trainingId ?? null,
    null,
  );
  return async () => {
    if (testRunId === null) return;
    try {
      const { threadId, record } = await libraryApi.takeTestRun(testRunId);
      inChat({ record }, threadId ?? NEW_THREAD_TARGET);
    } catch (error) {
      logger.warn('chat: test run take refused', {
        testRunId,
        failure: describeApiError(error),
      });
      throw error;
    }
  };
}

/**
 * A button of the trainer's cards: its pressed state, and the card's error line when the action fails — the
 * refusal's own text, or decision-card part 9. The outcome comes with the re-read, never from the button (KD-3).
 */
function useCardAction<Which extends string>() {
  const [pressed, setPressed] = useState<Which | null>(null);
  const [failure, setFailure] = useState<ReactNode>(null);
  const run = async (
    which: Which,
    action: () => Promise<void>,
    failureText: (error: unknown) => ReactNode,
  ): Promise<void> => {
    if (pressed !== null) return;
    setPressed(which);
    setFailure(null);
    try {
      await action();
    } catch (error) {
      setFailure(failureText(error));
    } finally {
      setPressed(null);
    }
  };
  return { pressed, failure, run };
}

/** The buttons of a trainer's card: a full-width column below 480 px (decision-card.md, Sizes). */
const TRAINER_ACTIONS_CLASS =
  'flex flex-wrap items-center gap-2 max-[30rem]:flex-col max-[30rem]:items-stretch';
const HINT_CLASS = 'text-muted-foreground text-xs leading-4 font-medium';

/** «Похожий агент» (CT-07, MC-15): the agent found by the trainer; «Создать нового» answers as a message would. */
export function OfferCard({ data }: { data: OfferPartData }) {
  const t = useTranslations('chat.testRun.offer');
  const tAgents = useTranslations('agents');
  const tErrors = useTranslations('errors');
  const format = useFormatter();
  const feed = useFeed();
  const take = useTakeAgent();
  const action = useCardAction<'take' | 'create'>();
  const { libraryIndex } = useShellServices();
  const { offer } = data;
  const live = useLiveRecord(offer.agentId);
  const missing = live == null;
  // The agent passes the chip rule, so it is in the employee's library list once that is read (KD-4).
  useEffect(() => {
    if (missing) void libraryIndex.refresh();
  }, [missing, libraryIndex]);

  const time = formatListTime(format, offer.at ?? data.createdAt);
  const outcome: Outcome | null =
    offer.state === 'taken'
      ? {
          kind: 'approved',
          text: t('taken', { time }),
          Icon: CircleCheckIcon,
          tone: 'text-success',
        }
      : offer.state === 'declined'
        ? {
            kind: 'rejected',
            text: t('declined', { time }),
            Icon: CircleMinusIcon,
            tone: 'text-muted-foreground',
          }
        : null;
  const busy = action.pressed !== null;
  return (
    <div
      role="group"
      aria-label={tAgents('decision.groupAction', { tool: t('title') })}
      data-slot="decision-card"
      data-variant="offer"
      className={frameClass(outcome)}
    >
      <CardHeader outcome={outcome} createdAt={data.createdAt} />
      <h3 className="text-base leading-6 font-semibold">{t('title')}</h3>
      {live != null && (
        <RecordLabel summary={live} variant="row" href={recordPath(live.id)} />
      )}
      {action.failure !== null && outcome === null && (
        <ErrorLine>{action.failure}</ErrorLine>
      )}
      {offer.state === 'waiting' && (
        <>
          <div className={TRAINER_ACTIONS_CLASS}>
            <DecisionButton
              label={t('take')}
              variant="default"
              pressed={action.pressed === 'take'}
              busy={busy}
              onClick={() =>
                void action.run(
                  'take',
                  take,
                  (error) =>
                    describeLibraryError(tErrors, error, { where: 'take' })
                      .text,
                )
              }
            />
            <DecisionButton
              label={t('create')}
              variant="outline"
              pressed={action.pressed === 'create'}
              busy={busy}
              onClick={() =>
                void action.run(
                  'create',
                  async () => feed?.send(t('create'), undefined, QUIET),
                  () => tAgents('decision.sendFailed'),
                )
              }
            />
          </div>
          <p className={HINT_CLASS}>{t('hint')}</p>
        </>
      )}
    </div>
  );
}

/** A card's button sends an ordinary message; its refusal stays on the card (plan Notes 3.6). */
const QUIET = { quiet: true };

/** «План» (CT-08, MC-16): the agent the trainer will create and its tests; «Создать и проверить» answers as a message would. */
export function PlanCard({ data }: { data: PlanPartData }) {
  const t = useTranslations('chat.testRun.plan');
  const tAgents = useTranslations('agents');
  const format = useFormatter();
  const feed = useFeed();
  const action = useCardAction<'confirm'>();
  const { currentUser } = useShellServices();
  const capUsd = useStore(
    currentUser,
    (state) => state.user?.trainingCapUsd ?? null,
  );
  const { plan } = data;
  const outcome: Outcome | null =
    plan.state === 'confirmed'
      ? {
          kind: 'approved',
          text: t('confirmed', {
            time: formatListTime(format, plan.at ?? data.createdAt),
          }),
          Icon: CircleCheckIcon,
          tone: 'text-success',
        }
      : plan.state === 'replaced'
        ? {
            kind: 'rejected',
            text: t('replaced'),
            Icon: CircleMinusIcon,
            tone: 'text-muted-foreground',
          }
        : null;
  const title = t('title', { name: data.name });
  const rows: [string, ReactNode][] = [
    [t('what'), data.description],
    [
      t('servers'),
      data.servers.length === 0 ? t('noServers') : data.servers.join(', '),
    ],
    [
      t('tests'),
      <ol key="tests" className="flex list-decimal flex-col gap-1 ps-5">
        {data.tests.map((test, index) => (
          <li key={index}>
            <p className="whitespace-pre-wrap">{test.task}</p>
            <p className="text-muted-foreground whitespace-pre-wrap">
              {t('expected', { result: test.expected })}
            </p>
          </li>
        ))}
      </ol>,
    ],
  ];
  return (
    <div
      role="group"
      aria-label={tAgents('decision.groupAction', { tool: title })}
      data-slot="decision-card"
      data-variant="plan"
      className={frameClass(outcome)}
    >
      <CardHeader outcome={outcome} createdAt={data.createdAt} />
      <h3 className="text-base leading-6 font-semibold break-words">{title}</h3>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 max-[30rem]:grid-cols-1">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground pt-0.5 text-xs leading-4 font-medium">
              {label}
            </dt>
            <dd className="text-foreground text-sm leading-5 break-words whitespace-pre-wrap">
              {value}
            </dd>
          </div>
        ))}
      </dl>
      {capUsd !== null && (
        <p className={HINT_CLASS}>
          {t('note', { cap: format.number(capUsd, 'usd') })}
        </p>
      )}
      {action.failure !== null && outcome === null && (
        <ErrorLine>{action.failure}</ErrorLine>
      )}
      {plan.state === 'waiting' && (
        <>
          <div className={TRAINER_ACTIONS_CLASS}>
            <DecisionButton
              label={t('confirm')}
              variant="default"
              pressed={action.pressed === 'confirm'}
              busy={action.pressed !== null}
              onClick={() =>
                void action.run(
                  'confirm',
                  async () => feed?.send(t('confirm'), undefined, QUIET),
                  () => tAgents('decision.sendFailed'),
                )
              }
            />
          </div>
          <p className={HINT_CLASS}>{t('hint')}</p>
        </>
      )}
    </div>
  );
}
