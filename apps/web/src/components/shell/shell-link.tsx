'use client';

import { useContext, type ComponentProps } from 'react';
import Link from 'next/link';
import { ShellActionsContext, ShellServicesContext } from './shell-actions';

type ShellLinkProps = Omit<ComponentProps<typeof Link>, 'href'> & {
  href: string;
};

/**
 * `next/link` that respects unsaved changes (KD-4): while nothing is held it navigates as a plain link, in the
 * same tick; otherwise it stops the navigation, asks MC-11, and goes only on «Уйти без сохранения». Every link
 * visible next to an editor goes through it.
 */
export function ShellLink({ href, onNavigate, ...props }: ShellLinkProps) {
  // A shell piece rendered on its own, outside the shell, has no unsaved changes to protect.
  const leaveGuard = useContext(ShellServicesContext)?.leaveGuard;
  const actions = useContext(ShellActionsContext);

  const guardNavigate: ShellLinkProps['onNavigate'] = (event) => {
    onNavigate?.(event);
    if (
      leaveGuard === undefined ||
      actions === null ||
      leaveGuard.getState().held === null
    )
      return;
    event.preventDefault();
    actions.leaveTo(href);
  };

  return <Link href={href} onNavigate={guardNavigate} {...props} />;
}
