'use client';

import { useTranslations } from 'next-intl';
import { InstructionField } from '@/components/instruction-field';
import { PageHeader } from '@/components/shell/page-header';
import { adminApi } from '@/lib/admin/admin-api';
import { useAdminTitles } from './admin-header';

/** OI-01: «Инструкция для агентов» — the organisation's text that every employee's agents receive (MC-7). */
export function InstructionsSection() {
  const titles = useAdminTitles();
  const t = useTranslations('admin.instructions');
  const title = titles.section('instructions');
  return (
    <>
      <PageHeader area={titles.panel} title={title} />
      <InstructionField
        variant="organisation"
        title={title}
        description={t('description')}
        warning={t('warning')}
        placeholder={t('placeholder')}
        resourceKey="admin:instructions"
        read={adminApi.instructions.get}
        write={adminApi.instructions.save}
        logEvent="admin: organisation instructions"
      />
    </>
  );
}
