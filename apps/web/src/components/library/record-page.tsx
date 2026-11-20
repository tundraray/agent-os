"use client";

import { useEffect, useId, type ReactNode } from "react";
import { LoaderCircle } from "lucide-react";
import { useStore } from "zustand";
import type { RecordDetail, RecordKind, RecordSummary } from "@agent-os/contracts";
import { useAdminRight } from "@/components/admin/admin-gate";
import { PageHeader } from "@/components/shell/page-header";
import { ShellLink } from "@/components/shell/shell-link";
import { useShellServices } from "@/components/shell/shell-actions";
import { ThreadNotice } from "@/components/shell/thread-notice";
import { Button, buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useResource } from "@/hooks/use-resource";
import { accessApi } from "@/lib/access/access-api";
import { isNotFound } from "@/lib/admin/admin-errors";
import { formatModel } from "@/lib/agents/format";
import { focusShellTarget } from "@/lib/focus";
import { libraryApi } from "@/lib/library/library-api";
import { kindWord } from "@/lib/library/library-errors";
import { canUseInChat, recipientNote } from "@/lib/library/record-rules";
import { adminRecordPath, libraryPath, newRecordPath, recordPath } from "@/lib/shell-route";
import { blankAgent } from "./agent-fields";
import { useCopyRecord } from "./copy-record";
import { DefinitionView } from "./definition-view";
import { ownLaunchHint, RecordEditor, useTakenHandoff, type RecordEditorProps } from "./record-editor";
import { RecordLabel } from "./record-label";
import { useInChat } from "./use-in-chat";
import { blankWorkflow } from "./workflow-fields";

/** UXRD MC-6. */
const TEXT = {
  library: "Библиотека",
  useInChat: "Использовать в чате",
  copy: "Скопировать себе",
  openInPanel: "Открыть в панели",
  colleagueHint: (kind: RecordKind) => `Или назовите ${kindWord(kind)} в чате — чат запустит его сам.`,
  ownNamesake: (kind: RecordKind) =>
    `У вас есть свой ${kindWord(kind)} с таким именем: назовёте в чате — запустится ваш. Чтобы запустить этот, нажмите «Использовать в чате».`,
  severalNamesakes:
    "Таких имён несколько: назовёте в чате — чат выберет по описанию. Чтобы запустить именно этого, нажмите «Использовать в чате».",
  readOnly: (kind: RecordKind) =>
    `Автор открыл ${kindWord(kind)} только для чтения: ваш чат его не запускает. Чтобы пользоваться, скопируйте себе.`,
  modelMissing: (model: string, kind: RecordKind) =>
    `Модель ${formatModel(model)} вам недоступна — у вас ${kindWord(kind)} не запустится. Копия получит вашу модель.`,
  noModels: (model: string, kind: RecordKind) =>
    `Модель ${formatModel(model)} вам недоступна, а других моделей у вас нет — не запустится ни ${kindWord(kind)}, ни его копия.`,
} as const;

/** Rows of the definition skeleton (UXRD RV-01, Loading). */
const SKELETON_ROWS = [0, 1, 2, 3] as const;

export type RecordPageProps = { id: string };

/**
 * The record page `/library/<id>` (UXRD Screen 2). The record is read on every entry (read-on-open), the
 * library list too, for «Может запускать» and the launch hint. Any 404 — a foreign personal, closed,
 * deleted or missing record — is the one screen RV-02, which names nothing of the record (ADR-0016).
 */
export function RecordPage({ id }: RecordPageProps) {
  const { libraryIndex } = useShellServices();
  const record = useResource(() => libraryApi.get(id), id, "library");
  const handoff = useTakenHandoff(recordPath(id));

  useEffect(() => {
    void libraryIndex.refresh();
  }, [libraryIndex]);

  if (isNotFound(record.error)) return <ThreadNotice variant="library-not-found" />;
  if (record.status === "error") return <ThreadNotice variant="library-load-error" onRetry={record.reload} />;
  if (record.data === undefined) return <RecordSkeleton />;
  // An own record its owner may edit opens in the editor; company records change only in the panel (Invariant 3).
  if (record.data.mine && record.data.canEdit) {
    return <EditorPage start={{ saved: record.data }} handoff={handoff} />;
  }
  return <RecordView record={record.data} />;
}

/**
 * `/library/new/agent` and `/library/new/workflow`: the empty editor of that kind; the library list is read on
 * entry for «Может запускать» and «Из библиотеки…».
 */
export function NewRecordPage({ kind }: { kind: RecordKind }) {
  const { libraryIndex } = useShellServices();
  const handoff = useTakenHandoff(newRecordPath(kind));

  useEffect(() => {
    void libraryIndex.refresh();
  }, [libraryIndex]);

  return <EditorPage start={{ newKind: kind }} handoff={handoff} />;
}

/**
 * The editor's data, read on open (design-web.md, «Данные экранов»): the author's systems and default model
 * (`choices`) and their models. The editor waits for `choices` — a new record takes its model and «Максимум шагов» from there;
 * the models fill the model field and its banner once read.
 */
function EditorPage({
  start,
  handoff,
}: {
  start: { saved: RecordDetail } | { newKind: RecordKind };
  handoff: RecordEditorProps["handoff"];
}) {
  const choices = useResource(libraryApi.choices, "choices", "library");
  const models = useResource(accessApi.models, "models", "library");

  if (choices.status === "error") return <ThreadNotice variant="library-load-error" onRetry={choices.reload} />;
  if (choices.data === undefined) return <RecordSkeleton />;
  return (
    <RecordEditor
      mode="employee"
      source={
        "saved" in start
          ? start
          : { blank: start.newKind === "agent" ? blankAgent(choices.data) : blankWorkflow(choices.data) }
      }
      choices={{ ...choices.data, models: models.data?.models }}
      handoff={handoff}
    />
  );
}

/**
 * RV-01 «Просмотр»: a record the viewer sees but does not edit. Only «Использовать в чате» (by the web's
 * rule) and «Скопировать себе» — no «Поделиться», «Удалить» or fields (Invariant 3). A colleague's record
 * carries the recipient's note above its definition. Other employees' text is rendered as text only.
 */
function RecordView({ record }: { record: RecordDetail }) {
  const inChat = useInChat();
  const copy = useCopyRecord();
  const errorId = useId();
  const usable = canUseInChat(record);
  const note = recipientNote(record);
  const recipient = note !== null && record.author !== null ? { author: record.author.name, roles: note.roles } : null;
  const missingModel = record.missingRights.find((right) => right.executor === null && right.model !== null)?.model;
  // A company record changes only in the panel: an administrator gets the way there (RV-01).
  const inPanel = useAdminRight() === "admin" && record.author === null;

  // UXRD «Порядок фокуса»: once the record is on screen, focus lands on its title.
  useEffect(() => {
    focusShellTarget("page-title");
  }, [record.id]);

  return (
    <div className="h-full overflow-y-auto">
      <PageHeader title={record.name} parent={{ title: TEXT.library, href: libraryPath() }}>
        {usable && (
          <Button
            size="sm"
            className="pointer-coarse:h-11"
            onClick={() => inChat({ record: { id: record.id, kind: record.kind, name: record.name } })}
          >
            {TEXT.useInChat}
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          disabled={copy.pending}
          aria-describedby={copy.error === null ? undefined : errorId}
          className="pointer-coarse:h-11"
          onClick={() => copy.copy(record)}
        >
          {copy.pending && <LoaderCircle aria-hidden className="animate-spin motion-reduce:animate-none" />}
          {TEXT.copy}
        </Button>
        {inPanel && (
          <ShellLink
            href={adminRecordPath("library", record.id)}
            className={buttonVariants({ variant: "outline", size: "sm", className: "pointer-coarse:h-11" })}
          >
            {TEXT.openInPanel}
          </ShellLink>
        )}
      </PageHeader>
      {copy.dialog}
      <div className="mx-auto flex w-full max-w-(--thread-max-width) flex-col gap-4 px-4 py-4 md:py-6">
        <div className="flex flex-col gap-1">
          <RecordLabel variant="under" summary={record} />
          {usable ? (
            <Hint>
              <LaunchHint record={record} />
            </Hint>
          ) : (
            !record.mine && record.author !== null && !record.offerInChat && <Hint>{TEXT.readOnly(record.kind)}</Hint>
          )}
          {missingModel != null && <ModelHint model={missingModel} kind={record.kind} />}
          {copy.error !== null && (
            <p id={errorId} role="alert" className="text-destructive text-xs leading-4">
              {copy.error}
            </p>
          )}
        </div>
        <DefinitionView
          definition={record}
          missingRights={record.missingRights}
          variant="page"
          recipient={recipient}
          recordHref={recordPath}
        />
      </div>
    </div>
  );
}

function Hint({ children }: { children: ReactNode }) {
  return <p className="text-muted-foreground text-sm leading-5">{children}</p>;
}

/**
 * MC-6 launch hint of a record the chat may run: one's own; a colleague's, or, when the viewer has an own
 * record or several others of that kind under the same name, which one the chat will pick. Names compare
 * without case, as the server does.
 */
function LaunchHint({ record }: { record: RecordDetail }) {
  const { libraryIndex } = useShellServices();
  const records = useStore(libraryIndex, (state) => state.records);
  if (record.mine) return <>{ownLaunchHint(record.kind)}</>;
  const namesakes = namesakesOf(record, records);
  if (namesakes.some((other) => other.mine)) return <>{TEXT.ownNamesake(record.kind)}</>;
  if (namesakes.length > 0) return <>{TEXT.severalNamesakes}</>;
  return <>{TEXT.colleagueHint(record.kind)}</>;
}

function namesakesOf(record: RecordDetail, records: ReadonlyMap<string, RecordSummary> | null): RecordSummary[] {
  if (records === null) return [];
  const name = record.name.toLowerCase();
  return [...records.values()].filter(
    (other) => other.id !== record.id && other.kind === record.kind && other.name.toLowerCase() === name,
  );
}

/**
 * MC-6 model line: the record's model is not the viewer's. Whether the viewer has any model at all decides
 * between the two lines, so the viewer's models are read only here; until they are read nothing is shown,
 * and a failed read (logged by `useResource`) shows the line of a copy that gets the viewer's model.
 */
function ModelHint({ model, kind }: { model: string; kind: RecordKind }) {
  const models = useResource(accessApi.models, "models", "library");
  if (models.status === "loading") return null;
  const none = models.data !== undefined && models.data.models.length === 0;
  return <Hint>{none ? TEXT.noModels(model, kind) : TEXT.modelMissing(model, kind)}</Hint>;
}

/** RV-01 Loading: the header's actions and the definition rows as skeletons. */
function RecordSkeleton() {
  return (
    <div aria-busy className="mx-auto flex w-full max-w-(--thread-max-width) flex-col gap-4 px-4 py-4 md:py-6">
      <div aria-hidden className="flex flex-col gap-2">
        <Skeleton className="h-5 w-2/5" />
        <Skeleton className="h-3 w-3/5" />
      </div>
      <div aria-hidden className="flex flex-col gap-3">
        {SKELETON_ROWS.map((row) => (
          <div key={row} className="flex flex-col gap-1.5">
            <Skeleton className="h-3 w-1/5" />
            <Skeleton className="h-4 w-4/5" />
          </div>
        ))}
      </div>
    </div>
  );
}
