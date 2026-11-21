'use client';

import { useTranslations } from 'next-intl';
import { PageHeader } from '@/components/shell/page-header';
import type { Resource } from '@/hooks/use-resource';
import { adminPath, type AdminSection } from '@/lib/shell-route';
import { DataTable, resourceTableState } from './data-table';

export type AdminTitles = {
  /** UXRD MC-18: the panel's part of every tab title, «{раздел} — Панель — Agent OS». */
  panel: string;
  /** The title of one section, for a header, a table's name or the tab. */
  section: (section: AdminSection) => string;
  /** A panel section as the parent of a page under it: linked in the header, named in the tab. */
  parent: (section: AdminSection) => { title: string; href: string };
};

/** The panel's own titles in the page's language: the panel's name and its sections' names. */
export function useAdminTitles(): AdminTitles {
  const t = useTranslations('admin');
  const section = (id: AdminSection): string => t(`section.${id}`);
  return {
    panel: t('panel'),
    section,
    parent: (id) => ({ title: section(id), href: adminPath(id) }),
  };
}

type RecordPlaceholderProps = {
  section: AdminSection;
  /** The record's read, not answered yet or failed. */
  resource: Pick<Resource<unknown>, 'status' | 'reload'>;
  loadFailed: string;
};

/** A record page until its record is read: the section's title over the table's Loading or its load error. */
export function RecordPlaceholder({ section, resource, loadFailed }: RecordPlaceholderProps) {
  const titles = useAdminTitles();
  const title = titles.section(section);
  return (
    <>
      <PageHeader title={title} area={titles.panel} />
      <DataTable caption={title} columns={[]} state={resourceTableState({ ...resource, data: undefined }, loadFailed)} />
    </>
  );
}
