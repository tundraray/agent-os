'use client';

import { useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { ChevronRightIcon } from 'lucide-react';
import { pageTitle, useDocumentTitle } from '@/hooks/use-document-title';
import type { Resource } from '@/hooks/use-resource';
import { adminPath, type AdminSection } from '@/lib/shell-route';
import { adminSectionTitle } from './admin-sections';
import { DataTable, resourceTableState } from './data-table';

const ADMIN_HEADER_SLOT_ID = 'admin-header-slot';

/** UXRD MC-18: the panel's part of every tab title, «{раздел} — Панель — Agent OS». */
export const PANEL_TITLE = 'Панель';

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
 * HD-03 on a panel route: an empty container the section screen fills through `AdminPageHeader`. It has no box
 * of its own (`contents`): the title and the actions are items of the shell header, so below 768 px the actions
 * take a line of their own under the title instead of pushing each other off the screen.
 */
export function AdminHeaderSlot() {
  return <div id={ADMIN_HEADER_SLOT_ID} ref={attachSlot} className="contents" />;
}

type AdminPageHeaderProps = {
  /** The section's title on a list, the record's name on a record page. */
  title: string;
  /** On a record page: the section linked before the record's name. */
  parent?: AdminSection;
  /** A state badge after the title. */
  badge?: ReactNode;
  /** The screen's actions, at the right end of the header. */
  children?: ReactNode;
};

/**
 * UXRD AD-01: the screen's header, drawn into the shell header's slot so that its buttons and dialogs stay in
 * the screen's state. The `h1` is the shell's `page-title` focus target. The screen also titles the tab:
 * «{раздел} — Панель — Agent OS» on a section page, «{заголовок} — {раздел} — Панель — Agent OS» under a section.
 */
export function AdminPageHeader({ title, parent, badge, children }: AdminPageHeaderProps) {
  const slot = useSyncExternalStore(subscribeSlot, readSlot, readNoSlot);
  useDocumentTitle(
    parent === undefined ? pageTitle(title, PANEL_TITLE) : pageTitle(title, adminSectionTitle(parent), PANEL_TITLE),
  );
  if (slot === null) return null;

  return createPortal(
    <>
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {parent !== undefined && (
          <>
            {/* Below 768 px the title needs the line: the section stays one tap away in the sidebar. */}
            <Link
              href={adminPath(parent)}
              className="hidden shrink-0 rounded-sm px-1 text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring md:inline pointer-coarse:py-3"
            >
              {adminSectionTitle(parent)}
            </Link>
            <ChevronRightIcon aria-hidden className="hidden size-3.5 shrink-0 text-muted-foreground md:block" />
          </>
        )}
        <h1
          tabIndex={-1}
          data-shell-focus="page-title"
          title={title}
          className="min-w-16 shrink truncate px-1 text-sm font-medium outline-none"
        >
          {title}
        </h1>
        {badge}
      </div>
      {children !== undefined && (
        <div className="order-last flex min-w-0 basis-full flex-wrap items-center gap-2 pb-2 md:order-none md:shrink-0 md:basis-auto md:flex-nowrap md:pb-0">
          {children}
        </div>
      )}
    </>,
    slot,
  );
}

type RecordPlaceholderProps = {
  section: AdminSection;
  /** The record's read, not answered yet or failed. */
  resource: Pick<Resource<unknown>, 'status' | 'reload'>;
  loadFailed: string;
};

/** A record page until its record is read: the section's title over the table's Loading or its load error. */
export function RecordPlaceholder({ section, resource, loadFailed }: RecordPlaceholderProps) {
  const title = adminSectionTitle(section);
  return (
    <>
      <AdminPageHeader title={title} />
      <DataTable caption={title} columns={[]} state={resourceTableState({ ...resource, data: undefined }, loadFailed)} />
    </>
  );
}
