'use client';

import { useEffect, useRef, useState, type MouseEvent } from 'react';
import Link from 'next/link';
import { MoreHorizontalIcon, PencilIcon, Trash2Icon } from 'lucide-react';
import { ShimmerLabel } from '@/components/surfaces';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SidebarMenuAction, SidebarMenuButton, SidebarMenuItem, useSidebar } from '@/components/ui/sidebar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { focusShellTarget, isFinePointer } from '@/lib/focus';
import type { ThreadListEntry } from '@/lib/threads/group-threads-by-date';
import { threadPath } from '@/lib/threads/route-thread-id';
import { cn } from '@/lib/utils';
import { ThreadTitleField } from './thread-title-field';

/** Marks a thread link: ↑/↓/Home/End of the list move focus between these elements. */
export const THREAD_LINK_ATTRIBUTE = 'data-thread-link';

/** Holds the thread id on a row (`li`): the list finds a row's link and «⋯» by it. */
export const THREAD_ROW_ATTRIBUTE = 'data-thread-row';

/** Marks the SB-07 «⋯» button of a row. */
export const THREAD_ACTIONS_ATTRIBUTE = 'data-thread-actions';

/** Placeholder for a thread without a title (D-06). */
export const UNTITLED_THREAD_TITLE = 'Новая беседа';

/** Hover time before the full-title tooltip opens (UXRD 6.5 Truncated). */
const TOOLTIP_DELAY_MS = 500;

export type ThreadHistoryItemProps = {
  entry: ThreadListEntry;
  /** The thread open in the main area: background, weight and `aria-current="page"`. */
  isActive: boolean;
  /** The title is still awaited (reply running or title poll pending): «Новая беседа» shimmers. */
  titlePending: boolean;
  /** A trimmed, non-empty, changed title from SB-08; failures are reported and rolled back by the list adapter. */
  onRename: (title: string) => void;
  /** «Удалить» in the «⋯» menu: the list opens DLG-01 for this thread. */
  onRequestDelete: () => void;
};

/**
 * SB-06: one row of the thread list, a link to `/chat/<id>`. A title cut by the row width
 * opens a tooltip with the full title (AC-01.6). SB-07 «⋯» opens the row menu; «Переименовать» swaps the
 * title for the SB-08 field at once, and focus returns to the link once the field closes (UXRD 7.4);
 * «Удалить» asks the list for DLG-01.
 */
export function ThreadHistoryItem({ entry, isActive, titlePending, onRename, onRequestDelete }: ThreadHistoryItemProps) {
  const { isMobile, setOpenMobile } = useSidebar();
  const rowRef = useRef<HTMLLIElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const focusLinkAfterEdit = useRef(false);
  const label = entry.title ?? UNTITLED_THREAD_TITLE;
  const linkProps = { [THREAD_LINK_ATTRIBUTE]: '' };
  const rowProps = { [THREAD_ROW_ATTRIBUTE]: entry.id };
  const actionsProps = { [THREAD_ACTIONS_ATTRIBUTE]: '' };

  useEffect(() => {
    if (editing || !focusLinkAfterEdit.current) return;
    focusLinkAfterEdit.current = false;
    rowRef.current?.querySelector<HTMLElement>(`[${THREAD_LINK_ATTRIBUTE}]`)?.focus();
  }, [editing]);

  const closeField = (): void => {
    focusLinkAfterEdit.current = true;
    setEditing(false);
  };

  const isTruncated = (): boolean => {
    const element = labelRef.current;
    return element !== null && element.scrollWidth > element.clientWidth;
  };

  // UXRD 7.4: a click with a fine pointer focuses the composer; a tap or a pick from the drawer focuses HD-03;
  // Enter on the link (`detail === 0`) leaves focus on the link.
  const onLinkClick = (event: MouseEvent<HTMLAnchorElement>): void => {
    if (isMobile) {
      setOpenMobile(false);
      focusShellTarget('page-title');
      return;
    }
    if (event.detail === 0) return;
    focusShellTarget(isFinePointer() ? 'composer' : 'page-title');
  };

  // A thread promoted at the first send has no server id for a few hundred milliseconds: the row shows without a link.
  const target =
    entry.remoteId === undefined ? (
      <div aria-current={isActive ? 'page' : undefined} />
    ) : (
      <Link
        {...linkProps}
        href={threadPath(entry.remoteId)}
        aria-current={isActive ? 'page' : undefined}
        onClick={onLinkClick}
      />
    );

  if (editing) {
    return (
      <SidebarMenuItem ref={rowRef} {...rowProps}>
        <ThreadTitleField
          initialTitle={label}
          onSave={(title) => {
            onRename(title);
            closeField();
          }}
          onCancel={closeField}
        />
      </SidebarMenuItem>
    );
  }

  return (
    <SidebarMenuItem ref={rowRef} {...rowProps}>
      <Tooltip open={tooltipOpen} onOpenChange={(open) => setTooltipOpen(open && isTruncated())}>
        <SidebarMenuButton
          isActive={isActive}
          className={cn(
            'pointer-coarse:h-11',
            isMobile ? 'h-11' : 'h-9',
            // Selected-thread marker (design system, Color → Accent): the --sidebar-accent background alone is below 3:1.
            'relative data-active:before:absolute data-active:before:inset-y-2 data-active:before:left-0 data-active:before:w-0.75 data-active:before:rounded-full data-active:before:bg-sidebar-primary',
          )}
          render={<TooltipTrigger delay={TOOLTIP_DELAY_MS} render={target} />}
        >
          <ShimmerLabel ref={labelRef} active={entry.title === undefined && titlePending}>
            {label}
          </ShimmerLabel>
        </SidebarMenuButton>
        <TooltipContent side="right" align="center">
          {label}
        </TooltipContent>
      </Tooltip>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <SidebarMenuAction
              {...actionsProps}
              showOnHover
              aria-label={`Действия с беседой «${label}»`}
              aria-haspopup="menu"
              className={cn(
                'top-1/2 peer-data-[size=default]/menu-button:top-1/2 size-6 -translate-y-1/2 data-popup-open:bg-sidebar-accent data-popup-open:opacity-100',
                isActive && 'md:opacity-100',
                'pointer-coarse:opacity-100',
              )}
            />
          }
        >
          <MoreHorizontalIcon aria-hidden />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-auto min-w-45">
          {/* The row swaps to the field at once and takes the menu with it: waiting for the popup's exit
              animation delays the field's focus, and the menu has no focus to return to «⋯». */}
          <DropdownMenuItem onClick={() => setEditing(true)}>
            <PencilIcon aria-hidden />
            Переименовать
          </DropdownMenuItem>
          {/* The dialog opens from the click, like the field above: no wait for the menu's exit animation. */}
          <DropdownMenuItem
            variant="destructive"
            onClick={onRequestDelete}
            className="data-highlighted:bg-destructive data-highlighted:text-destructive-foreground data-highlighted:*:[svg]:text-destructive-foreground"
          >
            <Trash2Icon aria-hidden />
            Удалить
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>
  );
}
