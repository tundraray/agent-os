'use client';

import { useEffect, useId, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { PlusIcon, RotateCwIcon } from 'lucide-react';
import { useStore } from 'zustand';
import type { RecordSummary } from '@agent-os/contracts';
import { PageHeader } from '@/components/shell/page-header';
import { useShellServices } from '@/components/shell/shell-actions';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { useResource } from '@/hooks/use-resource';
import { focusShellTarget } from '@/lib/focus';
import { builtinName } from '@/i18n/builtin-name';
import type { Locale } from '@/i18n/pick-locale';
import { libraryApi } from '@/lib/library/library-api';
import { newRecordPath } from '@/lib/shell-route';
import { LibraryRow } from './library-row';
import { useInChat } from './use-in-chat';

/** Rows of a group skeleton (UXRD LB-02, Loading). */
const SKELETON_ROWS = [0, 1] as const;

type Groups = {
  mine: RecordSummary[];
  colleagues: RecordSummary[];
  company: RecordSummary[];
};

/** «Мои» — the viewer owns it; «От компании» — no author; «От коллег» — everything else. By the shown name. */
function groupsOf(
  records: ReadonlyMap<string, RecordSummary>,
  locale: Locale,
): Groups {
  const groups: Groups = { mine: [], colleagues: [], company: [] };
  for (const record of records.values()) {
    if (record.mine) groups.mine.push(record);
    else if (record.author === null) groups.company.push(record);
    else groups.colleagues.push(record);
  }
  const byName = (a: RecordSummary, b: RecordSummary): number =>
    builtinName(a, locale).localeCompare(builtinName(b, locale), locale);
  groups.mine.sort(byName);
  groups.colleagues.sort(byName);
  groups.company.sort(byName);
  return groups;
}

/**
 * Screen 1 «Библиотека» (UXRD LB-02): the three groups one under another in the feed column. The list is
 * the shell's `libraryIndex`, re-read on every entry (KD-2); the viewer's roles are read on entry too, for
 * the «no roles» states. A failed re-read keeps the rows already on screen.
 */
export function LibraryScreen() {
  const { libraryIndex } = useShellServices();
  const { status, records } = useStore(libraryIndex);
  const roles = useResource(libraryApi.myRoles, 'library', 'library');
  const noRoles = roles.status === 'ready' && roles.data?.length === 0;
  const inChat = useInChat();
  const t = useTranslations('library');
  const locale = useLocale();
  const createInChat = () => inChat({ text: t('screen.template') });

  useEffect(() => {
    void libraryIndex.refresh();
  }, [libraryIndex]);

  // UXRD «Порядок фокуса»: after the move to the page, focus lands on its title.
  useEffect(() => {
    focusShellTarget('page-title');
  }, []);

  return (
    <div className="h-full overflow-y-auto">
      <PageHeader title={t('screen.title')}>
        <CreateActions onCreateInChat={createInChat} />
      </PageHeader>
      <div className="mx-auto flex min-h-full w-full max-w-(--thread-max-width) flex-col gap-6 px-4 py-4 md:py-6">
        {records === null && status === 'error' ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center text-sm leading-5">
            <p role="alert">{t('screen.failed')}</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void libraryIndex.refresh()}
              className="pointer-coarse:h-11"
            >
              <RotateCwIcon aria-hidden />
              {t('retry')}
            </Button>
          </div>
        ) : records === null ? (
          <LoadingGroups />
        ) : (
          <LibraryGroups
            groups={groupsOf(records, locale)}
            noRoles={noRoles}
            onCreateInChat={createInChat}
          />
        )}
      </div>
    </div>
  );
}

function LibraryGroups({
  groups,
  noRoles,
  onCreateInChat,
}: {
  groups: Groups;
  noRoles: boolean;
  onCreateInChat: () => void;
}) {
  const t = useTranslations('library');
  return (
    <>
      <Group
        title={t('screen.mine')}
        records={groups.mine}
        showSource={false}
        noRoles={noRoles}
        empty={
          <div className="flex flex-col items-start gap-2 px-4 py-3 text-sm leading-5">
            <p className="text-foreground font-medium">{t('screen.noOwn')}</p>
            <p className="text-muted-foreground">{t('screen.noOwnHint')}</p>
            <Button
              variant="outline"
              size="sm"
              onClick={onCreateInChat}
              className="pointer-coarse:h-11"
            >
              {t('screen.createInChat')}
            </Button>
          </div>
        }
      />
      <Group
        title={t('screen.colleagues')}
        records={groups.colleagues}
        showSource
        noRoles={noRoles}
        empty={
          <EmptyLine>
            {noRoles ? t('screen.noRoles') : t('screen.noShared')}
          </EmptyLine>
        }
      />
      <Group
        title={t('screen.company')}
        records={groups.company}
        showSource
        noRoles={noRoles}
        empty={<EmptyLine>{t('screen.noCompany')}</EmptyLine>}
      />
    </>
  );
}

type GroupProps = {
  title: string;
  records: RecordSummary[];
  showSource: boolean;
  noRoles: boolean;
  empty: ReactNode;
};

function Group({ title, records, showSource, noRoles, empty }: GroupProps) {
  const t = useTranslations('library');
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-1">
      <h2
        id={headingId}
        className="text-muted-foreground px-4 text-xs leading-4 font-medium"
      >
        {t('screen.groupCount', { title, count: records.length })}
      </h2>
      {records.length === 0 ? (
        empty
      ) : (
        <ul className="flex flex-col">
          {records.map((record) => (
            <LibraryRow
              key={record.id}
              record={record}
              showSource={showSource}
              noRoles={noRoles}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function EmptyLine({ children }: { children: string }) {
  return (
    <p className="text-muted-foreground px-4 py-3 text-sm leading-5">
      {children}
    </p>
  );
}

/** LB-02 Loading: the group headings and two skeleton rows in each; a screen reader hears MC-3. */
function LoadingGroups() {
  const t = useTranslations('library');
  return (
    <>
      <p role="status" className="sr-only">
        {t('screen.loading')}
      </p>
      {[t('screen.mine'), t('screen.colleagues'), t('screen.company')].map(
        (title) => (
          <section key={title} aria-hidden className="flex flex-col gap-1">
            <h2 className="text-muted-foreground px-4 text-xs leading-4 font-medium">
              {title}
            </h2>
            {SKELETON_ROWS.map((row) => (
              <div key={row} className="flex flex-col gap-2 px-4 py-3">
                <Skeleton className="h-4 w-2/5" />
                <Skeleton className="h-3 w-4/5" />
              </div>
            ))}
          </section>
        ),
      )}
    </>
  );
}

/**
 * «Создать в чате», «Заполнить форму» and «Новый скилл» from 768 px; below it all three in the menu «+» (MC-1,
 * agent-guidance MC-10). A deep agent has no form: it is created in the chat (deep-agents UXRD DA-01).
 */
function CreateActions({ onCreateInChat }: { onCreateInChat: () => void }) {
  const router = useRouter();
  const t = useTranslations('library');
  const openForm = () => router.push(newRecordPath('agent'));
  const newSkill = () => router.push(newRecordPath('skill'));
  return (
    <>
      <div className="hidden items-center gap-2 md:flex">
        <Button variant="outline" size="sm" onClick={onCreateInChat}>
          {t('screen.createInChat')}
        </Button>
        <Button variant="outline" size="sm" onClick={openForm}>
          {t('screen.fillForm')}
        </Button>
        <Button variant="outline" size="sm" onClick={newSkill}>
          {t('screen.newSkill')}
        </Button>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="outline"
              size="icon"
              aria-label={t('screen.create')}
              className="md:hidden pointer-coarse:size-11"
            />
          }
        >
          <PlusIcon aria-hidden />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-auto min-w-40">
          <DropdownMenuItem onClick={onCreateInChat}>
            {t('screen.createInChat')}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={openForm}>
            {t('screen.agentForm')}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={newSkill}>
            {t('screen.newSkill')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
