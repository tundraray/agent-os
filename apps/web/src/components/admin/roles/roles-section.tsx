'use client';

import type { ReactNode } from 'react';
import type { AdminPage } from '@/lib/shell-route';
import { RoleList } from './role-list';

type RolesSectionProps = { page: AdminPage };

/** The «Роли» section: the list for every page until a role's own page (AD-06) reads `page`. */
export const RolesSection: (props: RolesSectionProps) => ReactNode = () => <RoleList />;
