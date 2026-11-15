'use client';

import { useEffect, useId } from 'react';
import Link from 'next/link';
import {
  ChevronUpIcon,
  KeyRoundIcon,
  LogOutIcon,
  MonitorIcon,
  MoonIcon,
  SunIcon,
  type LucideIcon,
} from 'lucide-react';
import { useTheme } from 'next-themes';
import { toast } from 'sonner';
import { useStore } from 'zustand';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from '@/components/ui/sidebar';
import { Skeleton } from '@/components/ui/skeleton';
import { describeApiError } from '@/lib/api/api-request';
import { displayName, initialsOf } from '@/lib/auth/current-user';
import { logger } from '@/lib/logger';
import { ACCOUNT_PATH } from '@/lib/shell-route';
import { SPEND_ERROR_TEXT, SPEND_LOADING_TEXT, useSpend, type SpendState } from '@/lib/spend';
import { cn } from '@/lib/utils';
import { useShellServices } from './shell-actions';

const SIGN_OUT_FAILED_TEXT = 'Не удалось выйти. Попробуйте ещё раз.';

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
 * UM-01 (SB-11) + TM-01 + SP-01: the signed-in employee's block at the bottom of the sidebar with the
 * month's spend under the name; its menu holds the name and email, «Мой доступ», the theme and «Выйти».
 */
export function UserMenu() {
  const { theme, setTheme } = useTheme();
  const { isMobile, state } = useSidebar();
  const isStrip = !isMobile && state === 'collapsed';
  const spend = useSpend();
  const spendId = useId();
  const { currentUser } = useShellServices();
  const user = useStore(currentUser, (current) => current.user);
  const name = user === null ? null : displayName(user);

  useEffect(() => {
    currentUser.load();
  }, [currentUser]);

  const signOut = async (): Promise<void> => {
    try {
      await currentUser.signOut();
    } catch (error) {
      logger.error('sign-out failed', describeApiError(error));
      toast.error(SIGN_OUT_FAILED_TEXT);
    }
  };

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
                            {name !== null && <span>{name}</span>}
                            <span className="tabular-nums">{spendText(spend)}</span>
                          </span>
                        ),
                      }
                }
                aria-label={name === null ? 'Меню пользователя' : `Меню пользователя ${name}`}
                aria-describedby={spendId}
                className="data-popup-open:bg-sidebar-accent data-popup-open:text-sidebar-accent-foreground"
              />
            }
          >
            <Avatar aria-hidden className={cn('ml-0.5', isStrip ? 'size-8' : 'size-7')}>
              <AvatarFallback className="text-xs font-medium">{name === null ? '' : initialsOf(name)}</AvatarFallback>
            </Avatar>
            <span className="flex min-w-0 flex-1 flex-col">
              {/* Same fixed-height box for the skeleton and the name: the block does not shift once read. */}
              <span className="flex h-5 items-center">
                {name === null ? (
                  <Skeleton aria-hidden className="h-3.5 w-24 motion-reduce:animate-none" />
                ) : (
                  <span className="truncate">{name}</span>
                )}
              </span>
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
              {user === null ? (
                <div aria-hidden className="flex flex-col gap-1.5 py-0.5">
                  <Skeleton className="h-3.5 w-28 motion-reduce:animate-none" />
                  <Skeleton className="h-3 w-36 motion-reduce:animate-none" />
                </div>
              ) : (
                <>
                  <p className="truncate text-sm font-medium">{displayName(user)}</p>
                  <p className="truncate text-xs text-muted-foreground">{user.email}</p>
                </>
              )}
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem render={<Link href={ACCOUNT_PATH} />}>
              <KeyRoundIcon aria-hidden />
              Мой доступ
            </DropdownMenuItem>
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
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => void signOut()}>
              <LogOutIcon aria-hidden />
              Выйти
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
