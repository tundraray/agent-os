"use client";

import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { RecordSummary } from "@agent-os/contracts";
import { ConfirmDialog } from "@/components/admin/confirm-dialog";
import { useShellServices } from "@/components/shell/shell-actions";
import { adminApi } from "@/lib/admin/admin-api";
import { libraryApi } from "@/lib/library/library-api";
import { deleteFailed, kindWord } from "@/lib/library/library-errors";
import { recordAction } from "@/lib/library/record-action";
import { adminLibraryTabPath, libraryPath } from "@/lib/shell-route";

/** What the dialog reads of a record: a library row and a record page both fit. */
export type DeleteRecord = Pick<RecordSummary, "id" | "kind" | "name" | "author" | "audience">;

const RUNS_FINISH = "Запуски, которые уже идут, доработают.";

/** UXRD MC-5. */
const TEXT = {
  title: (name: string) => `Удалить «${name}»?`,
  body: ({ kind, author, audience }: DeleteRecord): string => {
    const Kind = kindWord(kind, true);
    if (author === null || audience.everyone === true) return `${Kind} пропадёт у всех, кому открыт. ${RUNS_FINISH}`;
    if (audience.roles.length === 0) return `${Kind} удалится насовсем. ${RUNS_FINISH}`;
    const roles = audience.roles.map((role) => role.name).join(", ");
    return `${Kind} пропадёт у вас и у ролей ${roles}. ${RUNS_FINISH}`;
  },
  confirm: "Удалить",
  deleted: (record: DeleteRecord) => `${kindWord(record.kind, true)} удалён`,
} as const;

export type DeleteRecordDialogProps = {
  record: DeleteRecord;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The editor and the record page: after the deletion their unsaved hold is dropped and the shell goes to the library. */
  leaveToLibrary?: boolean;
  /** `admin` — a company record in the panel: the panel's route deletes it, and leaving goes to «Системные». */
  variant?: "employee" | "admin";
  /** After a successful delete: a list not fed by `libraryIndex` re-reads itself. */
  onDeleted?: () => void;
};

/**
 * LB-04: confirms deleting the viewer's own record. One `DELETE` through `recordAction`; then `libraryIndex`
 * is re-read (the row goes), the notice of MC-5 shows, and focus moves to the page title because the control
 * that opened the dialog is gone. A refusal stays in the dialog.
 */
export function DeleteRecordDialog({
  record,
  open,
  onOpenChange,
  leaveToLibrary = false,
  variant = "employee",
  onDeleted,
}: DeleteRecordDialogProps) {
  const { libraryIndex, leaveGuard } = useShellServices();
  const router = useRouter();

  async function remove(): Promise<void> {
    await recordAction({ recordId: record.id, kind: record.kind, action: "delete", version: null }, () =>
      variant === "admin" ? adminApi.library.remove(record.id) : libraryApi.remove(record.id),
    );
    void libraryIndex.refresh();
    toast.success(TEXT.deleted(record));
    onDeleted?.();
    if (leaveToLibrary) {
      leaveGuard.release();
      router.push(variant === "admin" ? adminLibraryTabPath("system") : libraryPath());
    }
  }

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={TEXT.title(record.name)}
      body={TEXT.body(record)}
      confirmLabel={TEXT.confirm}
      onConfirm={remove}
      // `recordAction` has logged the refusal.
      refusalText={deleteFailed}
      focusTitleAfterConfirm
    />
  );
}
