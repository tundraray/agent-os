'use client';

import { useEffect } from 'react';
import { Button } from '@/components/ui/button';

type ChatErrorProps = {
  error: unknown;
  retry: () => void;
};

const digestOf = (error: unknown): string | undefined =>
  error instanceof Error && 'digest' in error && typeof error.digest === 'string' ? error.digest : undefined;

/** Error boundary of the `(chat)` group: a fixed message and a page reload. */
export default function ChatError({ error }: ChatErrorProps) {
  useEffect(() => {
    console.error('chat shell: render failed', { digest: digestOf(error) }, error);
  }, [error]);

  return (
    <div className="bg-background flex min-h-dvh w-full flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="text-lg font-medium">Что-то пошло не так</h1>
      <Button onClick={() => window.location.reload()}>Обновить страницу</Button>
    </div>
  );
}
