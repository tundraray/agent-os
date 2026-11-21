"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useStore } from "zustand";
import type { DraftActionRequest, DraftView } from "@agent-os/contracts";
import {
  CircleCheckIcon,
  CircleMinusIcon,
  CircleXIcon,
  PencilLineIcon,
  TriangleAlertIcon,
  type LucideIcon,
} from "lucide-react";
import { FadeSlot } from "@/components/agents/agent-status";
import { DecisionButton } from "@/components/agents/decision-card";
import { DefinitionView } from "@/components/library/definition-view";
import { ShareDialog } from "@/components/library/share-dialog";
import { useInChat, useLeaveThenGo } from "@/components/library/use-in-chat";
import { ShellLink } from "@/components/shell/shell-link";
import { useShellServices } from "@/components/shell/shell-actions";
import { Button } from "@/components/ui/button";
import { formatTime } from "@/lib/agents/format";
import { describeDraftRefusal, describeLibraryError, kindWord } from "@/lib/library/library-errors";
import { changedFields, definitionOf, freeName, isDraftStale } from "@/lib/library/record-rules";
import { useLiveRecord } from "@/components/agents/run-card";
import { newRecordPath, recordPath } from "@/lib/shell-route";
import { cn } from "@/lib/utils";

/** custom-agents UXRD MC-15 (the card), MC-8 (save-as), MC-19 (announcement). */
const TEXT = {
  status: "Черновик",
  newTitle: (draft: DraftView) => (draft.kind === "agent" ? "Новый агент" : "Новый workflow"),
  editTitle: (name: string) => `Правка «${name}»`,
  howToFix: "Чтобы поправить — напишите в чат, что изменить",
  save: "Сохранить",
  saveAs: (name: string) => `Сохранить как «${name}»`,
  openInEditor: "Открыть в редакторе",
  reject: "Отклонить",
  saved: "Сохранено",
  savedInEditor: "Сохранено в редакторе",
  rejected: "Отклонено",
  tryInChat: "Проверить в чате",
  share: "Поделиться",
  open: "Открыть",
  superseded: (name: string) => `Черновик «${name}» заменён новым ниже`,
  stale: (draft: DraftView) =>
    `${kindWord(draft.kind, true)} изменился после черновика. Попросите чат подготовить правку заново или откройте редактор.`,
} as const;

const CAPTION = "text-muted-foreground text-xs leading-4 font-medium";

type Pressed = "save" | "saveAs" | "reject";

type Outcome = { key: string; text: string; Icon: LucideIcon; tone: string };

/** The final line of a resolved draft; null while it waits. */
function outcomeOf(draft: DraftView): Outcome | null {
  const at = formatTime(draft.resolvedAt ?? draft.createdAt);
  switch (draft.state) {
    case "pending":
    case "superseded":
      return null;
    case "saved":
      return { key: "saved", text: `${TEXT.saved} · ${at}`, Icon: CircleCheckIcon, tone: "text-success" };
    case "saved_in_editor":
      return { key: "saved", text: `${TEXT.savedInEditor} · ${at}`, Icon: CircleCheckIcon, tone: "text-success" };
    case "rejected":
      return { key: "rejected", text: `${TEXT.rejected} · ${at}`, Icon: CircleMinusIcon, tone: "text-muted-foreground" };
  }
}

export type DraftCardProps = {
  draft: DraftView;
  /** The conversation's draft before this one: a replaced one gives the «изменено» marks (DC-8). */
  previous: DraftView | null;
  /** The conversation the card stands in: «Проверить в чате» puts the chip into its message field. */
  threadId: string;
  /** Sends the action and re-reads; `null` — resolved elsewhere (the re-read shows it); rejects on a failure. */
  onAction: (action: DraftActionRequest) => Promise<DraftView | null>;
};

/**
 * A record draft in the conversation (DC-01; decision-card.md, «Черновик записи»; design-web.md, KD-6). Not
 * a decision: it holds nothing and the tray never counts it. The outcome comes from the draft's state in the
 * feed, so a draft resolved in another tab shows its outcome without an error line (DC-9). The definition the
 * model wrote is rendered as text only.
 */
export function DraftCard({ draft, previous, threadId, onAction }: DraftCardProps) {
  const { libraryIndex, draftHandoff, announcer } = useShellServices();
  const router = useRouter();
  const leaveThenGo = useLeaveThenGo();
  const inChat = useInChat();
  const records = useStore(libraryIndex, (state) => state.records);
  // Live data of the edited record (stale rule, title) and of the saved one («Поделиться»).
  const edited = useLiveRecord(draft.recordId);
  const savedRecord = useLiveRecord(draft.savedRecordId);
  const [pressed, setPressed] = useState<Pressed | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const actedHere = useRef(false);

  const outcome = outcomeOf(draft);

  // After an action taken here, focus moves to the card once its outcome shows (decision-card.md, Focus).
  useEffect(() => {
    if (outcome === null || !actedHere.current) return;
    actedHere.current = false;
    containerRef.current?.focus();
  }, [outcome]);

  if (draft.state === "superseded") {
    return (
      <p
        data-slot="draft-card"
        className={cn(
          "mx-auto flex w-full max-w-(--prose-max-width) min-w-0 items-center gap-1 text-muted-foreground",
          "text-xs leading-4 font-medium animate-in fade-in-0 duration-(--duration-fast) motion-reduce:animate-none",
        )}
      >
        <CircleMinusIcon aria-hidden className="size-3.5 shrink-0" />
        <span className="min-w-0 break-words">{TEXT.superseded(draft.name)}</span>
      </p>
    );
  }

  const name = edited?.name ?? draft.name;
  const busy = pressed !== null;

  async function act(which: Pressed, action: DraftActionRequest): Promise<void> {
    if (busy) return;
    setPressed(which);
    setFailure(null);
    actedHere.current = true;
    try {
      const answer = await onAction(action);
      if (answer?.state === "saved") {
        announcer.getState().announce("announce.saved");
        void libraryIndex.refresh();
      }
    } catch (cause) {
      // The store has logged the failure; the card keeps its buttons for a retry.
      actedHere.current = false;
      setFailure(describeLibraryError(cause, { where: "editor", kind: draft.kind, name: draft.name }).text);
    } finally {
      setPressed(null);
    }
  }

  /** «Открыть в редакторе»: the draft goes to the new record's form, or to the edited record's page, in this tab. */
  const openInEditor = (): void => {
    const page = draft.recordId === null ? newRecordPath(draft.kind) : recordPath(draft.recordId);
    leaveThenGo(() => {
      draftHandoff.put({ threadId, draft, page });
      router.push(page);
    });
  };

  const header =
    outcome === null ? (
      <div className="flex h-5 min-w-0 items-center justify-between gap-3">
        <p className={cn(CAPTION, "flex min-w-0 items-center gap-1")}>
          <PencilLineIcon aria-hidden className="size-3.5 shrink-0" />
          {TEXT.status}
        </p>
        <time dateTime={draft.createdAt} className={cn(CAPTION, "shrink-0 tabular-nums")}>
          {formatTime(draft.createdAt)}
        </time>
      </div>
    ) : (
      <p className={cn("flex h-5 min-w-0 items-center gap-1 text-xs leading-4 font-medium tabular-nums", outcome.tone)}>
        <FadeSlot swapKey={outcome.key}>
          <outcome.Icon aria-hidden className="size-3.5" />
        </FadeSlot>
        <span className="min-w-0 truncate animate-in fade-in-0 duration-(--duration-fast) motion-reduce:animate-none">
          {outcome.text}
        </span>
      </p>
    );

  const nameLine = <p className="text-foreground min-w-0 text-sm leading-5 font-medium break-words">{draft.name}</p>;

  let body: ReactNode;
  let actions: ReactNode = null;

  if (draft.state === "pending") {
    const stale = isDraftStale(draft, edited);
    const refusal = draft.refusal !== null && draft.refusal !== "version_conflict" ? draft.refusal : null;
    const refusalText =
      refusal === null
        ? null
        : describeDraftRefusal(refusal, {
            kind: draft.kind,
            name: draft.name,
            model: draft.kind === "agent" ? (draft.content.model ?? undefined) : undefined,
          });
    // «Сохранить как» needs the owner's names; until the list is read there is no free name to offer.
    const ownNames =
      records === null
        ? null
        : [...records.values()].filter((r) => r.mine && r.id !== draft.recordId).map((r) => r.name);
    const saveAsName = refusal === "name_taken" && ownNames !== null ? freeName(draft.name, ownNames) : null;
    const changed = previous?.state === "superseded" ? changedFields(definitionOf(previous), definitionOf(draft)) : undefined;

    body = (
      <>
        <div className="flex min-w-0 flex-col gap-0.5">
          <h3 className="text-base leading-6 font-semibold break-words">
            {draft.recordId === null ? TEXT.newTitle(draft) : TEXT.editTitle(name)}
          </h3>
          {nameLine}
        </div>
        <DefinitionView definition={draft} missingRights={[]} variant="card" changed={changed} recordHref={recordPath} />
        {stale && (
          <p className="text-foreground flex items-start gap-1.5 text-sm leading-5">
            <TriangleAlertIcon aria-hidden className="text-warning mt-0.5 size-4 shrink-0" />
            {TEXT.stale(draft)}
          </p>
        )}
        {!stale && refusalText !== null && <ErrorLine text={refusalText} />}
        {failure !== null && <ErrorLine text={failure} alert />}
        <p className={CAPTION}>{TEXT.howToFix}</p>
      </>
    );
    actions = (
      <>
        <DecisionButton
          label={TEXT.save}
          variant="default"
          pressed={pressed === "save"}
          busy={busy}
          unavailable={stale}
          onClick={() => void act("save", { action: "save" })}
        />
        {saveAsName !== null && !stale && (
          <DecisionButton
            label={TEXT.saveAs(saveAsName)}
            variant="outline"
            pressed={pressed === "saveAs"}
            busy={busy}
            onClick={() => void act("saveAs", { action: "save", name: saveAsName })}
          />
        )}
        <DecisionButton label={TEXT.openInEditor} variant="outline" pressed={false} busy={busy} onClick={openInEditor} />
        <DecisionButton
          label={TEXT.reject}
          variant="ghost"
          pressed={pressed === "reject"}
          busy={busy}
          onClick={() => void act("reject", { action: "reject" })}
        />
      </>
    );
  } else if (draft.state === "rejected" || draft.savedRecordId === null) {
    body = nameLine;
  } else {
    const recordId = draft.savedRecordId;
    const savedName = savedRecord?.name ?? draft.name;
    body = (
      <>
        {nameLine}
        {savedRecord != null && savedRecord.canShare && (
          <ShareDialog variant="employee" record={savedRecord} open={sharing} onOpenChange={setSharing} onSaved={() => {}} />
        )}
      </>
    );
    actions = (
      <>
        <Button
          type="button"
          size="sm"
          className="pointer-coarse:h-11"
          onClick={() => inChat({ record: { id: recordId, kind: draft.kind, name: savedName } }, threadId)}
        >
          {TEXT.tryInChat}
        </Button>
        {savedRecord != null && savedRecord.canShare && (
          <Button type="button" size="sm" variant="outline" className="pointer-coarse:h-11" onClick={() => setSharing(true)}>
            {TEXT.share}
          </Button>
        )}
        <ShellLink
          href={recordPath(recordId)}
          className="text-foreground focus-visible:ring-ring rounded-sm text-sm leading-5 font-medium underline-offset-2 outline-none hover:underline focus-visible:ring-2"
        >
          {TEXT.open}
        </ShellLink>
      </>
    );
  }

  return (
    <div
      ref={containerRef}
      role="group"
      aria-label={`${TEXT.status}: ${draft.name}`}
      tabIndex={-1}
      data-slot="draft-card"
      data-draft-id={draft.draftId}
      data-state={draft.state}
      className={cn(
        "mx-auto flex w-full max-w-(--prose-max-width) min-w-0 flex-col gap-2 rounded-lg border p-3 outline-none",
        "bg-card text-card-foreground border-border focus-visible:ring-ring focus-visible:ring-2",
      )}
    >
      {header}
      {body}
      {actions !== null && (
        // Below 480 px the draft's buttons stand in a full-width column (decision-card.md, Variants & Sizes).
        <div className="flex flex-wrap items-center gap-2 max-[480px]:flex-col max-[480px]:items-stretch">{actions}</div>
      )}
    </div>
  );
}

function ErrorLine({ text, alert = false }: { text: string; alert?: boolean }) {
  return (
    <p role={alert ? "alert" : undefined} className="text-foreground flex items-start gap-1.5 text-sm leading-5">
      <CircleXIcon aria-hidden className="text-destructive mt-0.5 size-4 shrink-0" />
      {text}
    </p>
  );
}
