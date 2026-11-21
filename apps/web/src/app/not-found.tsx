'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { buttonVariants } from '@/components/ui/button';
import { pageTitle, useDocumentTitle } from '@/hooks/use-document-title';

/**
 * uxrd NF-01: laid out as the error page and, like it, reads nothing from the API. The link opens the start
 * address: a new chat for a signed-in employee, the sign-in page otherwise.
 */
export default function NotFound() {
  const t = useTranslations('pages.notFound');
  useDocumentTitle(pageTitle(t('title')));

  return (
    <div className="bg-background flex min-h-dvh w-full flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="text-lg font-medium">{t('title')}</h1>
      <p className="text-sm text-muted-foreground">{t('description')}</p>
      <Link href="/" className={buttonVariants()}>
        {t('home')}
      </Link>
    </div>
  );
}
