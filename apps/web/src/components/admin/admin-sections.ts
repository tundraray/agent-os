import { BoxIcon, KeyRoundIcon, ServerIcon, ShieldIcon, UsersIcon, type LucideIcon } from 'lucide-react';
import { ADMIN_SECTION_IDS, adminPath, type AdminSection } from '@/lib/shell-route';

export type AdminSectionEntry = {
  section: AdminSection;
  /** UXRD MC-18: read by the sidebar, the section headers and the tab title. */
  title: string;
  Icon: LucideIcon;
  path: string;
};

const LOOK: Readonly<Record<AdminSection, { title: string; Icon: LucideIcon }>> = {
  users: { title: 'Сотрудники', Icon: UsersIcon },
  roles: { title: 'Роли', Icon: ShieldIcon },
  'sign-in': { title: 'Авторизация', Icon: KeyRoundIcon },
  servers: { title: 'MCP-серверы', Icon: ServerIcon },
  models: { title: 'Модели', Icon: BoxIcon },
};

/** The panel's five sections in sidebar order (AD-01, MC-18). */
export const ADMIN_SECTIONS: readonly AdminSectionEntry[] = ADMIN_SECTION_IDS.map((section) => ({
  section,
  ...LOOK[section],
  path: adminPath(section),
}));

/** The title of one section, for a header or the tab. */
export const adminSectionTitle = (section: AdminSection): string => LOOK[section].title;
