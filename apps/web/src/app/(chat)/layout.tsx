import { Suspense, type ReactNode } from 'react';
import { cookies } from 'next/headers';
import { ChatShell } from '@/components/shell/chat-shell';
import { ShellFallback } from '@/components/shell/shell-fallback';

const SIDEBAR_COOKIE = 'sidebar_state';

type ChatLayoutProps = { children: ReactNode };

export default function ChatLayout({ children }: ChatLayoutProps) {
  return (
    <Suspense fallback={<ShellFallback />}>
      <ChatShellWithSidebarCookie>{children}</ChatShellWithSidebarCookie>
    </Suspense>
  );
}

/** Reading cookies() makes the group dynamic; the root layout stays static. */
async function ChatShellWithSidebarCookie({ children }: ChatLayoutProps) {
  const defaultSidebarOpen = (await cookies()).get(SIDEBAR_COOKIE)?.value !== 'false';
  return <ChatShell defaultSidebarOpen={defaultSidebarOpen}>{children}</ChatShell>;
}
