'use client';

import { useId } from 'react';
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
import { Skeleton } from '@/components/ui/skeleton';
import { DEV_USER } from '@/lib/dev-user';
import { SPEND_ERROR_TEXT, SPEND_LOADING_TEXT, useSpend, type SpendState } from '@/lib/spend';
import { cn } from '@/lib/utils';

const THEMES = [
  { value: 'light', label: 'Светлая', icon: SunIcon },
  { value: 'dark', label: 'Тёмная', icon: MoonIcon },
  { value: 'system', label: 'Системная', icon: MonitorIcon },
] as const satisfies ReadonlyArray<{ value: string; label: string; icon: LucideIcon }>;

type ThemeValue = (typeof THEMES)[number]['value'];

const isThemeValue = (value: unknown): value is ThemeValue => THEMES.some((theme) => theme.value === value);

/** MC-2 text of SP-01 for the visible line once read, and for the strip's avatar tooltip in every state. */
function spendText(spend: SpendState): string {
  if (spend.kind === 'ready') return spend.text;
  return spend.kind === 'error' ? SPEND_ERROR_TEXT : SPEND_LOADING_TEXT;
}

/**
 * SB-11 + TM-01 + SP-01: the user block at the bottom of the sidebar with the month's spend under the name;
 * its menu holds only the user and the theme choice.
 */
export function UserMenu() {
  const { theme, setTheme } = useTheme();
  const { isMobile, state } = useSidebar();
  const isStrip = !isMobile && state === 'collapsed';
  const spend = useSpend();
  const spendId = useId();

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <SidebarMenuButton
                size="lg"
                // In the 48 px strip the spend line is clipped: it moves into the avatar's tooltip.
                tooltip={
                  isMobile
                    ? undefined
                    : {
                        children: (
                          <span className="flex flex-col">
                            <span>{DEV_USER.name}</span>
                            <span className="tabular-nums">{spendText(spend)}</span>
                          </span>
                        ),
                      }
                }
                aria-label={`Меню пользователя ${DEV_USER.name}`}
                aria-describedby={spendId}
                className="data-popup-open:bg-sidebar-accent data-popup-open:text-sidebar-accent-foreground"
              />
            }
          >
            <Avatar aria-hidden className={cn('ml-0.5', isStrip ? 'size-8' : 'size-7')}>
              <AvatarFallback className="text-xs font-medium">{DEV_USER.initials}</AvatarFallback>
            </Avatar>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate">{DEV_USER.name}</span>
              {/* Fixed line height: the skeleton and the text occupy the same box, so nothing shifts. */}
              <span id={spendId} className="flex h-4 items-center text-xs text-muted-foreground tabular-nums">
                {spend.kind === 'loading' ? (
                  <>
                    <Skeleton aria-hidden className="h-3 w-30 motion-reduce:animate-none" />
                    <span className="sr-only">{SPEND_LOADING_TEXT}</span>
                  </>
                ) : (
                  <span className="truncate">{spendText(spend)}</span>
                )}
              </span>
            </span>
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
