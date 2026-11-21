"use client";

import { useId, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { LoaderCircle, Lock, MoreHorizontalIcon, Users } from "lucide-react";
import { BUILTIN_ROLE_KEY, CHAT_BUILTIN_KEY, type RecordAudience, type RecordDetail } from "@agent-os/contracts";
import { CAPTION, CONTROL_SIZE } from "@/components/admin/admin-form";
import { ShellLink } from "@/components/shell/shell-link";
import { Button, buttonVariants } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useResource } from "@/hooks/use-resource";
import { builtinName } from "@/lib/i18n/builtin-name";
import type { LibraryTranslator } from "@/lib/i18n/messages";
import type { Locale } from "@/lib/i18n/pick-locale";
import { libraryApi } from "@/lib/library/library-api";
import { shareBlockedReason } from "@/lib/library/library-errors";
import { canUseInChat } from "@/lib/library/record-rules";
import { adminKnowledgePath } from "@/lib/shell-route";
import { cn } from "cn";
import type { EditorMode } from "./agent-fields";
import { DeleteRecordDialog } from "./delete-record-dialog";
import { ShareDialog } from "./share-dialog";
import { useInChat } from "./use-in-chat";

/**
 * UXRD MC-7: who sees the record, for the audience button. `onlyAdmins` is not in MC-7: a company record nobody
 * holds; the words are MC-14's «Пока видят только администраторы».
 */
function audienceText(t: LibraryTranslator, audience: RecordAudience, mode: EditorMode, locale: Locale): string {
  if (audience.everyone === true) return t("editor.header.everyone");
  const users = audience.users ?? [];
  if (mode === "system") {
    if (users.length > 0) return t("editor.header.chosen");
    if (audience.roles.length === 0) return t("editor.header.onlyAdmins");
  }
  if (audience.roles.length === 0) return t("label.onlyYou");
  return audience.roles.map((role) => builtinName({ builtinKey: BUILTIN_ROLE_KEY, name: role.name }, locale)).join(", ");
}

export type EditorHeaderActionsProps = {
  mode: EditorMode;
  /** The record as saved, with the audience of the last share. */
  record: RecordDetail;
  /** The form holds unsaved changes: «Использовать в чате» and «Доработать в чате» wait for a save. */
  changed: boolean;
  copyPending: boolean;
  /** Describes the menu trigger while the last copy's error shows. */
  copyErrorId: string | undefined;
  onCopy: () => void;
  onShared: (record: RecordDetail) => void;
  /** The share dialog is open; the editor owns it, so its MC-18 notice can open it too. */
  sharing: boolean;
  onSharingChange: (open: boolean) => void;
};

/**
 * The right end of the editor's header (record-editor.md, parts 1–2; UXRD ED-01, AL-02): the audience button and
 * the menu «⋯». Each changing control exists only by its flag (Invariant 3). Sharing is unavailable under a
 * ban or without roles, and then the dialog does not open (DC-5). In mode `system` the dialog is the
 * administrator's, `chat` has the MC-14 line instead of the button, and the menu holds only «Удалить», never on
 * a built-in record.
 */
export function EditorHeaderActions({
  mode,
  record,
  changed,
  copyPending,
  copyErrorId,
  onCopy,
  onShared,
  sharing,
  onSharingChange: setSharing,
}: EditorHeaderActionsProps) {
  const t = useTranslations("library");
  const [deleting, setDeleting] = useState(false);
  const system = mode === "system";
  const canDelete = record.canDelete && !(system && record.builtinKey !== null);

  return (
    <>
      {/* The employee's editor has its entry under the «Самообучение» flag instead. */}
      {system && <KnowledgeButton record={record} />}
      {system && record.builtinKey === CHAT_BUILTIN_KEY ? (
        <p className={cn(CAPTION, "min-w-0 truncate text-muted-foreground")} title={t("editor.header.chatAudience")}>
          {t("editor.header.chatAudience")}
        </p>
      ) : (
        <>
          {system
            ? record.canShare && (
                <AudienceButton record={record} mode={mode} blocked={null} onOpen={() => setSharing(true)} />
              )
            : // Under a ban the server says `canShare: false`, yet the owner sees the button with the reason (MC-14).
              record.mine &&
              (record.canShare || record.ban !== null) && (
                <EmployeeAudienceButton record={record} onOpen={() => setSharing(true)} />
              )}
          {record.canShare && (
            <ShareDialog
              variant={system ? "admin" : "employee"}
              record={record}
              open={sharing}
              onOpenChange={setSharing}
              onSaved={onShared}
            />
          )}
        </>
      )}
      {system ? (
        canDelete && <SystemMenu record={record} onDelete={() => setDeleting(true)} />
      ) : (
        <EditorMenu
          record={record}
          changed={changed}
          copyPending={copyPending}
          copyErrorId={copyErrorId}
          onCopy={onCopy}
          onDelete={() => setDeleting(true)}
        />
      )}
      {canDelete && (
        <DeleteRecordDialog
          record={record}
          open={deleting}
          onOpenChange={setDeleting}
          leaveToLibrary
          variant={system ? "admin" : "employee"}
        />
      )}
    </>
  );
}

/**
 * UXRD MC-7: the panel's entry to the knowledge screen of a workflow (AL-02, AL-03), whatever its «Самообучение»
 * flag; an agent has none. A link styled as a button, so `ShellLink` asks MC-11 over unsaved changes.
 */
export function KnowledgeButton({ record }: { record: Pick<RecordDetail, "id" | "kind"> }) {
  const t = useTranslations("library");
  if (record.kind !== "workflow") return null;
  return (
    <ShellLink
      href={adminKnowledgePath(record.id)}
      className={buttonVariants({ variant: "outline", size: "sm", className: CONTROL_SIZE })}
    >
      {t("knowledge.entry")}
    </ShellLink>
  );
}

/** The owner's button: unavailable under a ban or without roles (DC-5). */
function EmployeeAudienceButton({ record, onOpen }: { record: RecordDetail; onOpen: () => void }) {
  const roles = useResource(libraryApi.myRoles, record.id, "library");
  const noRoles = roles.status === "ready" && roles.data?.length === 0;
  const t = useTranslations("errors");
  const blocked = shareBlockedReason(t, record, noRoles);
  return <AudienceButton record={record} mode="employee" blocked={blocked} onOpen={onOpen} />;
}

type AudienceButtonProps = {
  record: RecordDetail;
  mode: EditorMode;
  /** Why sharing is unavailable; `null` — the button opens the dialog. */
  blocked: string | null;
  onOpen: () => void;
};

/** «Кто видит: …»: `aria-disabled` with the reason as its description when sharing is unavailable. */
function AudienceButton({ record, mode, blocked, onOpen }: AudienceButtonProps) {
  const t = useTranslations("library");
  const locale = useLocale();
  const reasonId = useId();
  const holders = record.audience.roles.length + (record.audience.users?.length ?? 0);
  const Icon = record.audience.everyone !== true && holders === 0 ? Lock : Users;
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      aria-disabled={blocked !== null}
      aria-describedby={blocked === null ? undefined : reasonId}
      title={blocked ?? undefined}
      className="max-w-60 min-w-0 pointer-coarse:h-11 aria-disabled:opacity-50"
      onClick={() => {
        if (blocked === null) onOpen();
      }}
    >
      <Icon aria-hidden />
      <span className="truncate">{t("editor.header.audience", { who: audienceText(t, record.audience, mode, locale) })}</span>
      {blocked !== null && (
        <span id={reasonId} className="sr-only">
          {blocked}
        </span>
      )}
    </Button>
  );
}

function MenuTrigger({ record, describedBy, pending }: { record: RecordDetail; describedBy?: string; pending?: boolean }) {
  const t = useTranslations("library");
  const locale = useLocale();
  return (
    <DropdownMenuTrigger
      render={
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("row.actions", { name: builtinName(record, locale) })}
          aria-describedby={describedBy}
          disabled={pending}
          className="shrink-0 pointer-coarse:size-11"
        />
      }
    >
      {pending ? <LoaderCircle aria-hidden className="animate-spin motion-reduce:animate-none" /> : <MoreHorizontalIcon aria-hidden />}
    </DropdownMenuTrigger>
  );
}

/** The administrator's menu of a company record: only «Удалить» (the chat neither creates nor refines them). */
function SystemMenu({ record, onDelete }: { record: RecordDetail; onDelete: () => void }) {
  const t = useTranslations("library");
  return (
    <DropdownMenu>
      <MenuTrigger record={record} />
      <DropdownMenuContent align="end" className="w-auto min-w-45">
        <DropdownMenuItem variant="destructive" onClick={onDelete}>
          {t("row.delete")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type EditorMenuProps = {
  record: RecordDetail;
  changed: boolean;
  copyPending: boolean;
  copyErrorId: string | undefined;
  onCopy: () => void;
  onDelete: () => void;
};

function EditorMenu({ record, changed, copyPending, copyErrorId, onCopy, onDelete }: EditorMenuProps) {
  const t = useTranslations("library");
  const locale = useLocale();
  const inChat = useInChat();
  const reasonId = useId();
  // «Доработать в чате» only on a record its author alone sees (UXRD ED-01).
  const alone = record.audience.everyone !== true && record.audience.roles.length === 0;
  const waitReason = changed ? t("editor.header.saveFirst") : null;
  const waiting = {
    disabled: changed,
    title: waitReason ?? undefined,
    "aria-describedby": changed ? reasonId : undefined,
  };
  return (
    <DropdownMenu>
      <MenuTrigger record={record} describedBy={copyErrorId} pending={copyPending} />
      <DropdownMenuContent align="end" className="w-auto min-w-45">
        {waitReason !== null && (
          <span id={reasonId} className="sr-only">
            {waitReason}
          </span>
        )}
        {canUseInChat(record) && (
          <DropdownMenuItem {...waiting} onClick={() => inChat({ record: { id: record.id, kind: record.kind, name: record.name } })}>
            {t("row.useInChat")}
          </DropdownMenuItem>
        )}
        {alone && (
          <DropdownMenuItem
            {...waiting}
            onClick={() => inChat({ text: t("editor.header.refineTemplate", { name: builtinName(record, locale) }) })}
          >
            {t("editor.header.refine")}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onClick={onCopy}>{t("row.copy")}</DropdownMenuItem>
        {record.canDelete && (
          <DropdownMenuItem variant="destructive" onClick={onDelete}>
            {t("row.delete")}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
