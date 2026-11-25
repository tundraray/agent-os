'use client';

import { useId, useState, type MouseEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import {
  BookOpen,
  CircleMinus,
  LoaderCircle,
  MoreHorizontalIcon,
  ShieldOff,
  type LucideIcon,
} from 'lucide-react';
import type { RecordKind, RecordSummary } from '@agent-os/contracts';
import { Button } from '@/components/ui/button';
import { useAdminRight } from '@/components/admin/admin-gate';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { formatModel } from '@/lib/agents/format';
import { builtinName } from '@/i18n/builtin-name';
import { formatDay, type Formatter } from '@/i18n/formats';
import type { LibraryTranslator } from '@/i18n/catalog';
import { shareBlockedReason } from '@/lib/library/library-errors';
import { canUseInChat } from '@/lib/library/record-rules';
import { adminRecordPath, recordPath } from '@/lib/shell-route';
import { useCopyRecord } from './copy-record';
import { DeleteRecordDialog } from './delete-record-dialog';
import { RECORD_KIND_ICON, RecordLabel } from './record-label';
import { ShareDialog } from './share-dialog';
import { useInChat } from './use-in-chat';

/** Systems a note names before «и ещё {N}» (library-row.md, Content Rules). */
const NAMED_SYSTEMS = 3;

/** «Доступ закрыл администратор · {дата} — делиться нельзя» (MC-2, MC-9). */
export const banText = (
  t: LibraryTranslator,
  format: Formatter,
  closedAt: string,
): string => t('ban', { date: formatDay(format, closedAt) });

/** The unavailable systems, the first `NAMED_SYSTEMS` by name and «и ещё {N}» for the rest. */
function systemsText(
  t: LibraryTranslator,
  servers: readonly string[],
  kind: RecordKind,
): string {
  const names = servers.slice(0, NAMED_SYSTEMS).join(', ');
  const rest = Math.max(servers.length - NAMED_SYSTEMS, 0);
  return t('row.systems', { count: servers.length, names, rest, kind });
}

type RowNote = { icon: LucideIcon; text: string };

/** The row's notes (library-row.md, States): what will happen when the viewer runs the record. */
function rowNotes(
  t: LibraryTranslator,
  record: RecordSummary,
  format: Formatter,
): RowNote[] {
  const notes: RowNote[] = [];
  // The record's and its subagents' systems together: the viewer's run works without each of them.
  const servers = [
    ...new Set(record.missingRights.flatMap((right) => right.servers)),
  ];
  if (servers.length > 0)
    notes.push({
      icon: CircleMinus,
      text: systemsText(t, servers, record.kind),
    });
  const model = record.missingRights.find(
    (right) => right.subagent === null && right.model !== null,
  )?.model;
  if (model != null) {
    notes.push({
      icon: CircleMinus,
      text: t('row.modelUnavailable', {
        model: formatModel(model),
        kind: record.kind,
      }),
    });
  }
  if (!record.mine && record.author !== null && !record.offerInChat)
    notes.push({ icon: BookOpen, text: t('row.readOnly') });
  if (record.ban !== null)
    notes.push({
      icon: ShieldOff,
      text: banText(t, format, record.ban.closedAt),
    });
  return notes;
}

export type LibraryRowProps = {
  record: RecordSummary;
  /** `false` in «Мои»: the source is plain from the group. */
  showSource: boolean;
  /** The viewer has no roles: «Поделиться» is unavailable with the reason of MC-14. */
  noRoles: boolean;
};

/**
 * One record of the library (library-row.md): kind icon, record label, kind and description, the notes of
 * MC-2 and the menu. «Использовать в чате» follows the web's rule and is absent where the rule says no;
 * «Поделиться» and «Удалить» exist only on the viewer's own record and by its flags (Invariant 3). Text
 * written by other employees is rendered as text only.
 */
export function LibraryRow({ record, showSource, noRoles }: LibraryRowProps) {
  const router = useRouter();
  const inChat = useInChat();
  const copy = useCopyRecord();
  const [sharing, setSharing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const errorId = useId();
  const KindIcon = RECORD_KIND_ICON[record.kind];
  const format = useFormatter();
  const t = useTranslations('library');
  const locale = useLocale();
  const name = builtinName(record, locale);
  const notes = rowNotes(t, record, format);

  // The background of the row opens the page for a mouse or a touch; the keyboard has the name's link.
  // Menus and dialogs are portalled: their clicks reach this handler through React but not the row's DOM.
  const openFromRow = (event: MouseEvent<HTMLLIElement>): void => {
    const target = event.target;
    if (!(target instanceof Element) || !event.currentTarget.contains(target))
      return;
    if (target.closest('a, button') !== null) return;
    router.push(recordPath(record.id));
  };

  return (
    <li
      onClick={openFromRow}
      className="hover:bg-accent border-border flex cursor-pointer items-start gap-2 border-b px-4 py-3 last:border-b-0"
    >
      <KindIcon
        aria-hidden
        className="text-muted-foreground mt-0.5 size-4 shrink-0"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <RecordLabel
          variant="row"
          summary={record}
          href={recordPath(record.id)}
          showSource={showSource}
        />
        <p className="line-clamp-2 text-sm leading-5">
          <span className="text-muted-foreground text-xs leading-4">
            {t('kind', { kind: record.kind })}
          </span>
          <span className="text-muted-foreground"> · </span>
          <span className="text-foreground">{record.description}</span>
        </p>
        {notes.length > 0 && (
          <ul className="flex flex-col gap-0.5">
            {notes.map(({ icon: Icon, text }) => (
              <li
                key={text}
                className="text-muted-foreground flex items-start gap-1.5 text-xs leading-4"
              >
                <Icon aria-hidden className="mt-px size-3.5 shrink-0" />
                <span>{text}</span>
              </li>
            ))}
          </ul>
        )}
        {copy.error !== null && (
          <p
            id={errorId}
            role="alert"
            className="text-destructive text-xs leading-4"
          >
            {copy.error}
          </p>
        )}
      </div>
      <RowMenu
        record={record}
        name={name}
        noRoles={noRoles}
        pending={copy.pending}
        describedBy={copy.error === null ? undefined : errorId}
        onUseInChat={() =>
          inChat({ record: { id: record.id, kind: record.kind, name } })
        }
        onRefine={() =>
          inChat({ text: t('editor.header.refineTemplate', { name }) })
        }
        onOpen={() => router.push(recordPath(record.id))}
        onOpenInPanel={() => router.push(adminRecordPath('library', record.id))}
        onShare={() => setSharing(true)}
        onCopy={() => copy.copy(record)}
        onDelete={() => setDeleting(true)}
      />
      {copy.dialog}
      {record.mine && record.canShare && (
        <ShareDialog
          variant="employee"
          record={record}
          open={sharing}
          onOpenChange={setSharing}
          onSaved={() => {}}
        />
      )}
      {record.mine && record.canDelete && (
        <DeleteRecordDialog
          record={record}
          open={deleting}
          onOpenChange={setDeleting}
        />
      )}
    </li>
  );
}

type RowMenuProps = {
  record: RecordSummary;
  /** The record's name as the page shows it. */
  name: string;
  noRoles: boolean;
  pending: boolean;
  describedBy: string | undefined;
  onUseInChat: () => void;
  /** «Доработать в чате» of one's own deep agent (deep-agents UXRD DA-01, MC-26). */
  onRefine: () => void;
  onOpen: () => void;
  onShare: () => void;
  onCopy: () => void;
  onDelete: () => void;
  onOpenInPanel: () => void;
};

function RowMenu({
  record,
  name,
  noRoles,
  pending,
  describedBy,
  ...on
}: RowMenuProps) {
  const t = useTranslations('library');
  const tErrors = useTranslations('errors');
  const shareReasonId = useId();
  const refineReasonId = useId();
  const shareBlocked = shareBlockedReason(tErrors, record, noRoles);
  // The chat changes only what its author alone sees; the agent's own item is in its editor (library-row.md).
  const refinable = record.mine && record.kind === 'deep_agent';
  const alone =
    record.audience.everyone !== true && record.audience.roles.length === 0;
  // A company record changes only in the panel: an administrator gets the way there (library-row.md).
  const inPanel = useAdminRight() === 'admin' && record.author === null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('row.actions', { name })}
            aria-describedby={describedBy}
            disabled={pending}
            className="shrink-0 pointer-coarse:size-11"
          />
        }
      >
        {pending ? (
          <LoaderCircle
            aria-hidden
            className="animate-spin motion-reduce:animate-none"
          />
        ) : (
          <MoreHorizontalIcon aria-hidden />
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-auto min-w-45">
        {canUseInChat(record) && (
          <DropdownMenuItem onClick={on.onUseInChat}>
            {t('row.useInChat')}
          </DropdownMenuItem>
        )}
        {refinable && (
          <DropdownMenuItem
            disabled={!alone}
            title={alone ? undefined : t('card.refineUnavailable')}
            aria-describedby={alone ? undefined : refineReasonId}
            onClick={on.onRefine}
          >
            {t('editor.header.refine')}
            {!alone && (
              <span id={refineReasonId} className="sr-only">
                {t('card.refineUnavailable')}
              </span>
            )}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onClick={on.onOpen}>{t('open')}</DropdownMenuItem>
        {/* Under a ban the server says `canShare: false`, yet the owner sees the item with the reason (MC-14). */}
        {record.mine && (record.canShare || record.ban !== null) && (
          <DropdownMenuItem
            disabled={shareBlocked !== null}
            title={shareBlocked ?? undefined}
            aria-describedby={shareBlocked === null ? undefined : shareReasonId}
            onClick={on.onShare}
          >
            {t('row.share')}
            {shareBlocked !== null && (
              <span id={shareReasonId} className="sr-only">
                {shareBlocked}
              </span>
            )}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onClick={on.onCopy}>{t('row.copy')}</DropdownMenuItem>
        {record.mine && record.canDelete && (
          <DropdownMenuItem variant="destructive" onClick={on.onDelete}>
            {t('row.delete')}
          </DropdownMenuItem>
        )}
        {inPanel && (
          <DropdownMenuItem onClick={on.onOpenInPanel}>
            {t('row.openInPanel')}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
