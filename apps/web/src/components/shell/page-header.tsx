'use client';

import { useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronRightIcon } from 'lucide-react';
import { pageTitle, useDocumentTitle } from '@/hooks/use-document-title';
import { ShellLink } from './shell-link';

const PAGE_HEADER_SLOT_ID = 'page-header-slot';

/*
 * The slot is rendered by the shell header and the screen by the main view, often in one commit, so the
 * screen cannot find the slot while it renders: the slot reports its element here when React attaches it.
 */
let slotElement: HTMLElement | null = null;
const slotListeners = new Set<() => void>();

function attachSlot(element: HTMLElement | null): void {
  slotElement = element;
  for (const listener of slotListeners) listener();
}

function subscribeSlot(listener: () => void): () => void {
  slotListeners.add(listener);
  return () => slotListeners.delete(listener);
}

const readSlot = (): HTMLElement | null => slotElement;
const readNoSlot = (): HTMLElement | null => null;

/**
 * HD-03 on a panel or library route: an empty container the screen fills through `PageHeader`. It has no box
 * of its own (`contents`): the title and the actions are items of the shell header, so below 768 px the actions
 * take a line of their own under the title instead of pushing each other off the screen.
 */
export function PageHeaderSlot() {
  return <div id={PAGE_HEADER_SLOT_ID} ref={attachSlot} className="contents" />;
}

type PageHeaderProps = {
  /** The page's title: a section's title on a list, the record's name on a record page. */
  title: string;
  /** The page one level up, linked before the title. */
  parent?: { title: string; href: string };
  /** The area the page belongs to, named in the tab after the parent (the panel's «Панель»). */
  area?: string;
  /** Stands in the `h1`'s place while given: the tracker task's rename field (task-tracker KD-6). */
  titleField?: ReactNode;
  /** A state badge after the title. */
  badge?: ReactNode;
  /** The screen's actions, at the right end of the header. */
  children?: ReactNode;
};

/**
 * The screen's header, drawn into the shell header's slot so that its buttons and dialogs stay in the screen's
 * state. The `h1` is the shell's `page-title` focus target. The screen also titles the tab:
 * «{заголовок} — {родитель} — {область} — Agent OS», leaving out the parts it has not (MC-1, MC-7, MC-18).
 */
export function PageHeader({
  title,
  parent,
  area,
  titleField,
  badge,
  children,
}: PageHeaderProps) {
  const slot = useSyncExternalStore(subscribeSlot, readSlot, readNoSlot);
  const tabParts = [title, parent?.title, area].filter(
    (part): part is string => part !== undefined,
  );
  useDocumentTitle(pageTitle(...tabParts));
  if (slot === null) return null;

  return createPortal(
    <>
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {parent !== undefined && (
          <>
            {/* Below 768 px the title needs the line: the parent stays one tap away in the sidebar. */}
            <ShellLink
              href={parent.href}
              className="hidden shrink-0 rounded-sm px-1 text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring md:inline pointer-coarse:py-3"
            >
              {parent.title}
            </ShellLink>
            <ChevronRightIcon
              aria-hidden
              className="hidden size-3.5 shrink-0 text-muted-foreground md:block"
            />
          </>
        )}
        {titleField ?? (
          <h1
            tabIndex={-1}
            data-shell-focus="page-title"
            title={title}
            className="min-w-16 shrink truncate px-1 text-sm font-medium outline-none"
          >
            {title}
          </h1>
        )}
        {badge}
      </div>
      {children !== undefined && (
        <div className="order-last flex min-w-0 basis-full flex-wrap items-center gap-2 pb-2 md:order-none md:shrink-0 md:basis-auto md:flex-nowrap md:ps-2 md:pb-0">
          {children}
        </div>
      )}
    </>,
    slot,
  );
}
