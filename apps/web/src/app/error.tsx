'use client';

import { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { logger } from '@/lib/logger';

type ShellErrorProps = {
  error: unknown;
  retry: () => void;
};

const digestOf = (error: unknown): string | undefined =>
  error instanceof Error && 'digest' in error && typeof error.digest === 'string' ? error.digest : undefined;

/**
 * Root error boundary: sits inside the root layout (theme, fonts, global styles stay active) and
 * outside `(chat)/layout.tsx`, so render errors of the shell itself land here. Only the digest is
 * logged; the error text and stack are neither shown nor logged.
 */
export default function ShellError({ error }: ShellErrorProps) {
  useEffect(() => {
    logger.error('chat shell: render failed', { digest: digestOf(error) });
  }, [error]);

  return (
    <div className="bg-background flex min-h-dvh w-full flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="text-lg font-medium">Что-то пошло не так</h1>
      <Button onClick={() => window.location.reload()}>Обновить страницу</Button>
    </div>
  );
}
