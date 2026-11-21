'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import type { RecordDetail, RecordKind, RecordSummary } from '@agent-os/contracts';
import { CONTROL_SIZE } from '@/components/admin/admin-form';
import { PANEL_TITLE, sectionParent } from '@/components/admin/admin-header';
import { ConfirmDialog } from '@/components/admin/confirm-dialog';
import { DefinitionView } from '@/components/library/definition-view';
import { KnowledgeButton } from '@/components/library/editor-header';
import { RecordLabel } from '@/components/library/record-label';
import { PageHeader } from '@/components/shell/page-header';
import { useShellServices } from '@/components/shell/shell-actions';
import { Button } from '@/components/ui/button';
import { adminApi } from '@/lib/admin/admin-api';
import { describeLibraryError, kindWord } from '@/lib/library/library-errors';
import { recordAction } from '@/lib/library/record-action';
import { adminLibraryTabPath, adminRecordPath } from '@/lib/shell-route';

/** UXRD MC-18. */
const TEXT = {
  close: 'Закрыть доступ',
  closeTitle: (name: string) => `Закрыть доступ к «${name}»?`,
  closeBody: (kind: RecordKind, author: string, roles: string) =>
    `${kindWord(kind, true)} станет личным у автора, ${author}: роли ${roles} перестанут его видеть. Поделиться им снова автор не сможет, пока вы не снимете запрет. Запуски, которые уже идут, доработают.`,
  closed: 'Доступ закрыт',
  roles: 'Роли',
} as const;

const EMPTY_VALUE = '—';

/** The panel's own address of a record: links in the panel never lead to the employee's library. */
export const panelRecordHref = (id: string): string => adminRecordPath('library', id);

/** An employee's record whose access the administrator closes: a row of «Открытые ролям» or AL-03. */
export type ClosableRecord = Pick<RecordSummary, 'id' | 'kind' | 'name' | 'audience'> & {
  author: NonNullable<RecordSummary['author']>;
};

const rolesOf = (record: Pick<RecordSummary, 'audience'>): string =>
  record.audience.roles.map((role) => role.name).join(', ');

type CloseAccessDialogProps = {
  record: ClosableRecord;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** After the confirmed close: the row leaves, the page returns to its tab. */
  onClosed: () => void;
};

/**
 * MC-18 `alert-dialog` of «Закрыть доступ» (AL-03): nothing is sent before the confirmation, then exactly one
 * `close` through `recordAction`, and `libraryIndex` is re-read (KD-2). A refusal stays in the dialog with its
 * text; «Отмена» and Esc send nothing.
 */
export function CloseAccessDialog({ record, open, onOpenChange, onClosed }: CloseAccessDialogProps) {
  const t = useTranslations('errors');
  const { libraryIndex } = useShellServices();

  async function close(): Promise<void> {
    await recordAction({ recordId: record.id, kind: record.kind, action: 'close', version: null }, () =>
      adminApi.library.close(record.id),
    );
    void libraryIndex.refresh();
    toast.success(TEXT.closed);
    onClosed();
  }

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={TEXT.closeTitle(record.name)}
      body={TEXT.closeBody(record.kind, record.author.name, rolesOf(record))}
      confirmLabel={TEXT.close}
      onConfirm={close}
      // `recordAction` has logged the refusal.
      refusalText={(cause) => describeLibraryError(t, cause, { where: 'panel', kind: record.kind }).text}
    />
  );
}

type EmployeeRecordPageProps = { record: RecordDetail };

/**
 * UXRD AL-03: an employee's record in the panel, read only — the record label with its author, the roles it is
 * open to and its definition «На странице»; «Что узнал workflow» (MC-7, a workflow only) and «Закрыть доступ» in
 * the header. The administrator never edits it.
 * Other employees' text is rendered as text only. A company record (no author) has nothing to close.
 */
export function EmployeeRecordPage({ record }: EmployeeRecordPageProps) {
  const router = useRouter();
  const [closing, setClosing] = useState(false);
  const roles = rolesOf(record);
  const author = record.author;

  return (
    <>
      <PageHeader area={PANEL_TITLE} title={record.name} parent={sectionParent('library')}>
        <KnowledgeButton record={record} />
        {author !== null && (
          <Button variant="outline" size="sm" className={CONTROL_SIZE} onClick={() => setClosing(true)}>
            {TEXT.close}
          </Button>
        )}
      </PageHeader>
      <div className="flex max-w-240 flex-col gap-4">
        <div className="flex flex-col gap-1">
          <RecordLabel variant="under" summary={record} href={panelRecordHref(record.id)} />
          <p className="text-data text-foreground">
            <span className="text-muted-foreground">{TEXT.roles}: </span>
            {roles === '' ? EMPTY_VALUE : roles}
          </p>
        </div>
        <DefinitionView
          definition={record}
          missingRights={record.missingRights}
          variant="page"
          recordHref={panelRecordHref}
        />
      </div>
      {author !== null && (
        <CloseAccessDialog
          record={{ ...record, author }}
          open={closing}
          onOpenChange={setClosing}
          onClosed={() => router.push(adminLibraryTabPath('shared'))}
        />
      )}
    </>
  );
}
