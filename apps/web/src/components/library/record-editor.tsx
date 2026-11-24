'use client';

import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useRouter } from 'next/navigation';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  ALL_SERVERS,
  CHAT_BUILTIN_KEY,
  TRAINER_BUILTIN_KEY,
  type RecordDetail,
} from '@agent-os/contracts';
import { CAPTION, FormError, FormWarning } from '@/components/admin/admin-form';
import { useAdminTitles } from '@/components/admin/admin-header';
import { PageHeader } from '@/components/shell/page-header';
import { useShellServices } from '@/components/shell/shell-actions';
import { ThreadNotice } from '@/components/shell/thread-notice';
import { adminApi } from '@/lib/admin/admin-api';
import { focusShellTarget } from '@/lib/focus';
import { libraryApi } from '@/lib/library/library-api';
import { builtinName } from '@/i18n/builtin-name';
import {
  describeLibraryError,
  type LibraryErrorText,
} from '@/lib/library/library-errors';
import { RecordConflictError, recordAction } from '@/lib/library/record-action';
import {
  canUseInChat,
  changedFieldLabel,
  type AgentDefinition,
  type AgentRecord,
} from '@/lib/library/record-rules';
import { adminRecordPath, libraryPath, recordPath } from '@/lib/shell-route';
import { cn } from 'cn';
import {
  AgentFields,
  validateAgent,
  type AgentField,
  type AgentFieldErrors,
  type EditorChoices,
  type EditorMode,
} from './agent-fields';
import { useCopyRecord } from './copy-record';
import { EditorHeaderActions } from './editor-header';
import { banText } from './library-row';
import { RecordLabel } from './record-label';
import { ConflictBlock, SavePanel } from './save-panel';
import { useInChat } from './use-in-chat';
import { useRecordForm } from './use-record-form';

/** The editor's two starts: an own agent as saved, or the blank definition of a new one. */
export type RecordEditorSource =
  { saved: AgentRecord } | { blank: AgentDefinition };

/** The library's routes of the owner, or the panel's of the administrator on a company record. */
function clientOf(mode: EditorMode) {
  return mode === 'system' ? adminApi.library : libraryApi;
}

export type RecordEditorProps = {
  /** `employee` — the owner in the library; `system` — the administrator on a company record in the panel (AL-02). */
  mode: EditorMode;
  source: RecordEditorSource;
  choices: EditorChoices;
  /** What the page took on mount (`useCreatedHandoff`): the record was just created on the previous address. */
  created: boolean;
};

/** Server errors at a field of the form; the rest show above the panel. */
function fieldErrorOf(error: LibraryErrorText | null): AgentFieldErrors {
  if (error === null || error.place.at !== 'field') return {};
  return { [error.place.field]: error.text };
}

/** The system a 422 `server_not_allowed` is about: the first ticked one outside the author's systems. */
function refusedServer(
  definition: AgentDefinition,
  allowed: readonly string[],
): { server?: string } {
  const server = definition.content.servers.find(
    (name) => name !== ALL_SERVERS && !allowed.includes(name),
  );
  return server === undefined ? {} : { server };
}

function formErrorOf(error: LibraryErrorText | null): ReactNode {
  if (error === null || error.place.at === 'screen') return null;
  if (Object.keys(fieldErrorOf(error)).length > 0) return null;
  return error.text;
}

/**
 * Whether the record was just created on the previous address (design-web.md, KD-6), read when the page component
 * mounts, before the page's data is read, so leaving during loading or after a failed read still drops it. The
 * read has no side effect (a StrictMode double mount runs it twice); the handoff is taken once in an effect. A
 * handoff of another page is dropped there too: that page was left.
 */
export function useCreatedHandoff(page: string | null): boolean {
  const { createdHandoff } = useShellServices();
  const [created] = useState(
    () => page !== null && createdHandoff.getState().page === page,
  );
  const taken = useRef(false);
  useEffect(() => {
    if (taken.current || page === null) return;
    taken.current = true;
    createdHandoff.take(page);
  }, [page, createdHandoff]);
  return created;
}

/**
 * The record editor (design-web.md, KD-3, Flow 1; record-editor.md; UXRD ED-01): the form's state is
 * `useRecordForm`, the saves go through `recordAction`, and nothing leaves the editor as an event — it
 * calls the library client and moves between addresses itself. A save carries only the form's version
 * (Invariant 2); an error, a conflict or a refusal never touches the typed values (Invariant 1). While the
 * form has changes, `leaveGuard` holds them (DC-2). Text written by other employees is rendered as text only.
 */
export function RecordEditor({
  mode,
  source,
  choices,
  created,
}: RecordEditorProps) {
  const system = mode === 'system';
  const client = clientOf(mode);
  const { libraryIndex, leaveGuard, announcer, createdHandoff } =
    useShellServices();
  const router = useRouter();
  const inChat = useInChat();
  const copy = useCopyRecord();
  const copyErrorId = useId();
  const format = useFormatter();
  const locale = useLocale();
  const t = useTranslations('errors');
  const tLibrary = useTranslations('library');
  const titles = useAdminTitles();
  const { state, view, dispatch } = useRecordForm(source);
  const { saved, values, base } = state;
  const [checked, setChecked] = useState<AgentFieldErrors>({});
  const [conflictError, setConflictError] =
    useState<RecordConflictError | null>(null);
  const [shared, setShared] = useState<RecordDetail | null>(null);
  /** The share dialog: the header's button and MC-18's notice after a company record is created open it. */
  const [sharing, setSharing] = useState(false);
  const [gone, setGone] = useState(false);
  /** Grows with every set of field errors shown, so focus moves to the first of them again. */
  const [errorsShown, setErrorsShown] = useState(0);
  const formRef = useRef<HTMLFormElement>(null);
  const useInChatRef = useRef<HTMLButtonElement>(null);

  const changed = view.changed.length > 0;
  const saving = view.status === 'saving';
  // The audience of the last share; a later save answers with the record as it is now.
  const record =
    saved !== null && shared !== null && shared.version >= saved.version
      ? { ...saved, audience: shared.audience, offerInChat: shared.offerInChat }
      : saved;
  const errors: AgentFieldErrors = { ...checked, ...fieldErrorOf(state.error) };
  const formError = formErrorOf(state.error);

  // UXRD «Порядок фокуса»: the page's title once the editor is on screen.
  useEffect(() => {
    focusShellTarget('page-title');
  }, []);

  // A record just created opens «Сохранено». MC-18: nobody but administrators sees a new company record yet;
  // the notice's «Поделиться» opens this editor's dialog.
  const createdShown = useRef(false);
  useEffect(() => {
    if (createdShown.current || !created || !('saved' in source)) return;
    createdShown.current = true;
    dispatch({ type: 'saved', record: source.saved });
    if (system) {
      toast(tLibrary('editor.onlyAdmins', { kind: source.saved.kind }), {
        action: {
          label: tLibrary('editor.share'),
          onClick: () => setSharing(true),
        },
      });
    }
  }, [created, source, system, dispatch, tLibrary]);

  // DC-2: hold the unsaved changes while they exist, under the saved name («» for a new record).
  const heldName = saved === null ? '' : builtinName(saved, locale);
  useEffect(() => {
    if (changed && !gone) leaveGuard.hold(heldName);
    else leaveGuard.release();
  }, [changed, gone, heldName, leaveGuard]);
  useEffect(() => () => leaveGuard.release(), [leaveGuard]);

  // Runs after the commit that shows the errors (and unfolds «Дополнительно»), so the field can take focus.
  useEffect(() => {
    if (errorsShown === 0) return;
    formRef.current
      ?.querySelector<HTMLElement>('[aria-invalid="true"]')
      ?.focus();
  }, [errorsShown]);

  // UXRD: after «Сохранить» the focus goes to the button that took its place.
  useEffect(() => {
    if (view.status === 'saved') useInChatRef.current?.focus();
  }, [view.status]);

  if (gone) return <ThreadNotice variant="library-not-found" />;

  const input = (next: AgentDefinition, field: AgentField | null): void => {
    dispatch({ type: 'input', values: next });
    if (field === null) return;
    // The check's error at the edited field goes; a server's stays until the next save (use-record-form).
    setChecked((current) => {
      const next = { ...current };
      delete next[field];
      return next;
    });
  };

  /** One `POST` or `PUT` with `version`; the outcome goes to the form, the conflict to MC-10. */
  async function send(
    definition: AgentDefinition,
    version: number | null,
  ): Promise<void> {
    try {
      if (saved === null) {
        const record = agentOf(
          await recordAction(
            {
              recordId: null,
              kind: definition.kind,
              action: 'create',
              version: null,
            },
            () => client.create(definition),
          ),
        );
        dispatch({ type: 'saved', record });
        void libraryIndex.refresh();
        const nextPage = system
          ? adminRecordPath('library', record.id)
          : recordPath(record.id);
        // The new page's editor takes what it shows: «Сохранено», or MC-18's notice of a company record.
        createdHandoff.put(nextPage);
        if (!system)
          toast.success(tLibrary('editor.created', { kind: record.kind }));
        // The form is saved: nothing is held, so the new address replaces this one without a question.
        leaveGuard.release();
        router.replace(nextPage);
        return;
      }
      const result = agentOf(
        await recordAction(
          {
            recordId: saved.id,
            kind: definition.kind,
            action: 'save',
            version,
            readSaved: () => client.get(saved.id),
          },
          () =>
            client.save(saved.id, {
              ...definition,
              version: version ?? saved.version,
            }),
        ),
      );
      dispatch({ type: 'saved', record: result });
      void libraryIndex.refresh();
      announcer.getState().announce('announce.saved');
    } catch (cause) {
      // `recordAction` has logged the refusal.
      if (cause instanceof RecordConflictError) {
        setConflictError(cause);
        dispatch({
          type: 'conflict',
          saved: cause.saved?.kind === 'agent' ? cause.saved : null,
        });
        return;
      }
      const text = describeLibraryError(t, cause, {
        where: 'editor',
        admin: system,
        kind: definition.kind,
        name: definition.name,
        model: definition.content.model ?? undefined,
        ...refusedServer(definition, choices.servers),
      });
      if (text.place.at === 'screen') {
        setGone(true);
        return;
      }
      dispatch({ type: 'failed', error: text });
      setErrorsShown((count) => count + 1);
    }
  }

  /** The checks before sending: a field error stops the save and takes the focus. */
  const passes = (): boolean => {
    const found = validateAgent(values);
    setChecked(found);
    if (Object.keys(found).length === 0) return true;
    setErrorsShown((count) => count + 1);
    return false;
  };

  /** «Сохранить» / «Создать», Ctrl+S; in a conflict — «Сохранить мои правки». */
  const save = (): void => {
    if (saving || !changed) return;
    if (view.status === 'conflict') {
      saveMine();
      return;
    }
    if (!passes()) return;
    dispatch({ type: 'save' });
    void send(values, view.version);
  };

  /** Saves the typed values over the version saved elsewhere, as its next version (Flow 1). */
  const saveMine = (): void => {
    if (saving || !passes()) return;
    const version = view.conflict?.saved?.version ?? view.version;
    dispatch({ type: 'saveMine' });
    void send(values, version);
  };

  const withRestore = (): void => {
    toast(tLibrary('editor.discarded'), {
      action: {
        label: tLibrary('editor.restore'),
        onClick: () => dispatch({ type: 'restore' }),
      },
    });
  };

  const discard = (): void => {
    dispatch({ type: 'discard' });
    setChecked({});
    withRestore();
  };

  const takeSaved = (): void => {
    dispatch({ type: 'takeSaved' });
    setChecked({});
    withRestore();
  };

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    save();
  };

  // Ctrl+S / Cmd+S while the focus is inside the form, not a shortcut of the shell.
  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>): void => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      save();
    }
  };

  const title =
    record === null
      ? tLibrary('editor.newTitle', { kind: values.kind })
      : builtinName(record, locale);
  // The panel offers no «Использовать в чате» and no owner's launch hint (record-editor.md, «Системная»).
  const usable = !system && record !== null && canUseInChat(record);
  const everyoneGets =
    system &&
    record !== null &&
    (record.audience.everyone === true ||
      record.builtinKey === CHAT_BUILTIN_KEY ||
      record.builtinKey === TRAINER_BUILTIN_KEY);
  const conflictText =
    view.conflict === null || conflictError === null
      ? null
      : describeLibraryError(t, conflictError, {
          where: 'editor',
          admin: system,
          changedFields: view.conflict.fields.map((field) =>
            changedFieldLabel(tLibrary, field),
          ),
        }).text;

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={title}
        area={system ? titles.panel : undefined}
        parent={
          system
            ? titles.parent('library')
            : { title: tLibrary('screen.title'), href: libraryPath() }
        }
      >
        {record !== null && (
          <EditorHeaderActions
            mode={mode}
            record={record}
            changed={changed}
            copyPending={copy.pending}
            copyErrorId={copy.error === null ? undefined : copyErrorId}
            onCopy={() => copy.copy(record)}
            onShared={setShared}
            sharing={sharing}
            onSharingChange={setSharing}
          />
        )}
      </PageHeader>
      {copy.dialog}
      <form
        ref={formRef}
        noValidate
        onSubmit={submit}
        onKeyDown={onKeyDown}
        className="flex min-h-0 flex-1 flex-col"
      >
        <div className="min-h-0 flex-1 overflow-y-auto">
          {/* The panel's compact density: 16 px between sections (foundations, Spacing & Density). */}
          <div
            className={cn(
              'mx-auto flex w-full max-w-180 flex-col px-4',
              system ? 'gap-4 py-4' : 'gap-5 py-4 md:py-6',
            )}
          >
            {record !== null && (
              <div className="flex flex-col gap-1">
                <RecordLabel
                  variant="under"
                  summary={record}
                  showSource={false}
                />
                {usable && (
                  // MC-6 under the header of one's own saved record.
                  <p className="text-muted-foreground text-sm leading-5">
                    {tLibrary('editor.launchHint', { kind: record.kind })}
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
            )}
            {record?.ban != null && (
              <div role="alert">
                <FormWarning>
                  {banText(tLibrary, format, record.ban.closedAt)}
                </FormWarning>
              </div>
            )}
            {/* A disabled fieldset disables every native field inside while the save runs. */}
            <fieldset disabled={saving} className="contents">
              <AgentFields
                mode={mode}
                recordId={saved?.id ?? null}
                base={base}
                values={values}
                onChange={input}
                errors={errors}
                choices={choices}
              />
            </fieldset>
            {conflictText !== null && (
              <ConflictBlock
                text={conflictText}
                canTakeSaved={view.conflict?.saved != null}
                onSaveMine={saveMine}
                onTakeSaved={takeSaved}
              />
            )}
            {formError !== null && <FormError>{formError}</FormError>}
          </div>
        </div>
        {everyoneGets && record !== null && (
          // MC-18, above the save panel: who gets the change.
          <p
            className={cn(
              CAPTION,
              'mx-auto w-full max-w-180 px-4 pb-2 text-muted-foreground',
            )}
          >
            {tLibrary('editor.everyoneGets', { kind: record.kind })}
          </p>
        )}
        <SavePanel
          status={view.status}
          isNew={saved === null}
          onUseInChat={
            usable
              ? () =>
                  inChat({
                    record: {
                      id: record.id,
                      kind: record.kind,
                      name: record.name,
                    },
                  })
              : null
          }
          onDiscard={discard}
          useInChatRef={useInChatRef}
        />
      </form>
    </div>
  );
}

/** The editor saves only agents: a route that answers with another kind breaks the contract. */
function agentOf(record: RecordDetail): AgentRecord {
  if (record.kind !== 'agent')
    throw new Error(
      `library: the editor got a ${record.kind} record ${record.id}`,
    );
  return record;
}
