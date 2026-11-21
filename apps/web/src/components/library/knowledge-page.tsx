"use client";

import { useEffect, useState, type ReactNode } from "react";
import { CircleMinus, Info, LightbulbIcon } from "lucide-react";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import type { KnowledgeView, RecordDetail } from "@agent-os/contracts";
import { PANEL_TITLE, RecordPlaceholder, sectionParent } from "@/components/admin/admin-header";
import { DataTable, resourceTableState } from "@/components/admin/data-table";
import { PageHeader } from "@/components/shell/page-header";
import { ShellLink } from "@/components/shell/shell-link";
import { ThreadNotice } from "@/components/shell/thread-notice";
import { buttonVariants } from "@/components/ui/button";
import { useResource, type Resource } from "@/hooks/use-resource";
import { adminApi } from "@/lib/admin/admin-api";
import { focusShellTarget } from "@/lib/focus";
import { builtinName } from "@/lib/i18n/builtin-name";
import { libraryApi } from "@/lib/library/library-api";
import { isKnowledgeHidden } from "@/lib/library/library-errors";
import {
  knowledgeEmpty,
  knowledgeStateLines,
  type KnowledgeAudience,
  type KnowledgeStateLine,
} from "@/lib/library/knowledge-view";
import { adminRecordPath, libraryPath, recordPath } from "@/lib/shell-route";
import { cn } from "@/lib/utils";
import { knowledgeColumns, KnowledgeList } from "./knowledge-list";
import { RecordSkeleton } from "./record-page";

export type KnowledgePageProps = { id: string; variant: "library" | "panel" };

/**
 * UXRD KN-01 / KN-03 (self-learning design-web.md, KD-1): «Что узнал workflow» in the library and in the panel.
 * The record (name, kind, author) and the graph are read in parallel on open (read-on-open). A 404 of either read
 * or the graph's 403 `KNOWLEDGE_FORBIDDEN` — and an agent at this address — is the place's «Не найдено», which
 * names nothing (ADR-0016). Until the graph has answered once nothing of the record is drawn, so a closed graph
 * never shows its workflow's name first.
 */
export function KnowledgePage({ id, variant }: KnowledgePageProps) {
  const t = useTranslations("library");
  const record = useResource(
    () => (variant === "library" ? libraryApi.get(id) : adminApi.library.get(id)),
    `${variant}:record:${id}`,
    "library",
  );
  const graph = useResource(() => libraryApi.knowledge(id), `knowledge:${id}`, "library");
  // The graph's first answer, kept so that a retry of a failed graph keeps the header on screen.
  const [graphAnswered, setGraphAnswered] = useState(false);
  if (!graphAnswered && graph.status !== "loading") setGraphAnswered(true);

  const hidden = isKnowledgeHidden(record.error) || isKnowledgeHidden(graph.error) || record.data?.kind === "agent";
  if (hidden) {
    return variant === "library" ? (
      <ThreadNotice variant="library-not-found" />
    ) : (
      <ThreadNotice variant="record-not-found" section="library" />
    );
  }
  if (record.status === "error") {
    return variant === "library" ? (
      <ThreadNotice variant="library-load-error" onRetry={record.reload} />
    ) : (
      <RecordPlaceholder section="library" resource={record} loadFailed={t("knowledge.loadFailed")} />
    );
  }
  if (record.data === undefined || !graphAnswered) {
    return variant === "library" ? (
      <RecordSkeleton />
    ) : (
      <RecordPlaceholder section="library" resource={{ status: "loading", reload: record.reload }} loadFailed={t("knowledge.loadFailed")} />
    );
  }

  const audience: KnowledgeAudience = { employeeInPanel: variant === "panel" && record.data.author !== null };
  const header = <KnowledgeHeader record={record.data} variant={variant} />;
  const body = <KnowledgeBody recordId={id} graph={graph} audience={audience} />;
  // The panel's frame pads its screens; the library page scrolls in the feed's column.
  if (variant === "panel") {
    return (
      <>
        {header}
        {body}
      </>
    );
  }
  return (
    <div className="h-full overflow-y-auto">
      {header}
      <div className="mx-auto flex w-full max-w-(--thread-max-width) flex-col px-4 py-4 md:py-6">{body}</div>
    </div>
  );
}

/** MC-2: the `h1`, the parent of the place and «Открыть workflow»; focus lands on the `h1` once it is drawn. */
function KnowledgeHeader({ record, variant }: { record: RecordDetail; variant: KnowledgePageProps["variant"] }) {
  const t = useTranslations("library");
  const locale = useLocale();
  useEffect(() => {
    focusShellTarget("page-title");
  }, [record.id]);

  const library = variant === "library";
  return (
    <PageHeader
      title={t("knowledge.title", { name: builtinName(record, locale) })}
      parent={library ? { title: t("screen.title"), href: libraryPath() } : sectionParent("library")}
      area={library ? undefined : PANEL_TITLE}
    >
      <ShellLink
        href={library ? recordPath(record.id) : adminRecordPath("library", record.id)}
        className={buttonVariants({ variant: "outline", size: "sm", className: "pointer-coarse:h-11" })}
      >
        {t("knowledge.openWorkflow")}
      </ShellLink>
    </PageHeader>
  );
}

/**
 * Under the header (design-web.md, «Как экран выбирает, что показать»): the table's Loading or its error with
 * «Повторить» while the graph is not there; the table's empty state MC-5 for an empty graph; otherwise the state
 * lines and the list.
 */
function KnowledgeBody({
  recordId,
  graph,
  audience,
}: {
  recordId: string;
  graph: Resource<KnowledgeView>;
  audience: KnowledgeAudience;
}) {
  const view = graph.data;
  const format = useFormatter();
  const t = useTranslations("library");
  // A re-read after a delete can replace the table the focus was in (the active tab disappears, the graph becomes
  // empty) — `DataTable` then sees no row leave. Focus that fell to the page body goes to the `h1`.
  useEffect(() => {
    if (document.activeElement === null || document.activeElement === document.body) focusShellTarget("page-title");
  }, [view]);
  if (view === undefined || view.items.length === 0) {
    const state = resourceTableState(graph, t("knowledge.loadFailed"), (data) => ({
      rows: [],
      empty: { Icon: LightbulbIcon, ...knowledgeEmpty(t, data.selfLearning, audience) },
    }));
    return <DataTable caption={t("knowledge.loading")} columns={knowledgeColumns(t, true)} state={state} />;
  }
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <StateLines lines={knowledgeStateLines(view, audience, { t, format })} />
      <KnowledgeList view={view} recordId={recordId} reload={graph.reload} />
    </div>
  );
}

/** KN-01 «Состояние»: lines without a frame; the first reads as UI text, the rest as captions. */
function StateLines({ lines }: { lines: readonly KnowledgeStateLine[] }) {
  if (lines.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      {lines.map((line, index) => (
        <StateLine key={line.key} first={index === 0} line={line} />
      ))}
    </div>
  );
}

function StateLine({ line, first }: { line: KnowledgeStateLine; first: boolean }) {
  const icon = (Icon: typeof Info, className: string): ReactNode => (
    <Icon aria-hidden className={cn("mt-0.5 size-3.5 shrink-0", className)} />
  );
  return (
    <p
      className={cn(
        "flex items-start gap-1",
        first ? "text-sm leading-5 text-foreground" : "text-xs leading-4 text-muted-foreground",
      )}
    >
      {line.icon === "info" && icon(Info, "text-info")}
      <span className="min-w-0">
        {line.text}
        {line.reason !== null && (
          <>
            {" "}
            <span className="inline-flex items-start gap-1">
              {icon(CircleMinus, "text-muted-foreground")}
              {line.reason}
            </span>
          </>
        )}
      </span>
    </p>
  );
}
