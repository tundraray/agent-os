"use client";

import { useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { toast } from "sonner";
import type { KnowledgeItem, KnowledgeView } from "@agent-os/contracts";
import { ConfirmDialog } from "@/components/admin/confirm-dialog";
import { DataTable, type DataTableColumn, type DataTableRow } from "@/components/admin/data-table";
import { StateBadge } from "@/components/state-badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { describeApiError, isApiRequestError } from "@/lib/api/api-request";
import type { LibraryTranslator } from "@/i18n/catalog";
import { deleteFailed } from "@/lib/library/library-errors";
import { libraryApi } from "@/lib/library/library-api";
import { logger } from "@/lib/logger";
import {
  knowledgeDeleteDialog,
  knowledgeDeletedNotice,
  knowledgeRow,
  knowledgeTabs,
  type KnowledgeCell,
  type KnowledgeMark,
  type KnowledgeRow,
  type KnowledgeTabId,
} from "@/lib/library/knowledge-view";

/** UXRD KN-01, MC-4: «Вид» stands only on «Все». */
export function knowledgeColumns(t: LibraryTranslator, withKind: boolean): readonly DataTableColumn[] {
  return [
    { header: t("knowledge.columns.record") },
    ...(withKind ? [{ header: t("knowledge.columns.kind") }] : []),
    { header: t("knowledge.columns.confirmations"), align: "end" as const },
    { header: t("knowledge.columns.date") },
  ];
}

/** The «Запись» cell (MC-4): `server.tool` in Mono before the title; the detail and the mark on the second line. */
function RecordCell({ cell, mark }: { cell: KnowledgeCell; mark: KnowledgeMark | null }) {
  const first = cell.tool === null ? cell.title : `${cell.tool} · ${cell.title}`;
  return (
    <span className="flex min-w-0 flex-col py-1.5">
      <span className="truncate" title={first}>
        {cell.tool !== null && (
          <>
            <span className="font-mono text-mono-compact">{cell.tool}</span>
            {" · "}
          </>
        )}
        {cell.title}
      </span>
      {(cell.detail !== null || mark !== null) && (
        <span className="flex min-w-0 items-center gap-2 text-xs leading-4 text-muted-foreground">
          {cell.detail !== null && (
            <span className="truncate" title={cell.detail}>
              {cell.detail}
            </span>
          )}
          {mark !== null && <StateBadge state={mark.state}>{mark.text}</StateBadge>}
        </span>
      )}
    </span>
  );
}

/**
 * One table row of a record. Texts are React text nodes only: a record holds what runs saw, never markup
 * (Security Considerations). No run and no employee are shown — the contract has neither.
 */
function toRow(row: KnowledgeRow, withKind: boolean, action: { label: string; onSelect: () => void }): DataTableRow {
  return {
    key: row.key,
    name: row.name,
    cells: [
      <RecordCell key="record" cell={row.cell} mark={row.mark} />,
      ...(withKind ? [<StateBadge key="kind" variant="source">{row.kind}</StateBadge>] : []),
      row.confirmations,
      row.date,
    ],
    actions: [action],
  };
}

const DELETE_EVENT = "library: knowledge delete";

/**
 * KD-5: exactly one `DELETE` to the route of the record's `type` (an `id` is unique only within its `type`). A
 * record someone already deleted answers 204 too. Logged with numbers only — a record's text never reaches the
 * log (Security Considerations). A refusal is thrown on: the dialog keeps it.
 */
async function deleteItem(recordId: string, item: KnowledgeItem): Promise<void> {
  const where = { recordId, type: item.type, id: item.id };
  const started = performance.now();
  const durationMs = () => Math.round(performance.now() - started);
  try {
    await (item.type === "entity"
      ? libraryApi.deleteKnowledgeEntity(recordId, item.id)
      : libraryApi.deleteKnowledgeRelation(recordId, item.id));
    logger.info(DELETE_EVENT, { ...where, outcome: "ok", durationMs: durationMs() });
  } catch (error) {
    const fields = { ...where, outcome: "refused", durationMs: durationMs() };
    if (isApiRequestError(error)) logger.warn(`${DELETE_EVENT}: refused`, { ...fields, ...describeApiError(error) });
    else logger.error(`${DELETE_EVENT}: failed`, { ...fields, error });
    throw error;
  }
}

/** The record being deleted and its dialog's texts, fixed when the dialog opens (the notice's count included). */
type Deleting = { item: KnowledgeItem } & ReturnType<typeof knowledgeDeleteDialog>;

export type KnowledgeListProps = {
  view: KnowledgeView;
  /** The deep agent whose knowledge this is. */
  recordId: string;
  /** Re-reads the graph: after a delete the server's new answer takes the row away (DC-3). */
  reload: () => void;
};

/**
 * UXRD KN-01 «Список»: tabs with their counts and the records of the active one in the server's order. The tab is
 * local state (KD-2); the table is keyed by it, so another tab's rows never «leave» with an animation. A tab
 * that disappears after a read (the fifth) falls back to «Все». KN-02: «Удалить» in a row's menu confirms the
 * delete; nothing is removed locally — the re-read graph decides what stays.
 */
export function KnowledgeList({ view, recordId, reload }: KnowledgeListProps) {
  const format = useFormatter();
  const t = useTranslations("library");
  const tErrors = useTranslations("errors");
  const tabs = knowledgeTabs(t, view);
  const [chosen, setChosen] = useState<KnowledgeTabId>("all");
  // Kept while the dialog closes, so its content does not change during the exit animation.
  const [deleting, setDeleting] = useState<Deleting | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const active = tabs.find((tab) => tab.id === chosen) ?? tabs[0];
  if (active === undefined) return null;
  const withKind = active.id === "all";

  const openDelete = (item: KnowledgeItem): void => {
    setDeleting({ item, ...knowledgeDeleteDialog(t, item, view.items) });
    setDialogOpen(true);
  };

  async function confirmDelete(target: Deleting): Promise<void> {
    await deleteItem(recordId, target.item);
    toast.success(knowledgeDeletedNotice(t, target.relations));
    reload();
  }

  return (
    <Tabs
      value={active.id}
      onValueChange={(value: unknown) => {
        const next = tabs.find((tab) => tab.id === value);
        if (next !== undefined) setChosen(next.id);
      }}
      className="min-w-0 gap-3"
    >
      {/* On a narrow screen the strip scrolls sideways inside itself, never the page. */}
      <div className="max-w-full overflow-x-auto">
        <TabsList className="w-max">
          {tabs.map((tab) => (
            <TabsTrigger key={tab.id} value={tab.id} className="flex-none pointer-coarse:h-11">
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
      <TabsContent value={active.id} className="min-w-0">
        <DataTable
          key={active.id}
          caption={active.label}
          columns={knowledgeColumns(t, withKind)}
          state={{
            status: "ready",
            rows: active.items.map((item) =>
              toRow(knowledgeRow(item, view.selfLearning, { t, format }), withKind, {
                label: t("knowledge.delete"),
                onSelect: () => openDelete(item),
              }),
            ),
            noMatches: active.noMatches ?? undefined,
          }}
          actionsAs="menu"
        />
      </TabsContent>
      {deleting !== null && (
        <ConfirmDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          title={deleting.title}
          body={deleting.body}
          confirmLabel={t("knowledge.delete")}
          onConfirm={() => confirmDelete(deleting)}
          // `deleteItem` has logged the refusal. Without `focusTitleAfterConfirm`: focus returns to the row's menu,
          // and `DataTable` moves it on when the re-read takes the row away (next row, previous, else the `h1`).
          refusalText={(cause) => deleteFailed(tErrors, cause)}
        />
      )}
    </Tabs>
  );
}
