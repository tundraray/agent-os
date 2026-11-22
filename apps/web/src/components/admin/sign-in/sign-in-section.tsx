'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { PageHeader } from '@/components/shell/page-header';
import { buttonVariants } from '@/components/ui/button';
import { adminNewPath, type AdminPage } from '@/lib/shell-route';
import { CONTROL_SIZE } from '../admin-form';
import { useAdminTitles } from '../admin-header';
import { NewProviderForm } from './new-provider-form';
import { ProviderPage } from './provider-page';
import { ProvidersTable } from './providers-table';
import { SignInSettingsForm } from './sign-in-settings-form';

type SignInSectionProps = {
  /** The list, the new-provider form or one provider's page, from the address. */
  page: AdminPage;
};

/**
 * The «Авторизация» section: the sign-in methods and settings (AD-07, AD-14), the new provider, or one
 * provider's page. The page is keyed by the provider, so another provider's address starts from a fresh read.
 */
export function SignInSection({ page }: SignInSectionProps) {
  const titles = useAdminTitles();
  const t = useTranslations('admin.signIn');
  if (page.kind === 'new') return <NewProviderForm />;
  if (page.kind === 'record')
    return <ProviderPage key={page.key} id={page.key} />;
  return (
    <>
      <PageHeader area={titles.panel} title={titles.section('sign-in')}>
        <Link
          href={adminNewPath('sign-in')}
          className={buttonVariants({ size: 'sm', className: CONTROL_SIZE })}
        >
          {t('addProvider')}
        </Link>
      </PageHeader>
      <div className="flex max-w-240 flex-col gap-8">
        <ProvidersTable />
        <SignInSettingsForm />
      </div>
    </>
  );
}
