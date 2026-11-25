'use client';

import { useEffect, useState } from 'react';
import { Info } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import type { RecordDetail } from '@agent-os/contracts';
import {
  RecordPlaceholder,
  useAdminTitles,
} from '@/components/admin/admin-header';
import { PageHeader } from '@/components/shell/page-header';
import { ShellLink } from '@/components/shell/shell-link';
import { ThreadNotice } from '@/components/shell/thread-notice';
import { buttonVariants } from '@/components/ui/button';
import { useResource } from '@/hooks/use-resource';
import { adminApi } from '@/lib/admin/admin-api';
import { focusShellTarget } from '@/lib/focus';
import { builtinName } from '@/i18n/builtin-name';
import { libraryApi } from '@/lib/library/library-api';
import { isHiddenFromViewer } from '@/lib/library/library-errors';
import { adminRecordPath, libraryPath, recordPath } from '@/lib/shell-route';
import { RecordSkeleton } from './record-page';
import { MemoryTable } from './memory-table';

export type MemoryPageProps = { id: string; variant: 'library' | 'panel' };

/**
 * UXRD ME-01: a deep agent's memory in the library and in the panel. The record and the memory are read in
 * parallel on open (read-on-open). A 404 of either read, the memory's 403 `MEMORY_FORBIDDEN` or an agent at this
 * address is the place's «Не найдено» (ME-04), which names nothing; until the memory has answered nothing of the
 * record is drawn, so a closed memory never shows its deep agent's name first.
 */
export function MemoryPage({ id, variant }: MemoryPageProps) {
  const t = useTranslations('library');
  const locale = useLocale();
  const record = useResource(
    () =>
      variant === 'library' ? libraryApi.get(id) : adminApi.library.get(id),
    `${variant}:record:${id}`,
    'library',
  );
  const memory = useResource(
    () => libraryApi.memory(id),
    `memory:${id}`,
    'library',
  );
  // The memory's first answer, kept so that a retry of a failed read keeps the header on screen.
  const [answered, setAnswered] = useState(false);
  if (!answered && memory.status !== 'loading') setAnswered(true);

  if (
    isHiddenFromViewer(record.error) ||
    isHiddenFromViewer(memory.error) ||
    record.data?.kind === 'agent'
  ) {
    return variant === 'library' ? (
      <ThreadNotice variant="library-not-found" />
    ) : (
      <ThreadNotice variant="record-not-found" section="library" />
    );
  }
  if (record.status === 'error') {
    return variant === 'library' ? (
      <ThreadNotice variant="library-load-error" onRetry={record.reload} />
    ) : (
      <RecordPlaceholder
        section="library"
        resource={record}
        loadFailed={t('memory.loadFailed')}
      />
    );
  }
  if (record.data === undefined || !answered) {
    return variant === 'library' ? (
      <RecordSkeleton />
    ) : (
      <RecordPlaceholder
        section="library"
        resource={{ status: 'loading', reload: record.reload }}
        loadFailed={t('memory.loadFailed')}
      />
    );
  }

  const title = t('memory.title', { name: builtinName(record.data, locale) });
  const content = (
    <>
      {memory.data?.selfLearning === false && (
        <p className="flex items-start gap-1.5 text-sm leading-5 text-foreground">
          <Info aria-hidden className="mt-0.5 size-3.5 shrink-0 text-info" />
          {t('memory.selfLearningOff')}
        </p>
      )}
      <MemoryTable
        caption={title}
        memory={memory}
        empty={{
          title: t('memory.empty.title'),
          description: t('memory.empty.text'),
        }}
        remove={(memoryId) => libraryApi.deleteMemory(id, memoryId)}
        history={(memoryId) => libraryApi.memoryHistory(id, memoryId)}
        revert={(memoryId, body) => libraryApi.revertMemory(id, memoryId, body)}
        author="name"
      />
    </>
  );
  const header = (
    <MemoryHeader record={record.data} title={title} variant={variant} />
  );
  // The panel's frame pads its screens; the library page scrolls in the feed's column.
  if (variant === 'panel') {
    return (
      <>
        {header}
        <div className="flex min-w-0 flex-col gap-4">{content}</div>
      </>
    );
  }
  return (
    <div className="h-full overflow-y-auto">
      {header}
      <div className="mx-auto flex w-full max-w-(--thread-max-width) min-w-0 flex-col gap-4 px-4 py-4 md:py-6">
        {content}
      </div>
    </div>
  );
}

/** MC-2: the `h1`, the parent of the place and «Открыть глубокого агента»; focus lands on the `h1` once it is drawn. */
function MemoryHeader({
  record,
  title,
  variant,
}: {
  record: RecordDetail;
  title: string;
  variant: MemoryPageProps['variant'];
}) {
  const titles = useAdminTitles();
  const t = useTranslations('library');
  useEffect(() => {
    focusShellTarget('page-title');
  }, [record.id]);

  const library = variant === 'library';
  return (
    <PageHeader
      title={title}
      parent={
        library
          ? { title: t('screen.title'), href: libraryPath() }
          : titles.parent('library')
      }
      area={library ? undefined : titles.panel}
    >
      <ShellLink
        href={
          library
            ? recordPath(record.id)
            : adminRecordPath('library', record.id)
        }
        className={buttonVariants({
          variant: 'outline',
          size: 'sm',
          className: 'pointer-coarse:h-11',
        })}
      >
        {t('memory.openDeepAgent')}
      </ShellLink>
    </PageHeader>
  );
}
