'use client';

import { useEffect, useId, type ReactNode } from 'react';
import { LoaderCircle } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useStore } from 'zustand';
import type {
  LibraryChoices,
  MyModels,
  RecordDetail,
  RecordKind,
  RecordSummary,
} from '@agent-os/contracts';
import { useAdminRight } from '@/components/admin/admin-gate';
import { PageHeader } from '@/components/shell/page-header';
import { ShellLink } from '@/components/shell/shell-link';
import { useShellServices } from '@/components/shell/shell-actions';
import { ThreadNotice } from '@/components/shell/thread-notice';
import { Button, buttonVariants } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useResource, type Resource } from '@/hooks/use-resource';
import { accessApi } from '@/lib/access/access-api';
import { isNotFound } from '@/lib/admin/admin-errors';
import { formatModel, type ModelNames } from '@/lib/agents/format';
import { focusShellTarget } from '@/lib/focus';
import { builtinName } from '@/i18n/builtin-name';
import { libraryApi } from '@/lib/library/library-api';
import {
  canUseInChat,
  recipientNote,
  type AgentRecord,
} from '@/lib/library/record-rules';
import {
  adminRecordPath,
  libraryPath,
  newAgentPath,
  recordPath,
} from '@/lib/shell-route';
import { blankAgent } from './agent-fields';
import { useCopyRecord } from './copy-record';
import { DeepAgentCard, type DeepAgentRecord } from './deep-agent-card';
import { DefinitionView } from './definition-view';
import { RecordEditor, useCreatedHandoff } from './record-editor';
import { RecordLabel } from './record-label';
import { useInChat } from './use-in-chat';

/** Rows of the definition skeleton (UXRD RV-01, Loading). */
const SKELETON_ROWS = [0, 1, 2, 3] as const;

export type RecordPageProps = { id: string };

/**
 * The record page `/library/<id>` (UXRD Screen 2). The record is read on every entry (read-on-open), the
 * library list too, for «Может запускать» and the launch hint. Any 404 — a foreign personal, closed,
 * deleted or missing record — is the one screen RV-02, which names nothing of the record (ADR-0016).
 */
export function RecordPage({ id }: RecordPageProps) {
  const { libraryIndex } = useShellServices();
  const record = useResource(() => libraryApi.get(id), id, 'library');
  const created = useCreatedHandoff(recordPath(id));

  useEffect(() => {
    void libraryIndex.refresh();
  }, [libraryIndex]);

  if (isNotFound(record.error))
    return <ThreadNotice variant="library-not-found" />;
  if (record.status === 'error')
    return (
      <ThreadNotice variant="library-load-error" onRetry={record.reload} />
    );
  if (record.data === undefined) return <RecordSkeleton />;
  // An own record its owner may edit: an agent opens in the editor, a deep agent in its card (DA-13); company
  // records change only in the panel (Invariant 3).
  if (record.data.mine && record.data.canEdit) {
    if (record.data.kind === 'deep_agent')
      return <OwnDeepAgentPage record={record.data} />;
    return <EditorPage start={{ saved: record.data }} created={created} />;
  }
  return <RecordView record={record.data} />;
}

/** `/library/new/agent`: the empty agent editor; the library list is read on entry for «Может запускать». */
export function NewRecordPage() {
  const { libraryIndex } = useShellServices();
  const created = useCreatedHandoff(newAgentPath());

  useEffect(() => {
    void libraryIndex.refresh();
  }, [libraryIndex]);

  return <EditorPage start="new" created={created} />;
}

/**
 * The editor's data, read on open (design-web.md, «Данные экранов»): the author's systems and default model
 * (`choices`) and their models. The editor waits for `choices` — a new record takes its model and «Максимум шагов» from there;
 * the models fill the model field and its banner once read.
 */
function EditorPage({
  start,
  created,
}: {
  start: { saved: AgentRecord } | 'new';
  created: boolean;
}) {
  const choices = useResource(libraryApi.choices, 'choices', 'library');
  const models = useResource(accessApi.models, 'models', 'library');

  if (choices.status === 'error')
    return (
      <ThreadNotice variant="library-load-error" onRetry={choices.reload} />
    );
  if (choices.data === undefined) return <RecordSkeleton />;
  return (
    <RecordEditor
      mode="employee"
      source={start === 'new' ? { blank: blankAgent(choices.data) } : start}
      choices={{ ...choices.data, models: models.data?.models }}
      created={created}
    />
  );
}

/** DA-13 of one's own deep agent, with the viewer's models for the definition. */
function OwnDeepAgentPage({ record }: { record: DeepAgentRecord }) {
  const models = useResource(accessApi.models, 'models', 'library');
  const choices = useResource(libraryApi.choices, 'choices', 'library');
  return (
    <DeepAgentCard
      mode="employee"
      record={record}
      modelNames={modelNamesOf(models.data, choices.data)}
    />
  );
}

/**
 * RV-01 «Просмотр»: a record the viewer sees but does not edit. Only «Использовать в чате» (by the web's
 * rule) and «Скопировать себе» — no «Поделиться», «Удалить» or fields (Invariant 3). A colleague's record
 * carries the recipient's note above its definition. Other employees' text is rendered as text only.
 */
function RecordView({ record }: { record: RecordDetail }) {
  const tErrors = useTranslations('errors');
  const t = useTranslations('library');
  const locale = useLocale();
  const inChat = useInChat();
  const copy = useCopyRecord();
  const errorId = useId();
  const name = builtinName(record, locale);
  const usable = canUseInChat(record);
  const note = recipientNote(record);
  const recipient =
    note !== null && record.author !== null
      ? { author: record.author.name, roles: note.roles }
      : null;
  const missingModel = record.missingRights.find(
    (right) => right.subagent === null && right.model !== null,
  )?.model;
  const models = useResource(accessApi.models, 'models', 'library');
  const choices = useResource(libraryApi.choices, 'choices', 'library');
  const modelNames = modelNamesOf(models.data, choices.data);
  // `missingRights` names only models without a right; a model of a provider that does not work is the viewer's own.
  const ownModel = record.content.model;
  const brokenReason =
    ownModel === null
      ? null
      : (models.data?.models.find((row) => row.model === ownModel)
          ?.unavailableReason ?? null);
  // A company record changes only in the panel: an administrator gets the way there (RV-01).
  const inPanel = useAdminRight() === 'admin' && record.author === null;

  // UXRD «Порядок фокуса»: once the record is on screen, focus lands on its title.
  useEffect(() => {
    focusShellTarget('page-title');
  }, [record.id]);

  return (
    <div className="h-full overflow-y-auto">
      <PageHeader
        title={name}
        parent={{ title: t('screen.title'), href: libraryPath() }}
      >
        {usable && (
          <Button
            size="sm"
            className="pointer-coarse:h-11"
            onClick={() =>
              inChat({ record: { id: record.id, kind: record.kind, name } })
            }
          >
            {t('row.useInChat')}
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          disabled={copy.pending}
          aria-describedby={copy.error === null ? undefined : errorId}
          className="pointer-coarse:h-11"
          onClick={() => copy.copy(record)}
        >
          {copy.pending && (
            <LoaderCircle
              aria-hidden
              className="animate-spin motion-reduce:animate-none"
            />
          )}
          {t('row.copy')}
        </Button>
        {inPanel && (
          <ShellLink
            href={adminRecordPath('library', record.id)}
            className={buttonVariants({
              variant: 'outline',
              size: 'sm',
              className: 'pointer-coarse:h-11',
            })}
          >
            {t('row.openInPanel')}
          </ShellLink>
        )}
      </PageHeader>
      {copy.dialog}
      <div className="mx-auto flex w-full max-w-(--thread-max-width) flex-col gap-4 px-4 py-4 md:py-6">
        <div className="flex flex-col gap-1">
          <RecordLabel variant="under" summary={record} />
          {usable ? (
            <Hint>
              <LaunchHint record={record} />
            </Hint>
          ) : (
            !record.mine &&
            record.author !== null &&
            !record.offerInChat && (
              <Hint>{t('recordPage.readOnly', { kind: record.kind })}</Hint>
            )
          )}
          {missingModel != null && (
            <ModelHint
              model={missingModel}
              kind={record.kind}
              models={models}
            />
          )}
          {brokenReason !== null && ownModel !== null && (
            // model-providers UXRD MC-12 with the MC-9 words.
            <Hint>
              {tErrors(`providerNotStarting.${brokenReason}`, {
                model: formatModel(ownModel, modelNames),
                kind: record.kind,
              })}
            </Hint>
          )}
          {copy.error !== null && (
            <p
              id={errorId}
              role="alert"
              className="text-destructive text-xs leading-4"
            >
              {copy.error}
            </p>
          )}
        </div>
        <DefinitionView
          definition={record}
          missingRights={record.missingRights}
          variant="page"
          recipient={recipient}
          recordHref={recordPath}
          modelNames={modelNames}
        />
      </div>
    </div>
  );
}

function Hint({ children }: { children: ReactNode }) {
  return <p className="text-muted-foreground text-sm leading-5">{children}</p>;
}

/**
 * MC-6 launch hint of a record the chat may run: one's own; a colleague's, or, when the viewer has an own
 * record or several others of that kind under the same name, which one the chat will pick. Names compare
 * without case, as the server does.
 */
function LaunchHint({ record }: { record: RecordDetail }) {
  const { libraryIndex } = useShellServices();
  const records = useStore(libraryIndex, (state) => state.records);
  const t = useTranslations('library');
  if (record.mine) return <>{t('editor.launchHint', { kind: record.kind })}</>;
  const namesakes = namesakesOf(record, records);
  if (namesakes.some((other) => other.mine))
    return <>{t('recordPage.ownNamesake', { kind: record.kind })}</>;
  if (namesakes.length > 0) return <>{t('recordPage.severalNamesakes')}</>;
  return <>{t('recordPage.colleagueHint', { kind: record.kind })}</>;
}

function namesakesOf(
  record: RecordDetail,
  records: ReadonlyMap<string, RecordSummary> | null,
): RecordSummary[] {
  if (records === null) return [];
  const name = record.name.toLowerCase();
  return [...records.values()].filter(
    (other) =>
      other.id !== record.id &&
      other.kind === record.kind &&
      other.name.toLowerCase() === name,
  );
}

/** The models and default model the view has read; the default stays unknown until `choices` is read. */
function modelNamesOf(
  models: MyModels | undefined,
  choices: LibraryChoices | undefined,
): ModelNames {
  const rows = models?.models ?? [];
  return choices === undefined
    ? { models: rows }
    : { models: rows, defaultModel: choices.defaultModel };
}

/**
 * MC-6 model line: the record's model is not the viewer's. Whether the viewer has any model at all decides
 * between the two lines; until the viewer's models are read nothing is shown, and a failed read (logged by
 * `useResource`) shows the line of a copy that gets the viewer's model.
 */
function ModelHint({
  model,
  kind,
  models,
}: {
  model: string;
  kind: RecordKind;
  models: Resource<MyModels>;
}) {
  const t = useTranslations('library.recordPage');
  if (models.status === 'loading') return null;
  const none = models.data !== undefined && models.data.models.length === 0;
  return (
    <Hint>
      {t(none ? 'noModels' : 'modelMissing', {
        model: formatModel(model),
        kind,
      })}
    </Hint>
  );
}

/** RV-01 Loading: the header's actions and the definition rows as skeletons. */
export function RecordSkeleton() {
  return (
    <div
      aria-busy
      className="mx-auto flex w-full max-w-(--thread-max-width) flex-col gap-4 px-4 py-4 md:py-6"
    >
      <div aria-hidden className="flex flex-col gap-2">
        <Skeleton className="h-5 w-2/5" />
        <Skeleton className="h-3 w-3/5" />
      </div>
      <div aria-hidden className="flex flex-col gap-3">
        {SKELETON_ROWS.map((row) => (
          <div key={row} className="flex flex-col gap-1.5">
            <Skeleton className="h-3 w-1/5" />
            <Skeleton className="h-4 w-4/5" />
          </div>
        ))}
      </div>
    </div>
  );
}
