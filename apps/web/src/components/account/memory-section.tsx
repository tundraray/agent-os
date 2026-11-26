'use client';

import { useId } from 'react';
import { useTranslations } from 'next-intl';
import { MemoryTable } from '@/components/library/memory-table';
import { useResource } from '@/hooks/use-resource';
import { accessApi } from '@/lib/access/access-api';

/** UXRD ME-02: the records agents keep about the signed-in employee, the table of ME-01. */
export function MemorySection() {
  const headingId = useId();
  const t = useTranslations('account.memory');
  const memory = useResource(accessApi.memory, 'my-memory', 'account');

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-4">
      <h2 id={headingId} className="text-base leading-6 font-semibold">
        {t('title')}
      </h2>
      <MemoryTable
        caption={t('title')}
        memory={memory}
        empty={{ title: t('empty') }}
        remove={accessApi.deleteMemory}
        history={accessApi.memoryHistory}
        revert={accessApi.revertMemory}
        author="you"
      />
    </section>
  );
}
