'use client';

import type { ReactNode } from 'react';
import type { AdminPage } from '@/lib/shell-route';
import { UserList } from './user-list';

type UsersSectionProps = {
  /** The list or one employee's page, from the address. */
  page: AdminPage;
};

/** The «Сотрудники» section: every address shows the list until the employee page exists. */
export const UsersSection: (props: UsersSectionProps) => ReactNode = () => <UserList />;
