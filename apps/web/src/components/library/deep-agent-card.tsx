'use client';

import { useEffect, useId, useState } from 'react';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import type { RecordDetail } from '@agent-os/contracts';
import { FormWarning } from '@/components/admin/admin-form';
import { useAdminTitles } from '@/components/admin/admin-header';
import { PageHeader } from '@/components/shell/page-header';
import { useShellServices } from '@/components/shell/shell-actions';
import { adminApi } from '@/lib/admin/admin-api';
import type { ModelNames } from '@/lib/agents/format';
import { focusShellTarget } from '@/lib/focus';
import { builtinName } from '@/i18n/builtin-name';
import { libraryApi } from '@/lib/library/library-api';
import { recordAction } from '@/lib/library/record-action';
import { knowledgePath, libraryPath, recordPath } from '@/lib/shell-route';
import type { EditorMode } from './agent-fields';
import { useCopyRecord } from './copy-record';
import { DefinitionView } from './definition-view';
import { EditorHeaderActions } from './editor-header';
import { banText } from './library-row';
import { RecordLabel } from './record-label';
import { SelfLearningField } from './self-learning-field';

export type DeepAgentRecord = Extract<RecordDetail, { kind: 'deep_agent' }>;

export type DeepAgentCardProps = {
  /** `employee` — the owner in the library; `system` — the administrator on a company deep agent in the panel. */
  mode: EditorMode;
  record: DeepAgentRecord;
  /** The viewer's models and default chat model; the panel has none, and models are named by their ids there (as AL-03). */
  modelNames?: ModelNames;
};

/**
 * DA-13 «Карточка записи» (deep-agents UXRD): a deep agent its viewer may change, read-only — no fields and no
 * «Сохранить»; the chat changes it («Доработать в чате»). The header is the editor's (`EditorHeaderActions`), the
 * definition is `DefinitionView` «На странице», and «Самообучение» saves at once: the whole record by the same
 * `PUT` with the flag flipped and the version shown (deep-agents design-agent-types.md, C3 web). Text written by
 * other people is rendered as text only.
 */
export function DeepAgentCard({
  mode,
  record: opened,
  modelNames,
}: DeepAgentCardProps) {
  const system = mode === 'system';
  const client = system ? adminApi.library : libraryApi;
  const { libraryIndex } = useShellServices();
  const t = useTranslations('library');
  const format = useFormatter();
  const locale = useLocale();
  const titles = useAdminTitles();
  const copy = useCopyRecord();
  const copyErrorId = useId();
  const [record, setRecord] = useState(opened);
  const [sharing, setSharing] = useState(false);

  // UXRD «Порядок фокуса»: once the card is on screen, focus lands on its title.
  useEffect(() => {
    focusShellTarget('page-title');
  }, [record.id]);

  async function saveSelfLearning(selfLearning: boolean): Promise<void> {
    const { id, name, description, kind, content, version } = record;
    const saved = await recordAction(
      { recordId: id, kind, action: 'save', version },
      () =>
        client.save(id, {
          name,
          description,
          kind,
          content: { ...content, selfLearning },
          version,
        }),
    );
    if (saved.kind !== 'deep_agent')
      throw new Error(
        `library: the deep agent ${id} came back as a ${saved.kind}`,
      );
    setRecord(saved);
    void libraryIndex.refresh();
  }

  return (
    <div className="h-full overflow-y-auto">
      <PageHeader
        title={builtinName(record, locale)}
        area={system ? titles.panel : undefined}
        parent={
          system
            ? titles.parent('library')
            : { title: t('screen.title'), href: libraryPath() }
        }
      >
        <EditorHeaderActions
          mode={mode}
          record={record}
          changed={false}
          copyPending={copy.pending}
          copyErrorId={copy.error === null ? undefined : copyErrorId}
          onCopy={() => copy.copy(record)}
          onShared={(shared) =>
            setRecord((current) => ({
              ...current,
              audience: shared.audience,
              offerInChat: shared.offerInChat,
            }))
          }
          sharing={sharing}
          onSharingChange={setSharing}
        />
      </PageHeader>
      {copy.dialog}
      <div className="mx-auto flex w-full max-w-(--thread-max-width) flex-col gap-4 px-4 py-4 md:py-6">
        <div className="flex flex-col gap-1">
          <RecordLabel variant="under" summary={record} showSource={false} />
          {!system && (
            <p className="text-muted-foreground text-sm leading-5">
              {t('card.refineHint')}
            </p>
          )}
          {copy.error !== null && (
            <p
              id={copyErrorId}
              role="alert"
              className="text-destructive text-xs leading-4"
            >
              {copy.error}
            </p>
          )}
        </div>
        {record.ban !== null && (
          <div role="alert">
            <FormWarning>{banText(t, format, record.ban.closedAt)}</FormWarning>
          </div>
        )}
        <SelfLearningField
          checked={record.content.selfLearning}
          onSave={saveSelfLearning}
          // The panel's header has its own entry to the knowledge (`KnowledgeButton`).
          knowledgeHref={system ? null : knowledgePath(record.id)}
        />
        <DefinitionView
          definition={record}
          missingRights={record.missingRights}
          variant="page"
          recordHref={recordPath}
          modelNames={modelNames}
        />
      </div>
    </div>
  );
}
