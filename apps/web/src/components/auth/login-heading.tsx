'use client';

import { useTranslations } from 'next-intl';
import { pageTitle, useDocumentTitle } from '@/hooks/use-document-title';

/** The heading and the tab title of uxrd Screen 1, in the interface language. */
export function LoginHeading() {
  const t = useTranslations('login');
  useDocumentTitle(pageTitle(t('title')));
  return <h1 className="text-xl font-semibold">{t('heading')}</h1>;
}
