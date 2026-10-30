'use client';

import { ChevronUpIcon, MonitorIcon, MoonIcon, SunIcon, type LucideIcon } from 'lucide-react';
import { useTheme } from 'next-themes';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from '@/components/ui/sidebar';
import { DEV_USER } from '@/lib/dev-user';
import { cn } from '@/lib/utils';

const THEMES = [
  { value: 'light', label: 'Светлая', icon: SunIcon },
  { value: 'dark', label: 'Тёмная', icon: MoonIcon },
  { value: 'system', label: 'Системная', icon: MonitorIcon },
] as const satisfies ReadonlyArray<{ value: string; label: string; icon: LucideIcon }>;

type ThemeValue = (typeof THEMES)[number]['value'];

const isThemeValue = (value: unknown): value is ThemeValue => THEMES.some((theme) => theme.value === value);

/** SB-11 + TM-01: the user block at the bottom of the sidebar; its menu holds only the user and the theme choice. */
export function UserMenu() {
  const { theme, setTheme } = useTheme();
  const { isMobile, state } = useSidebar();
  const isStrip = !isMobile && state === 'collapsed';

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <SidebarMenuButton
                size="lg"
                tooltip={isMobile ? undefined : DEV_USER.name}
                aria-label={`Меню пользователя ${DEV_USER.name}`}
                className="data-popup-open:bg-sidebar-accent data-popup-open:text-sidebar-accent-foreground"
              />
            }
          >
            <Avatar aria-hidden className={cn('ml-0.5', isStrip ? 'size-8' : 'size-7')}>
              <AvatarFallback className="text-xs font-medium">{DEV_USER.initials}</AvatarFallback>
            </Avatar>
            <span className="flex-1 truncate">{DEV_USER.name}</span>
            <ChevronUpIcon aria-hidden className="ml-auto text-muted-foreground" />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            side={isStrip ? 'right' : 'top'}
            align="end"
            sideOffset={isStrip ? 8 : 4}
            className={cn(isStrip && 'min-w-56 w-auto')}
          >
            <div className="px-1.5 py-1">
              <p className="truncate text-sm font-medium">{DEV_USER.name}</p>
              <p className="text-xs text-muted-foreground">{DEV_USER.caption}</p>
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuRadioGroup
              value={theme ?? 'system'}
              onValueChange={(value: unknown) => {
                if (isThemeValue(value)) setTheme(value);
              }}
            >
              <DropdownMenuLabel>Тема</DropdownMenuLabel>
              {THEMES.map(({ value, label, icon: Icon }) => (
                <DropdownMenuRadioItem key={value} value={value} closeOnClick>
                  <Icon aria-hidden />
                  {label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
