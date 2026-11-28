'use client';

import { useEffect, useId, useState, type ReactNode } from 'react';
import { LoaderCircle } from 'lucide-react';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { RECORD_SKILLS_MAX, type RecordDetail } from '@agent-os/contracts';
import { FormWarning } from '@/components/admin/admin-form';
import { useAdminTitles } from '@/components/admin/admin-header';
import { PageHeader } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useShellServices } from '@/components/shell/shell-actions';
import { adminApi } from '@/lib/admin/admin-api';
import type { ModelNames } from '@/lib/agents/format';
import { focusShellTarget } from '@/lib/focus';
import { builtinName } from '@/i18n/builtin-name';
import { libraryApi } from '@/lib/library/library-api';
import { describeLibraryError } from '@/lib/library/library-errors';
import { recordAction } from '@/lib/library/record-action';
import { libraryPath, memoryPath, recordPath } from '@/lib/shell-route';
import { AgentsField, type EditorMode } from './agent-fields';
import { AgentScripts } from './agent-script';
import { useCopyRecord } from './copy-record';
import { DefinitionView } from './definition-view';
import { EditorHeaderActions } from './editor-header';
import { banText } from './library-row';
import { RecordLabel } from './record-label';
import { SelfLearningField } from './self-learning-field';
import { TrainingBlock } from './training-block';

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
 * definition is `DefinitionView` «На странице», and «Самообучение» and the scripts (self-learning KD-5) save at
 * once: the whole record by the same `PUT` with the content changed and the version shown (deep-agents design-agent-types.md, C3 web). Text written by
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

  async function saveContent(
    change: Partial<DeepAgentRecord['content']>,
  ): Promise<void> {
    const { id, name, description, kind, content, version } = record;
    const saved = await recordAction(
      { recordId: id, kind, action: 'save', version },
      () =>
        client.save(id, {
          name,
          description,
          kind,
          content: { ...content, ...change },
          version,
        }),
    );
    show(saved);
    void libraryIndex.refresh();
  }

  function show(answer: RecordDetail): void {
    if (answer.kind !== 'deep_agent')
      throw new Error(
        `library: the deep agent ${answer.id} came back as a ${answer.kind}`,
      );
    setRecord(answer);
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
        {/* A default agent never learns (self-learning KD-4): no switch. */}
        {record.builtinKey === null && (
          <>
            <SelfLearningField
              checked={record.content.selfLearning}
              onSave={(selfLearning) => saveContent({ selfLearning })}
              // The panel's header has its own entry to the memory (`MemoryButton`).
              memoryHref={system ? null : memoryPath(record.id)}
            />
            <TrainingBlock
              id={record.id}
              selfLearning={record.content.selfLearning}
            />
          </>
        )}
        <DefinitionView
          definition={record}
          missingRights={record.missingRights}
          variant="page"
          recordHref={recordPath}
          modelNames={modelNames}
          connectedSkills={record.connectedSkills}
          skillsAction={
            <SkillsDialog
              record={record}
              system={system}
              onSave={(skills) => saveContent({ skills })}
            />
          }
        />
        <AgentScripts
          scripts={record.content.scripts}
          edit={{
            subagents: record.content.subagents.map(
              (subagent) => subagent.name,
            ),
            onSave: (scripts) => saveContent({ scripts }),
            onReread: async () => show(await client.get(record.id)),
          }}
        />
      </div>
    </div>
  );
}

/**
 * SP-02 (agent-guidance UXRD, MC-14, MC-16): «Изменить» under the row «Скиллы» opens «Скиллы «{имя}»» with the
 * field «Скиллы»; «Сохранить» saves the list through the card's `saveContent`, closes the window and says so. The
 * limit is checked before sending; a refusal stays at the field.
 */
function SkillsDialog({
  record,
  system,
  onSave,
}: {
  record: DeepAgentRecord;
  system: boolean;
  onSave: (skills: string[]) => Promise<void>;
}) {
  const t = useTranslations('library');
  const tErrors = useTranslations('errors');
  const tCommon = useTranslations('common');
  const locale = useLocale();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [skills, setSkills] = useState<string[]>(record.content.skills);
  const [error, setError] = useState<ReactNode>(undefined);
  const [saving, setSaving] = useState(false);

  const start = (next: boolean): void => {
    if (saving) return;
    if (next) {
      setSkills(record.content.skills);
      setError(undefined);
    }
    setOpen(next);
  };

  async function save(): Promise<void> {
    if (saving) return;
    if (skills.length > RECORD_SKILLS_MAX) {
      setError(
        t('agentFields.checks.tooManySkills', { max: RECORD_SKILLS_MAX }),
      );
      return;
    }
    setSaving(true);
    try {
      await onSave(skills);
      setOpen(false);
      toast.success(t('skillFields.saved'));
    } catch (cause) {
      // `recordAction` has logged the refusal.
      setError(
        describeLibraryError(tErrors, cause, {
          where: 'editor',
          admin: system,
          kind: record.kind,
          name: record.name,
        }).text,
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={start}>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-fit pointer-coarse:h-11"
        onClick={() => start(true)}
      >
        {t('skillFields.change')}
      </Button>
      <DialogContent size="full-narrow">
        <DialogHeader>
          <DialogTitle>
            {t('skillFields.dialogTitle', {
              name: builtinName(record, locale),
            })}
          </DialogTitle>
        </DialogHeader>
        <fieldset disabled={saving} className="contents">
          <AgentsField
            id={`${id}-skills`}
            kind="skill"
            recordId={record.id}
            chosen={skills}
            error={error}
            onChange={(next) => {
              setSkills(next);
              setError(undefined);
            }}
          />
        </fieldset>
        <DialogFooter>
          <DialogClose
            render={
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="pointer-coarse:h-11"
              />
            }
            disabled={saving}
          >
            {tCommon('cancel')}
          </DialogClose>
          <Button
            type="button"
            size="sm"
            className="pointer-coarse:h-11"
            aria-busy={saving || undefined}
            onClick={() => void save()}
          >
            {saving && (
              <LoaderCircle
                aria-hidden
                className="animate-spin motion-reduce:animate-none"
              />
            )}
            {t('share.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
