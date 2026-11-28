import {
  BoxIcon,
  FileTextIcon,
  KeyRoundIcon,
  LibraryBigIcon,
  PaletteIcon,
  ServerIcon,
  ShieldIcon,
  UsersIcon,
  type LucideIcon,
} from 'lucide-react';
import {
  ADMIN_SECTION_IDS,
  adminPath,
  type AdminSection,
} from '@/lib/shell-route';

/** A section's title is `admin.section.{section}` of the catalogue (UXRD MC-18), read by `useAdminTitles`. */
export type AdminSectionEntry = {
  section: AdminSection;
  Icon: LucideIcon;
  path: string;
};

const ICON: Readonly<Record<AdminSection, LucideIcon>> = {
  users: UsersIcon,
  roles: ShieldIcon,
  'sign-in': KeyRoundIcon,
  servers: ServerIcon,
  models: BoxIcon,
  library: LibraryBigIcon,
  instructions: FileTextIcon,
  appearance: PaletteIcon,
};

/**
 * The panel's sections in sidebar order (AD-01, MC-18; the agents and deep agents section — AL-01; the organisation's
 * instruction — agent-guidance OI-01; «Оформление» — theming TP-03).
 */
export const ADMIN_SECTIONS: readonly AdminSectionEntry[] =
  ADMIN_SECTION_IDS.map((section) => ({
    section,
    Icon: ICON[section],
    path: adminPath(section),
  }));
