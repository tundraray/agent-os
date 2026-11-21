"use client";

import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { BUILTIN_ROLE_KEY, type RecordSummary } from "@agent-os/contracts";
import { ConfirmDialog } from "@/components/admin/confirm-dialog";
import { useShellServices } from "@/components/shell/shell-actions";
import { adminApi } from "@/lib/admin/admin-api";
import { builtinName } from "@/lib/i18n/builtin-name";
import type { LibraryTranslator } from "@/lib/i18n/messages";
import type { Locale } from "@/lib/i18n/pick-locale";
import { libraryApi } from "@/lib/library/library-api";
import { deleteFailed } from "@/lib/library/library-errors";
import { recordAction } from "@/lib/library/record-action";
import { adminLibraryTabPath, libraryPath } from "@/lib/shell-route";

/** What the dialog reads of a record: a library row and a record page both fit. */
export type DeleteRecord = Pick<RecordSummary, "id" | "kind" | "name" | "author" | "audience">;

/** UXRD MC-5: who loses the record, then that runs already going finish. */
function bodyText(t: LibraryTranslator, locale: Locale, { kind, author, audience }: DeleteRecord): string {
  if (author === null || audience.everyone === true) return t("delete.everyone", { kind });
  if (audience.roles.length === 0) return t("delete.onlyYou", { kind });
  const roles = audience.roles.map((role) => builtinName({ builtinKey: BUILTIN_ROLE_KEY, name: role.name }, locale));
  return t("delete.roles", { kind, roles: roles.join(", ") });
}

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
  const t = useTranslations("errors");
  const tLibrary = useTranslations("library");
  const locale = useLocale();
  const router = useRouter();

  async function remove(): Promise<void> {
    await recordAction({ recordId: record.id, kind: record.kind, action: "delete", version: null }, () =>
      variant === "admin" ? adminApi.library.remove(record.id) : libraryApi.remove(record.id),
    );
    void libraryIndex.refresh();
    toast.success(tLibrary("delete.deleted", { kind: record.kind }));
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
      title={tLibrary("delete.title", { name: record.name })}
      body={bodyText(tLibrary, locale, record)}
      confirmLabel={tLibrary("delete.confirm")}
      onConfirm={remove}
      // `recordAction` has logged the refusal.
      refusalText={(cause) => deleteFailed(t, cause)}
      focusTitleAfterConfirm
    />
  );
}
