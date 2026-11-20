'use client';

import { PageHeader } from '@/components/shell/page-header';
import type { Resource } from '@/hooks/use-resource';
import { adminPath, type AdminSection } from '@/lib/shell-route';
import { adminSectionTitle } from './admin-sections';
import { DataTable, resourceTableState } from './data-table';

/** UXRD MC-18: the panel's part of every tab title, «{раздел} — Панель — Agent OS». */
export const PANEL_TITLE = 'Панель';

/** A panel section as the parent of a page under it: linked in the header, named in the tab. */
export const sectionParent = (section: AdminSection): { title: string; href: string } => ({
  title: adminSectionTitle(section),
  href: adminPath(section),
});

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
      <PageHeader title={title} area={PANEL_TITLE} />
      <DataTable caption={title} columns={[]} state={resourceTableState({ ...resource, data: undefined }, loadFailed)} />
    </>
  );
}
