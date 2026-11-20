'use client';

import { useId, useRef, useState } from 'react';
import { PlugIcon, PlusIcon } from 'lucide-react';
import { toast } from 'sonner';
import {
  modelProvider,
  ModelProviderErrorCode,
  type CatalogModel,
  type ModelDefaults,
  type ModelProviderCheck,
  type ModelProviderView,
} from '@agent-os/contracts';
import { StateBadge } from '@/components/state-badge';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import type { Resource } from '@/hooks/use-resource';
import { formatModel, formatTime } from '@/lib/agents/format';
import { adminApi } from '@/lib/admin/admin-api';
import { isNotFound, rereadOnNotFound } from '@/lib/admin/admin-errors';
import { MODEL_PROVIDERS_TEXT as TEXT, MODELS_TEXT } from '@/lib/admin/admin-texts';
import { PROVIDER_KIND_TEXT } from '@/lib/admin/model-providers';
import { describeApiError, isApiRequestError } from '@/lib/api/api-request';
import { logger } from '@/lib/logger';
import { cn } from '@/lib/utils';
import { CAPTION, CONTROL_SIZE } from '../admin-form';
import { ConfirmDialog } from '../confirm-dialog';
import {
  DataTable,
  resourceTableState,
  type DataTableColumn,
  type DataTableResult,
  type DataTableRow,
} from '../data-table';
import { SavingSwitch } from '../saving-switch';
import { ModelProviderDialog } from './model-provider-dialog';

const COLUMNS: readonly DataTableColumn[] = [
  { header: TEXT.provider },
  { header: TEXT.kind },
  { header: TEXT.key },
  { header: TEXT.models, align: 'end' },
  { header: TEXT.enabled },
];

const CHECK_EVENT = 'admin: model provider check';

/** Starts a stopwatch; the returned function gives the milliseconds since. */
const startTimer = (): (() => number) => {
  const started = performance.now();
  return () => Math.round(performance.now() - started);
};

/** A dialog keeps its provider while it closes, so its content does not change during the exit animation. */
type DialogState = { open: boolean; provider: ModelProviderView | null };

const CLOSED: DialogState = { open: false, provider: null };

/** MC-6: the line under the row once the server answered the check. */
function checkResultOf(name: string, { result, message }: ModelProviderCheck, checkedAt: Date): DataTableResult {
  switch (result) {
    case 'works':
      return {
        state: 'ok',
        badge: TEXT.works,
        text: TEXT.checkedAt(formatTime(checkedAt)),
        announcement: TEXT.worksName(name),
      };
    case 'key_rejected':
      return { state: 'failed', text: TEXT.keyRejected(message), announcement: TEXT.keyRejectedName(name) };
    case 'unreachable':
      return { state: 'failed', text: TEXT.unreachable(message), announcement: TEXT.unreachableName(name) };
  }
}

/** MC-6, design-web «Отличия от UXRD»: the check never reached an answer about the provider. */
function checkRefusalOf(name: string, error: unknown): DataTableResult {
  const network = isApiRequestError(error) && error.kind === 'network';
  const text = network
    ? TEXT.checkNoConnection
    : TEXT.checkFailed(error instanceof Error ? error.message : String(error));
  return { state: 'failed', text, announcement: TEXT.checkFailedName(name) };
}

/** MC-3: the consequence of switching off the provider of a default model; empty — no confirmation needed. */
function offConsequences(
  provider: ModelProviderView,
  defaults: ModelDefaults | undefined,
  catalog: readonly CatalogModel[] | undefined,
): string[] {
  const names = { models: (catalog ?? []).map((model) => ({ model: model.id, name: model.name })) };
  const chat = defaults?.chatModel ?? null;
  const embedding = defaults?.embeddingModel ?? null;
  const phrases: string[] = [];
  if (chat !== null && modelProvider(chat) === provider.name) phrases.push(TEXT.offChat(formatModel(chat, names)));
  if (embedding !== null && modelProvider(embedding) === provider.name) {
    phrases.push(TEXT.offEmbedding(formatModel(embedding, names)));
  }
  return phrases;
}

/** MC-3 «Ключ»: the key's last four, «Нужен ключ» when the kind needs one (`keyRequired` from `core`), or «без ключа». */
function KeyCell({ provider }: { provider: ModelProviderView }) {
  if (provider.apiKeySet) {
    const last4 = provider.apiKeyLast4 ?? '';
    return (
      <span>
        <span aria-hidden className="font-mono">
          {TEXT.keyEnding(last4)}
        </span>
        <span className="sr-only">{TEXT.keyEndingName(last4)}</span>
      </span>
    );
  }
  if (provider.keyRequired) {
    return (
      <span>
        <span aria-hidden>
          <StateBadge state="action">{TEXT.keyNeeded}</StateBadge>
        </span>
        <span className="sr-only">{TEXT.keyNeededName}</span>
      </span>
    );
  }
  return <span className="text-muted-foreground">{TEXT.noKey}</span>;
}

type ModelProvidersTableProps = {
  providers: Resource<ModelProviderView[]>;
  /** `undefined` while its read is loading or failed: then switching off asks nothing. */
  defaults: ModelDefaults | undefined;
  /** Names the default models in the switch-off confirmation; `undefined` — they read by id. */
  catalog: readonly CatalogModel[] | undefined;
  /** Re-reads the whole «Модели» section after any change of this block (KD-1). */
  reloadAll: () => void;
};

/**
 * UXRD MP-02, MP-05, MP-07: the model providers in the server's order with key, models count and «Включён»;
 * the «⋯» menu edits, checks the connection and removes. A check's outcome is this table's state for as long as
 * the page is open, and re-reads nothing.
 */
export function ModelProvidersTable({ providers, defaults, catalog, reloadAll }: ModelProvidersTableProps) {
  const headingId = useId();
  const sectionRef = useRef<HTMLElement>(null);
  // The provider dialog (MP-04) opens from «Добавить провайдера» and «Изменить» with this state.
  const [editing, setEditing] = useState<DialogState>(CLOSED);
  const [turningOff, setTurningOff] = useState<DialogState>(CLOSED);
  const [blocked, setBlocked] = useState<DialogState>(CLOSED);
  const [removing, setRemoving] = useState<DialogState>(CLOSED);
  const [results, setResults] = useState<Readonly<Record<string, DataTableResult>>>({});
  // The menu item is unavailable while a check runs; this also stops a second start from elsewhere.
  const checking = useRef(new Set<string>());

  const setResult = (name: string, result: DataTableResult | null): void =>
    setResults((current) => {
      const next = { ...current };
      if (result === null) delete next[name];
      else next[name] = result;
      return next;
    });

  const checkConnection = async (name: string): Promise<void> => {
    if (checking.current.has(name)) return;
    checking.current.add(name);
    // Pending first: the `status` region then announces the outcome as a change of its text.
    setResult(name, { state: 'pending', text: TEXT.checking, announcement: TEXT.checkingName(name) });
    const durationMs = startTimer();
    try {
      const check = await adminApi.modelProviders.check(name);
      // The provider's `message` is a foreign system's text: it is shown, never logged.
      logger.info(CHECK_EVENT, { provider: name, result: check.result, durationMs: durationMs() });
      setResult(name, checkResultOf(name, check, new Date()));
    } catch (error) {
      const where = { provider: name, durationMs: durationMs() };
      if (isApiRequestError(error)) logger.warn(`${CHECK_EVENT}: refused`, { ...where, ...describeApiError(error) });
      else logger.error(`${CHECK_EVENT}: failed`, { ...where, error });
      if (isNotFound(error)) {
        // The provider is gone: the re-read takes its row away, and the outcome with it.
        setResult(name, null);
        reloadAll();
      } else {
        setResult(name, checkRefusalOf(name, error));
      }
    } finally {
      checking.current.delete(name);
    }
  };

  /** The notice's «Проверить подключение» (UXRD Accessibility): focus goes to the row's «⋯», then the check runs. */
  const checkFromNotice = (name: string): void => {
    sectionRef.current
      ?.querySelector<HTMLElement>(`tr[data-row-key="${CSS.escape(name)}"] [aria-haspopup="menu"]`)
      ?.focus();
    void checkConnection(name);
  };

  const saveEnabled = async (name: string, enabled: boolean): Promise<void> => {
    await rereadOnNotFound(reloadAll)(() => adminApi.modelProviders.update(name, { enabled }));
    reloadAll();
  };

  const removeProvider = async (name: string): Promise<void> => {
    try {
      await adminApi.modelProviders.remove(name);
    } catch (error) {
      // Flow 3: a model added after the read — the dialog keeps the refusal, the section shows the new count.
      if (isApiRequestError(error) && error.code === ModelProviderErrorCode.MODEL_PROVIDER_HAS_MODELS) {
        reloadAll();
        throw error;
      }
      // A provider already gone is the outcome asked for; the re-read shows it.
      if (!isNotFound(error)) throw error;
      logger.warn('admin: model provider remove: already gone', describeApiError(error));
    }
    reloadAll();
    toast.success(TEXT.removed);
  };

  const toRow = (provider: ModelProviderView): DataTableRow => {
    const consequences = provider.enabled ? offConsequences(provider, defaults, catalog) : [];
    return {
      key: provider.name,
      name: provider.name,
      cells: [
        <span key="provider" className="flex min-w-0 flex-col py-1">
          <span className="truncate font-mono" title={provider.name}>
            {provider.name}
          </span>
          {provider.baseUrl === null ? (
            <span className={cn(CAPTION, 'truncate text-muted-foreground')}>{TEXT.defaultUrl}</span>
          ) : (
            <span className={cn(CAPTION, 'truncate font-mono text-muted-foreground')} title={provider.baseUrl}>
              {provider.baseUrl}
            </span>
          )}
        </span>,
        PROVIDER_KIND_TEXT[provider.kind].label,
        <KeyCell key="key" provider={provider} />,
        String(provider.catalogModels),
        <SavingSwitch
          key="enabled"
          label={TEXT.enabledSwitch(provider.name)}
          labelHidden
          checked={provider.enabled}
          onSave={(enabled) => saveEnabled(provider.name, enabled)}
          logEvent="admin: model provider enable"
          confirmOff={consequences.length > 0 ? () => setTurningOff({ open: true, provider }) : undefined}
        />,
      ],
      actions: [
        { label: TEXT.edit, onSelect: () => setEditing({ open: true, provider }) },
        {
          label: TEXT.check,
          onSelect: () => void checkConnection(provider.name),
          disabled: results[provider.name]?.state === 'pending',
        },
        {
          label: TEXT.remove,
          onSelect: () =>
            provider.catalogModels > 0 ? setBlocked({ open: true, provider }) : setRemoving({ open: true, provider }),
        },
      ],
      result: results[provider.name],
    };
  };

  const state = resourceTableState(providers, TEXT.loadFailed, (data) => ({
    rows: data.map(toRow),
    empty: { Icon: PlugIcon, title: TEXT.empty, description: TEXT.emptyDescription },
  }));

  const offProvider = turningOff.provider;
  const blockedProvider = blocked.provider;
  const removedProvider = removing.provider;

  return (
    <section ref={sectionRef} aria-labelledby={headingId} className="flex flex-col gap-3">
      {/* Below 768 px the button goes on its own line under the heading. */}
      <div className="flex flex-col items-start gap-2 md:flex-row md:items-center md:justify-between">
        <h2 id={headingId} className="text-base leading-6 font-semibold">
          {MODELS_TEXT.providersTitle}
        </h2>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={CONTROL_SIZE}
          onClick={() => setEditing({ open: true, provider: null })}
        >
          <PlusIcon aria-hidden />
          {MODELS_TEXT.addProvider}
        </Button>
      </div>
      <DataTable caption={MODELS_TEXT.providersTitle} columns={COLUMNS} state={state} actionsAs="menu" />
      <ModelProviderDialog
        open={editing.open}
        onOpenChange={(open) => setEditing((current) => ({ ...current, open }))}
        provider={editing.provider}
        reloadAll={reloadAll}
        checkConnection={checkFromNotice}
      />
      {offProvider !== null && (
        <ConfirmDialog
          open={turningOff.open}
          onOpenChange={(open) => setTurningOff((current) => ({ ...current, open }))}
          title={TEXT.offTitle(offProvider.name)}
          body={offConsequences(offProvider, defaults, catalog).join(' ')}
          confirmLabel={TEXT.off}
          onConfirm={() => saveEnabled(offProvider.name, false)}
          logEvent="admin: model provider enable"
        />
      )}
      {blockedProvider !== null && (
        <AlertDialog open={blocked.open} onOpenChange={(open) => setBlocked((current) => ({ ...current, open }))}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle className="wrap-break-word">{TEXT.cannotRemoveTitle(blockedProvider.name)}</AlertDialogTitle>
              <AlertDialogDescription className="wrap-break-word">
                {TEXT.cannotRemoveBody(blockedProvider.catalogModels)}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel variant="default" size="sm" className={CONTROL_SIZE}>
                {TEXT.understood}
              </AlertDialogCancel>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
      {removedProvider !== null && (
        <ConfirmDialog
          open={removing.open}
          onOpenChange={(open) => setRemoving((current) => ({ ...current, open }))}
          title={TEXT.removeTitle(removedProvider.name)}
          body={TEXT.removeBody}
          confirmLabel={TEXT.remove}
          onConfirm={() => removeProvider(removedProvider.name)}
          logEvent="admin: model provider remove"
          // The row and its «⋯», which opened the dialog, leave with the provider.
          focusTitleAfterConfirm
        />
      )}
    </section>
  );
}
