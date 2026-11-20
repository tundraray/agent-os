"use client";

import { useId, useState } from "react";
import { LoaderCircle, Lock, MoreHorizontalIcon, Users } from "lucide-react";
import { CHAT_BUILTIN_KEY, type RecordAudience, type RecordDetail } from "@agent-os/contracts";
import { CAPTION } from "@/components/admin/admin-form";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useResource } from "@/hooks/use-resource";
import { libraryApi } from "@/lib/library/library-api";
import { shareBlockedReason } from "@/lib/library/library-errors";
import { canUseInChat } from "@/lib/library/record-rules";
import { cn } from "cn";
import type { EditorMode } from "./agent-fields";
import { DeleteRecordDialog } from "./delete-record-dialog";
import { ShareDialog } from "./share-dialog";
import { useInChat } from "./use-in-chat";

/** UXRD MC-7 (audience button and menu) and MC-14 (`chat`). */
const TEXT = {
  audience: (who: string) => `Кто видит: ${who}`,
  onlyYou: "только вы",
  everyone: "все сотрудники",
  chosen: "выбранные",
  // Not in MC-7: a company record nobody holds; the words are MC-14's «Пока видят только администраторы».
  onlyAdmins: "только администраторы",
  chatAudience: "Видят все, у кого есть права. Это изменить нельзя.",
  actions: (name: string) => `Действия: ${name}`,
  useInChat: "Использовать в чате",
  refine: "Доработать в чате",
  refineTemplate: (name: string) => `Доработай «${name}»: `,
  saveFirst: "Сначала сохраните изменения",
  copy: "Скопировать себе",
  delete: "Удалить",
} as const;

function audienceText(audience: RecordAudience, mode: EditorMode): string {
  if (audience.everyone === true) return TEXT.everyone;
  const users = audience.users ?? [];
  if (mode === "system") {
    if (users.length > 0) return TEXT.chosen;
    if (audience.roles.length === 0) return TEXT.onlyAdmins;
  }
  if (audience.roles.length === 0) return TEXT.onlyYou;
  return audience.roles.map((role) => role.name).join(", ");
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
  const [deleting, setDeleting] = useState(false);
  const system = mode === "system";
  const canDelete = record.canDelete && !(system && record.builtinKey !== null);

  return (
    <>
      {system && record.builtinKey === CHAT_BUILTIN_KEY ? (
        <p className={cn(CAPTION, "min-w-0 truncate text-muted-foreground")} title={TEXT.chatAudience}>
          {TEXT.chatAudience}
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

/** The owner's button: unavailable under a ban or without roles (DC-5). */
function EmployeeAudienceButton({ record, onOpen }: { record: RecordDetail; onOpen: () => void }) {
  const roles = useResource(libraryApi.myRoles, record.id, "library");
  const noRoles = roles.status === "ready" && roles.data?.length === 0;
  const blocked = shareBlockedReason(record, noRoles);
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
      <span className="truncate">{TEXT.audience(audienceText(record.audience, mode))}</span>
      {blocked !== null && (
        <span id={reasonId} className="sr-only">
          {blocked}
        </span>
      )}
    </Button>
  );
}

function MenuTrigger({ name, describedBy, pending }: { name: string; describedBy?: string; pending?: boolean }) {
  return (
    <DropdownMenuTrigger
      render={
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={TEXT.actions(name)}
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
  return (
    <DropdownMenu>
      <MenuTrigger name={record.name} />
      <DropdownMenuContent align="end" className="w-auto min-w-45">
        <DropdownMenuItem variant="destructive" onClick={onDelete}>
          {TEXT.delete}
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
  const inChat = useInChat();
  const reasonId = useId();
  // «Доработать в чате» only on a record its author alone sees (UXRD ED-01).
  const alone = record.audience.everyone !== true && record.audience.roles.length === 0;
  const waitReason = changed ? TEXT.saveFirst : null;
  const waiting = {
    disabled: changed,
    title: waitReason ?? undefined,
    "aria-describedby": changed ? reasonId : undefined,
  };
  return (
    <DropdownMenu>
      <MenuTrigger name={record.name} describedBy={copyErrorId} pending={copyPending} />
      <DropdownMenuContent align="end" className="w-auto min-w-45">
        {waitReason !== null && (
          <span id={reasonId} className="sr-only">
            {waitReason}
          </span>
        )}
        {canUseInChat(record) && (
          <DropdownMenuItem {...waiting} onClick={() => inChat({ record: { id: record.id, kind: record.kind, name: record.name } })}>
            {TEXT.useInChat}
          </DropdownMenuItem>
        )}
        {alone && (
          <DropdownMenuItem {...waiting} onClick={() => inChat({ text: TEXT.refineTemplate(record.name) })}>
            {TEXT.refine}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onClick={onCopy}>{TEXT.copy}</DropdownMenuItem>
        {record.canDelete && (
          <DropdownMenuItem variant="destructive" onClick={onDelete}>
            {TEXT.delete}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
