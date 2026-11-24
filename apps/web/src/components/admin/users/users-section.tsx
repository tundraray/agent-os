'use client';

import type { AdminPage } from '@/lib/shell-route';
import { UserList } from './user-list';
import { UserPage } from './user-page';

type UsersSectionProps = {
  /** The list or one employee's page, from the address. */
  page: AdminPage;
};

/**
 * The «Сотрудники» section: the list (AD-03, with AD-16) or one employee's page (AD-04). The page is keyed by
 * the employee, so another employee's address starts from a fresh read.
 */
export function UsersSection({ page }: UsersSectionProps) {
  return page.kind === 'record' ? (
    <UserPage key={page.key} id={page.key} />
  ) : (
    <UserList />
  );
}
