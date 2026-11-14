"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import Link from "next/link";
import { WORKFLOWS_BRIEF_CONFIRMATION, type Confirmation } from "@agent-os/contracts";
import { CircleCheckIcon, CircleMinusIcon, CircleStopIcon, CircleXIcon, LoaderCircleIcon, type LucideIcon } from "lucide-react";
import { z } from "zod";
import { AgentStatus, FadeSlot, StatusGlyph } from "@/components/agents/agent-status";
import { ValueRows } from "@/components/agents/value-rows";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { formatTime } from "@/lib/agents/format";
import { valueRows } from "@/lib/agents/value-rows";
import { logger } from "@/lib/logger";
import { agentPath } from "@/lib/shell-route";
import { cn } from "@/lib/utils";

/** UXRD MC-19 (action) and MC-20 (brief), verbatim. */
const TEXT = {
  byChat: "Чат хочет выполнить:",
  args: "Аргументы",
  approve: "Подтвердить",
  reject: "Отклонить",
  approved: "Подтверждено",
  rejected: "Отклонено",
  cancelled: "Не понадобилось: агент остановлен",
  sendFailed: "Не удалось отправить решение. Попробуйте ещё раз.",
  briefTitle: "Бриф",
  question: "Вопрос",
  boundaries: "Границы",
  result: "Результат",
  launch: "Запустить",
  edit: "Исправить",
  launchEdited: "Запустить с правками",
  cancelEdit: "Отмена",
  emptyQuestion: "Вопрос не может быть пустым",
  briefApproved: "Бриф подтверждён",
  briefRejected: "Бриф отклонён",
} as const;

/** The brief's three fields, in card order (MC-20). */
const BRIEF_FIELDS = ["question", "boundaries", "result"] as const;
type BriefField = (typeof BRIEF_FIELDS)[number];
type BriefText = Record<BriefField, string>;

const BRIEF_FIELD_LABEL: Record<BriefField, string> = {
  question: TEXT.question,
  boundaries: TEXT.boundaries,
  result: TEXT.result,
};

/**
 * `start_workflow` arguments as the confirmation carries them: the template name travels inside `args`
 * and goes back unchanged with the three fields (design-web.md, Flow 2).
 */
const BriefArgsSchema = z.object({
  template: z.string().min(1),
  question: z.string(),
  boundaries: z.string(),
  result: z.string(),
});
/** The brief card content (`title` and the three fields). */
const BriefContentSchema = z.object({
  title: z.string(),
  question: z.string(),
  boundaries: z.string(),
  result: z.string(),
});

type Brief = { template: string; title: string; text: BriefText };

const pickText = (value: BriefText): BriefText => ({
  question: value.question,
  boundaries: value.boundaries,
  result: value.result,
});

/**
 * The brief of a `workflows.brief` confirmation; null when the shape is not the built one, and the card
 * then shows the request as an action (tool and arguments), which can still be decided.
 */
function briefOf(confirmation: Confirmation): Brief | null {
  if (confirmation.kind !== WORKFLOWS_BRIEF_CONFIRMATION) return null;
  const args = BriefArgsSchema.safeParse(confirmation.args);
  const content = BriefContentSchema.safeParse(confirmation.content);
  if (!args.success || !content.success) {
    logger.warn("[web-feed] brief confirmation outside the contract", {
      decisionId: confirmation.decisionId,
      argsValid: args.success,
      contentValid: content.success,
    });
    return null;
  }
  // A confirmed brief shows the text it ran with, edits included (decision-card.md, States).
  const ran =
    confirmation.resolution?.approve === true ? BriefArgsSchema.safeParse(confirmation.resolution.args) : null;
  return {
    template: args.data.template,
    title: confirmation.templateTitle ?? content.data.title,
    text: pickText(ran?.success === true ? ran.data : content.data),
  };
}

type Outcome = { kind: "approved" | "rejected" | "cancelled"; text: string; Icon: LucideIcon; tone: string };

/** The final line of a decided request (MC-19, MC-20); null while it is open. */
function outcomeOf(confirmation: Confirmation, isBrief: boolean): Outcome | null {
  if (confirmation.status === "open") return null;
  if (confirmation.status === "cancelled") {
    return { kind: "cancelled", text: TEXT.cancelled, Icon: CircleStopIcon, tone: "text-muted-foreground" };
  }
  const time = formatTime(confirmation.resolvedAt ?? confirmation.createdAt);
  if (confirmation.resolution?.approve === true) {
    const word = isBrief ? TEXT.briefApproved : TEXT.approved;
    return { kind: "approved", text: `${word} · ${time}`, Icon: CircleCheckIcon, tone: "text-success" };
  }
  const word = isBrief ? TEXT.briefRejected : TEXT.rejected;
  return { kind: "rejected", text: `${word} · ${time}`, Icon: CircleMinusIcon, tone: "text-muted-foreground" };
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
      setDraft((current) => (current === null ? null : { ...current, [field]: value }));
      if (field === "question") setEmptyQuestion(false);
    },
    /** True when the question is empty: the request must not go out (state «Пустой вопрос»). */
    rejectEmpty: (): boolean => {
      const empty = draft !== null && draft.question.trim() === "";
      setEmptyQuestion(empty);
      return empty;
    },
  };
}

type Pressed = "approve" | "reject" | "launch" | "launchEdited";

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
  variant: "default" | "outline" | "ghost";
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
      <span className={cn(pressed && "opacity-0")}>{label}</span>
      {pressed && (
        <span aria-hidden className="absolute inset-0 flex items-center justify-center">
          <StatusGlyph Icon={LoaderCircleIcon} spinning />
        </span>
      )}
    </Button>
  );
}

export type DecisionCardProps = {
  confirmation: Confirmation;
  /** The conversation's root asks: «Чат хочет выполнить:» (MC-19). */
  byChat: boolean;
  /** Sends the decision and re-reads; rejects when the server did not take it. */
  onDecide: (approve: boolean, args?: Record<string, unknown>) => Promise<void>;
};

/**
 * The one decision window of KD-5 (decision-card.md, UXRD CV-03, MC-19, MC-20): a mutating action of an
 * agent or the chat, or a workflow brief. «Отправка» lasts until the re-read; the outcome comes from the
 * `Confirmation` status, so a decision taken in another copy shows its outcome with no error line.
 * The container is focusable (`tabIndex` −1) and found by `data-decision-id` («К запросу»).
 */
export function DecisionCard({ confirmation, byChat, onDecide }: DecisionCardProps) {
  const brief = briefOf(confirmation);
  const outcome = outcomeOf(confirmation, brief !== null);
  const edit = useBriefEdit();
  const editing = edit.draft !== null && outcome === null;
  const [pressed, setPressed] = useState<Pressed | null>(null);
  const [failed, setFailed] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const questionRef = useRef<HTMLTextAreaElement | null>(null);
  const editButtonRef = useRef<HTMLButtonElement | null>(null);
  const decidedHere = useRef(false);
  const pendingFocus = useRef<"question" | "edit" | null>(null);
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
    if (target === "question") questionRef.current?.focus();
    if (target === "edit") editButtonRef.current?.focus();
  }, [editing]);

  const busy = pressed !== null;

  async function decide(which: Pressed, approve: boolean, args?: Record<string, unknown>): Promise<void> {
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
    brief === null ? undefined : { template: brief.template, ...pickText(text) };

  const startEdit = (): void => {
    if (brief === null) return;
    pendingFocus.current = "question";
    setFailed(false);
    edit.start(brief.text);
  };
  const cancelEdit = (): void => {
    pendingFocus.current = "edit";
    setFailed(false);
    edit.cancel();
  };
  const launchEdited = (): void => {
    if (busy || edit.draft === null || edit.rejectEmpty()) return;
    void decide("launchEdited", true, briefArgs(edit.draft));
  };
  const onEditKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "Escape" || busy) return;
    event.preventDefault();
    cancelEdit();
  };

  const { tool, server, args, toolTitle } = confirmation;
  /** The tool's human title when its server gives one; the technical name otherwise. */
  const toolName = toolTitle ?? tool;
  const groupName = brief !== null ? `${TEXT.briefTitle}: ${brief.text.question}` : `Нужно решение: ${toolName}`;

  const header =
    outcome === null ? (
      <div className="flex h-5 min-w-0 items-center justify-between gap-3">
        <AgentStatus variant="label" status="awaiting_confirmation" className="shrink-0" />
        <time
          dateTime={confirmation.createdAt}
          className="text-muted-foreground shrink-0 text-xs leading-4 font-medium tabular-nums"
        >
          {formatTime(confirmation.createdAt)}
        </time>
      </div>
    ) : (
      <p className={cn("flex h-5 min-w-0 items-center gap-1 text-xs leading-4 font-medium tabular-nums", outcome.tone)}>
        <FadeSlot swapKey={outcome.kind}>
          <outcome.Icon aria-hidden className="size-3.5" />
        </FadeSlot>
        <span className="min-w-0 truncate animate-in fade-in-0 duration-(--duration-fast) motion-reduce:animate-none">
          {outcome.text}
        </span>
      </p>
    );

  const errorLine = failed && outcome === null && (
    <p role="alert" className="text-foreground flex items-start gap-1.5 text-sm leading-5">
      <CircleXIcon aria-hidden className="text-destructive mt-0.5 size-4 shrink-0" />
      {TEXT.sendFailed}
    </p>
  );

  let body: ReactNode;
  let actions: ReactNode = null;

  if (brief === null) {
    body = (
      <>
        <p className="text-foreground text-sm leading-5">
          {byChat ? (
            TEXT.byChat
          ) : (
            <>
              {"Агент «"}
              <Link
                href={agentPath(confirmation.agentId)}
                className="focus-visible:ring-ring rounded-sm underline-offset-2 outline-none hover:underline focus-visible:ring-2"
              >
                {confirmation.description}
              </Link>
              {"» хочет выполнить:"}
            </>
          )}
        </p>
        <div className="flex min-w-0 flex-col">
          <p className="flex min-w-0 items-baseline gap-1.5">
            <span className="text-foreground min-w-0 text-sm leading-5 font-medium break-words">{toolName}</span>
            {toolTitle === undefined && server !== null && (
              <span className="text-muted-foreground shrink-0 text-xs leading-4 font-medium">· {server}</span>
            )}
          </p>
          {toolTitle !== undefined && (
            <p className="text-muted-foreground text-xs leading-4 font-medium break-words">
              {server === null ? tool : `${tool} · ${server}`}
            </p>
          )}
        </div>
        <ValueRows
          label={TEXT.args}
          rows={valueRows(args, confirmation.argLabels)}
          raw={typeof args === "string" ? args : JSON.stringify(args, null, 2)}
          disclosure
          density="ui"
        />
      </>
    );
    if (outcome === null) {
      actions = (
        <>
          <DecisionButton
            label={TEXT.approve}
            variant="default"
            pressed={pressed === "approve"}
            busy={busy}
            onClick={() => void decide("approve", true)}
          />
          <DecisionButton
            label={TEXT.reject}
            variant="outline"
            pressed={pressed === "reject"}
            busy={busy}
            onClick={() => void decide("reject", false)}
          />
        </>
      );
    }
  } else if (editing && edit.draft !== null) {
    const values = edit.draft;
    const errorId = `${fieldId}-question-error`;
    body = (
      <>
        <h3 className="text-base leading-6 font-semibold break-words">{`${TEXT.briefTitle} · ${brief.title}`}</h3>
        <div className="flex flex-col gap-2" onKeyDown={onEditKeyDown}>
          {BRIEF_FIELDS.map((field) => {
            const id = `${fieldId}-${field}`;
            const invalid = field === "question" && edit.emptyQuestion;
            return (
              <div key={field} className="flex flex-col gap-1">
                <label htmlFor={id} className="text-muted-foreground text-xs leading-4 font-medium">
                  {BRIEF_FIELD_LABEL[field]}
                </label>
                <Textarea
                  id={id}
                  ref={field === "question" ? questionRef : undefined}
                  value={values[field]}
                  disabled={busy}
                  aria-invalid={invalid || undefined}
                  aria-describedby={invalid ? errorId : undefined}
                  onChange={(event) => edit.change(field, event.target.value)}
                  className="min-h-0 text-sm leading-5 md:text-sm"
                />
                {invalid && (
                  <p id={errorId} className="text-destructive text-xs leading-4 font-medium">
                    {TEXT.emptyQuestion}
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
          label={TEXT.launchEdited}
          variant="default"
          pressed={pressed === "launchEdited"}
          busy={busy}
          onClick={launchEdited}
        />
        <DecisionButton label={TEXT.cancelEdit} variant="outline" pressed={false} busy={busy} onClick={cancelEdit} />
      </>
    );
  } else {
    body = (
      <>
        <h3 className="text-base leading-6 font-semibold break-words">{`${TEXT.briefTitle} · ${brief.title}`}</h3>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
          {BRIEF_FIELDS.map((field) => (
            <div key={field} className="contents">
              <dt className="text-muted-foreground pt-0.5 text-xs leading-4 font-medium">{BRIEF_FIELD_LABEL[field]}</dt>
              <dd className="text-foreground text-sm leading-5 break-words whitespace-pre-wrap">{brief.text[field]}</dd>
            </div>
          ))}
        </dl>
      </>
    );
    if (outcome === null) {
      actions = (
        <>
          <DecisionButton
            label={TEXT.launch}
            variant="default"
            pressed={pressed === "launch"}
            busy={busy}
            onClick={() => void decide("launch", true, briefArgs(brief.text))}
          />
          <DecisionButton
            label={TEXT.edit}
            variant="outline"
            pressed={false}
            busy={busy}
            onClick={startEdit}
            buttonRef={(element) => {
              editButtonRef.current = element;
            }}
          />
          <DecisionButton
            label={TEXT.reject}
            variant="ghost"
            pressed={pressed === "reject"}
            busy={busy}
            onClick={() => void decide("reject", false)}
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
      data-state={outcome?.kind ?? (editing ? "editing" : "open")}
      className={cn(
        "mx-auto flex w-full max-w-(--prose-max-width) min-w-0 flex-col gap-2 rounded-lg border p-3 outline-none",
        "focus-visible:ring-ring transition-colors duration-(--duration-fast) focus-visible:ring-2 motion-reduce:transition-none",
        outcome === null ? "bg-approval-subtle border-approval-border" : "bg-card text-card-foreground border-border",
      )}
    >
      {header}
      {body}
      {errorLine}
      {actions !== null && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
