'use client';

import {
  ADMIN_RECORD_TABS,
  type AdminPage,
  type AdminRecordTab,
} from '@/lib/shell-route';
import { UserList } from './user-list';
import { UserPage } from './user-page';

type UsersSectionProps = {
  /** The list or one employee's page, from the address. */
  page: AdminPage;
};

const isUserTab = (
  tab: AdminRecordTab | undefined,
): tab is AdminRecordTab<'users'> =>
  ADMIN_RECORD_TABS.users.some((userTab) => userTab === tab);

/**
 * The «Сотрудники» section: the list (AD-03, with AD-16) or one employee's page (AD-04). The page is keyed by
 * the employee alone: another employee's address starts from a fresh read, a tab change keeps the unsaved levels.
 */
export function UsersSection({ page }: UsersSectionProps) {
  return page.kind === 'record' ? (
    <UserPage
      key={page.key}
      id={page.key}
      tab={isUserTab(page.tab) ? page.tab : 'tools'}
    />
  ) : (
    <UserList />
  );
}
