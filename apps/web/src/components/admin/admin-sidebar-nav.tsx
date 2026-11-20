'use client';

import type { Ref } from 'react';
import { usePathname } from 'next/navigation';
import { ArrowLeftIcon } from 'lucide-react';
import { ShellLink } from '@/components/shell/shell-link';
import { Skeleton } from '@/components/ui/skeleton';
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar';
import { parseShellRoute } from '@/lib/shell-route';
import { cn } from '@/lib/utils';
import { ADMIN_SECTIONS } from './admin-sections';

/** UXRD MC-18. */
const TEXT = { back: 'К чату', panel: 'Панель' } as const;

/** One skeleton row per section of `ADMIN_SECTIONS`. */
const SKELETON_WIDTHS = ['w-3/5', 'w-2/5', 'w-1/2', 'w-3/5', 'w-2/5', 'w-1/2'] as const;

const itemClass = (isMobile: boolean): string =>
  cn(
    'pointer-coarse:h-11',
    isMobile ? 'h-11' : 'h-8',
    // Selected marker as on SB-06: the --sidebar-accent background alone is below 3:1.
    'relative data-active:before:absolute data-active:before:inset-y-2 data-active:before:left-0 data-active:before:w-0.75 data-active:before:rounded-full data-active:before:bg-sidebar-primary',
  );

type AdminSidebarNavProps = {
  /** The right is not known yet: skeleton rows stand in place of the sections (AD-01). */
  loading: boolean;
  /** «К чату», the drawer's first stop. */
  backRef?: Ref<HTMLAnchorElement>;
  /** A pick in the mobile drawer: the drawer closes and leaves the focus to the picked screen's `h1`. */
  onMobilePick: () => void;
};

/**
 * AD-01: «К чату», the «Панель» label and the panel's sections in place of «Новый чат», «Агенты» and the history.
 * The selected section is marked as the active thread (SB-06).
 */
export function AdminSidebarNav({ loading, backRef, onMobilePick }: AdminSidebarNavProps) {
  const { isMobile } = useSidebar();
  const route = parseShellRoute(usePathname());
  const selected = route.kind === 'admin' ? route.section : undefined;

  return (
    <>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton
            tooltip={isMobile ? undefined : TEXT.back}
            className={itemClass(isMobile)}
            render={<ShellLink ref={backRef} href="/" />}
          >
            <ArrowLeftIcon aria-hidden />
            <span>{TEXT.back}</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
      <SidebarGroup className="px-0 pb-0">
        <SidebarGroupLabel>{TEXT.panel}</SidebarGroupLabel>
        {loading ? (
          <div aria-hidden className="flex flex-col gap-1">
            {SKELETON_WIDTHS.map((width, index) => (
              // The slot of the sidebar kit's own menu skeleton, which pulses even under reduced motion.
              <div key={index} data-slot="sidebar-menu-skeleton" className="flex h-8 items-center gap-2 px-2">
                <Skeleton className="size-4 shrink-0 motion-reduce:animate-none" />
                <Skeleton className={cn('h-3 motion-reduce:animate-none', width)} />
              </div>
            ))}
          </div>
        ) : (
          <SidebarMenu>
            {ADMIN_SECTIONS.map(({ section, title, Icon, path }) => {
              const isActive = section === selected;
              return (
                <SidebarMenuItem key={section}>
                  <SidebarMenuButton
                    isActive={isActive}
                    tooltip={isMobile ? undefined : title}
                    className={itemClass(isMobile)}
                    render={<ShellLink href={path} aria-current={isActive ? 'page' : undefined} onClick={isMobile ? onMobilePick : undefined} />}
                  >
                    <Icon aria-hidden />
                    <span className="flex-1 truncate">{title}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        )}
      </SidebarGroup>
    </>
  );
}
