"use client";

import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import { useFormatter } from "next-intl";
import { toast } from "sonner";
import { ALL_SERVERS, CHAT_BUILTIN_KEY, type RecordDetail, type RecordKind } from "@agent-os/contracts";
import { CAPTION, FormError, FormWarning } from "@/components/admin/admin-form";
import { PANEL_TITLE, sectionParent } from "@/components/admin/admin-header";
import { PageHeader } from "@/components/shell/page-header";
import { useShellServices } from "@/components/shell/shell-actions";
import { ThreadNotice } from "@/components/shell/thread-notice";
import { adminApi } from "@/lib/admin/admin-api";
import { describeApiError } from "@/lib/api/api-request";
import { focusShellTarget } from "@/lib/focus";
import { libraryApi } from "@/lib/library/library-api";
import type { Handoff } from "@/lib/library/draft-handoff";
import { describeLibraryError, droppedServersText, kindWord, type LibraryErrorText } from "@/lib/library/library-errors";
import { RecordConflictError, recordAction } from "@/lib/library/record-action";
import { canUseInChat, definitionOf, type RecordDefinition } from "@/lib/library/record-rules";
import { logger } from "@/lib/logger";
import { adminRecordPath, libraryPath, recordPath, threadPath } from "@/lib/shell-route";
import { threadsApiClient } from "@/lib/threads/threads-api-client";
import { cn } from "cn";
import { updateWorkflows, workflowsUsing, type AgentRecord, type WorkflowRecord } from "@/lib/library/update-workflows";
import {
  AgentFields,
  validateAgent,
  type AgentField,
  type AgentFieldErrors,
  type EditorChoices,
  type EditorMode,
} from "./agent-fields";
import { useCopyRecord } from "./copy-record";
import { EditorHeaderActions } from "./editor-header";
import { banText } from "./library-row";
import { RecordLabel } from "./record-label";
import { ConflictBlock, SavePanel } from "./save-panel";
import { useInChat, useLeaveThenGo } from "./use-in-chat";
import { useRecordForm } from "./use-record-form";
import { executorKey, validateWorkflow, WorkflowFields, type WorkflowField, type WorkflowFieldErrors } from "./workflow-fields";

/** UXRD MC-6 (launch hint) and MC-7 (titles, notices); MC-19 «Сохранено». */
const TEXT = {
  library: "Библиотека",
  newTitle: (kind: RecordKind) => (kind === "agent" ? "Новый агент" : "Новый workflow"),
  created: (kind: RecordKind) => `${kindWord(kind, true)} создан`,
  discarded: "Изменения отменены",
  restore: "Вернуть",
  // MC-13: the saved agent is the source of executors in the author's own workflows.
  usedIn: (name: string, workflows: readonly string[]) => `«${name}» есть в ваших workflow: ${workflows.join(", ")}`,
  updateThere: "Обновить там",
  updated: (workflows: readonly string[]) => `Обновлено: ${workflows.join(", ")}`,
  // Not in MC-13: some workflows refused the update (a conflict among them), and MC-13 has no text for it.
  notUpdated: (workflows: readonly string[]) => `Не удалось обновить: ${workflows.join(", ")}`,
  // MC-18: a company record after its creation, and one every employee sees.
  onlyAdmins: (kind: RecordKind) => `${kindWord(kind, true)} пока видят только администраторы`,
  share: "Поделиться",
  everyoneGets: (kind: RecordKind) => `${kindWord(kind, true)} видят все сотрудники — новые запуски пойдут по новой версии`,
} as const;

/** MC-6 under the header of one's own saved record. */
export const ownLaunchHint = (kind: RecordKind): string =>
  `Чтобы запустить, нажмите «Использовать в чате» или назовите ${kindWord(kind)} в чате.`;

/** The editor's two starts: an own record as saved, or the blank definition of a new one. */
export type RecordEditorSource = { saved: RecordDetail } | { blank: RecordDefinition };

/** The library's routes of the owner, or the panel's of the administrator on a company record. */
function clientOf(mode: EditorMode) {
  return mode === "system" ? adminApi.library : libraryApi;
}

export type RecordEditorProps = {
  /** `employee` — the owner in the library; `system` — the administrator on a company record in the panel (AL-02). */
  mode: EditorMode;
  source: RecordEditorSource;
  choices: EditorChoices;
  /** What the page took on mount (`useTakenHandoff`): the draft or the just created record this editor starts from. */
  handoff: Handoff | null;
};

/** The errors of either kind's fields, by the field (an executor's line and card by the executor). */
type FieldErrors = AgentFieldErrors & WorkflowFieldErrors;

/**
 * Server errors at a field of the form or at an executor's card; the rest show above the panel. A workflow's form
 * has only its name of the fields a server error names (its systems and models are the executors'), so the rest
 * go to the form.
 */
function fieldErrorOf(error: LibraryErrorText | null, kind: RecordKind): FieldErrors {
  const errors: FieldErrors = {};
  if (error === null) return errors;
  if (error.place.at === "executor" && kind === "workflow") errors[executorKey(error.place.executor)] = error.text;
  if (error.place.at !== "field") return errors;
  if (kind === "agent" || error.place.field === "name") errors[error.place.field] = error.text;
  return errors;
}

/**
 * The system a 422 `server_not_allowed` is about: the first ticked one outside the author's systems, and for a
 * workflow the executor that holds it (its card shows the error).
 */
function refusedServer(definition: RecordDefinition, allowed: readonly string[]): { server?: string; executor?: string } {
  const outside = (servers: readonly string[]) => servers.find((server) => server !== ALL_SERVERS && !allowed.includes(server));
  if (definition.kind === "agent") {
    const server = outside(definition.content.servers);
    return server === undefined ? {} : { server };
  }
  for (const executor of definition.content.executors) {
    const server = outside(executor.servers);
    if (server !== undefined) return { server, executor: executor.name };
  }
  return {};
}

function formErrorOf(error: LibraryErrorText | null, kind: RecordKind): string | null {
  if (error === null || error.place.at === "screen") return null;
  if (Object.keys(fieldErrorOf(error, kind)).length > 0) return null;
  return error.text;
}

/** The conversation a draft came from; `draftId` until that draft has been told it was saved here. */
type DraftReturn = { threadId: string; draftId: string | null };

type PageStart = {
  /** The draft's definition: the form opens with it as unsaved changes. */
  values?: RecordDefinition;
  back: DraftReturn | null;
  /** The record was just created on the previous address: the form opens «Сохранено». */
  created: boolean;
};

/**
 * The handoff put for `page` (design-web.md, KD-6), read when the page component mounts, before the page's data
 * is read, so leaving during loading or after a failed read still drops it. The read has no side effect (a
 * StrictMode double mount runs it twice); the handoff is taken once in an effect. A handoff of another page is
 * dropped there too: that page was left.
 */
export function useTakenHandoff(page: string | null): Handoff | null {
  const { draftHandoff } = useShellServices();
  const [carried] = useState(() => {
    const put = draftHandoff.getState().handoff;
    return page !== null && put?.page === page ? put : null;
  });
  const taken = useRef(false);
  useEffect(() => {
    if (taken.current || page === null) return;
    taken.current = true;
    draftHandoff.take(page);
  }, [page, draftHandoff]);
  return carried;
}

/**
 * What the editor starts from, given the handoff of its page. A draft goes into an employee's form as unsaved
 * changes; a record just created keeps the way back to its conversation; a reload leaves the form as it was.
 */
function pageStart(carried: Handoff | null, source: RecordEditorSource, system: boolean): PageStart {
  const none: PageStart = { back: null, created: false };
  if (carried === null) return none;
  const back = carried.threadId === undefined ? null : { threadId: carried.threadId, draftId: carried.draft?.draftId ?? null };
  if (carried.created === true) return { back, created: true };
  const kind = "saved" in source ? source.saved.kind : source.blank.kind;
  if (system || carried.draft === null || carried.draft.kind !== kind) return none;
  return { values: definitionOf(carried.draft), back, created: false };
}

/**
 * The editor's page handoff (`draftHandoff`): what this page starts from, the way back to a draft's conversation,
 * telling that draft it was saved here (DC-12), and handing a just created record on to its new page.
 */
function usePageHandoff(carried: Handoff | null, source: RecordEditorSource, system: boolean) {
  const { draftHandoff } = useShellServices();
  const [start] = useState(() => pageStart(carried, source, system));
  const [back, setBack] = useState(start.back);

  /**
   * Tells the draft the form came from that it was saved here as `recordId`, once. The record is saved either way,
   * so every answer — 409 `DRAFT_RESOLVED`, 404 `DRAFT_NOT_FOUND`, 404 `RECORD_NOT_FOUND` (the draft then keeps
   * waiting in its card) or a lost request — is only logged.
   */
  async function tellDraft(recordId: string): Promise<void> {
    if (back === null || back.draftId === null) return;
    const { threadId, draftId } = back;
    setBack({ threadId, draftId: null });
    const fields = { threadId, draftId, action: "saved_in_editor", recordId };
    try {
      const draft = await threadsApiClient.draftAction(threadId, draftId, { action: "saved_in_editor", recordId });
      logger.info("library: draft saved in editor", { ...fields, outcome: draft.state, refusal: draft.refusal });
    } catch (error) {
      logger.warn("library: draft saved in editor refused", { ...fields, failure: describeApiError(error) });
    }
  }

  /** A created record's new address mounts a new editor: it takes the way back and opens «Сохранено». */
  const handOnCreated = (nextPage: string): void =>
    draftHandoff.put({ page: nextPage, draft: null, created: true, ...(back === null ? {} : { threadId: back.threadId }) });

  return { start, back, tellDraft, handOnCreated };
}

/**
 * The record editor (design-web.md, KD-3, Flow 1; record-editor.md; UXRD ED-01): the form's state is
 * `useRecordForm`, the saves go through `recordAction`, and nothing leaves the editor as an event — it
 * calls the library client and moves between addresses itself. A save carries only the form's version
 * (Invariant 2); an error, a conflict or a refusal never touches the typed values (Invariant 1). While the
 * form has changes, `leaveGuard` holds them (DC-2). Text written by other employees is rendered as text only.
 */
export function RecordEditor({ mode, source, choices, handoff }: RecordEditorProps) {
  const system = mode === "system";
  const client = clientOf(mode);
  const { libraryIndex, leaveGuard, announcer } = useShellServices();
  const router = useRouter();
  const inChat = useInChat();
  const leaveThenGo = useLeaveThenGo();
  const copy = useCopyRecord();
  const copyErrorId = useId();
  const format = useFormatter();
  const { start, back, tellDraft, handOnCreated } = usePageHandoff(handoff, source, system);
  const { state, view, dispatch } = useRecordForm(start.values === undefined ? source : { ...source, values: start.values });
  const { saved, values, base } = state;
  const [checked, setChecked] = useState<FieldErrors>({});
  const [conflictError, setConflictError] = useState<RecordConflictError | null>(null);
  const [shared, setShared] = useState<RecordDetail | null>(null);
  /** The share dialog: the header's button and MC-18's notice after a company record is created open it. */
  const [sharing, setSharing] = useState(false);
  const [gone, setGone] = useState(false);
  /** Grows with every set of field errors shown, so focus moves to the first of them again. */
  const [errorsShown, setErrorsShown] = useState(0);
  const formRef = useRef<HTMLFormElement>(null);
  const useInChatRef = useRef<HTMLButtonElement>(null);

  const changed = view.changed.length > 0;
  const saving = view.status === "saving";
  // The audience of the last share; a later save answers with the record as it is now.
  const record =
    saved !== null && shared !== null && shared.version >= saved.version
      ? { ...saved, audience: shared.audience, offerInChat: shared.offerInChat }
      : saved;
  const errors: FieldErrors = { ...checked, ...fieldErrorOf(state.error, values.kind) };
  const formError = formErrorOf(state.error, values.kind);

  // UXRD «Порядок фокуса»: the page's title once the editor is on screen.
  useEffect(() => {
    focusShellTarget("page-title");
  }, []);

  // A record just created opens «Сохранено» (from a draft, with «Вернуться в беседу»). MC-18: nobody but
  // administrators sees a new company record yet; the notice's «Поделиться» opens this editor's dialog.
  const createdShown = useRef(false);
  useEffect(() => {
    if (createdShown.current || !start.created || !("saved" in source)) return;
    createdShown.current = true;
    dispatch({ type: "saved", record: source.saved });
    if (system) toast(TEXT.onlyAdmins(source.saved.kind), { action: { label: TEXT.share, onClick: () => setSharing(true) } });
  }, [start, source, system, dispatch]);

  // DC-2: hold the unsaved changes while they exist, under the saved name («» for a new record).
  const heldName = saved?.name ?? "";
  useEffect(() => {
    if (changed && !gone) leaveGuard.hold(heldName);
    else leaveGuard.release();
  }, [changed, gone, heldName, leaveGuard]);
  useEffect(() => () => leaveGuard.release(), [leaveGuard]);

  // Runs after the commit that shows the errors (and unfolds «Дополнительно»), so the field can take focus.
  useEffect(() => {
    if (errorsShown === 0) return;
    // An executor's card error has no field of its own: it takes the focus as the first of its kind in the form.
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"], [data-card-error]')?.focus();
  }, [errorsShown]);

  // UXRD: after «Сохранить» the focus goes to the button that took its place.
  useEffect(() => {
    if (view.status === "saved") useInChatRef.current?.focus();
  }, [view.status]);

  if (gone) return <ThreadNotice variant="library-not-found" />;

  const input = (next: RecordDefinition, field: AgentField | WorkflowField | null): void => {
    dispatch({ type: "input", values: next });
    if (field === null) return;
    // The check's error at the edited field goes; a server's stays until the next save (use-record-form).
    setChecked((current) => {
      const next = { ...current };
      delete next[field];
      return next;
    });
  };

  /** One `POST` or `PUT` with `version`; the outcome goes to the form, the conflict to MC-10. */
  async function send(definition: RecordDefinition, version: number | null): Promise<void> {
    try {
      if (saved === null) {
        const created = await recordAction({ recordId: null, kind: definition.kind, action: "create", version: null }, () =>
          client.create(definition),
        );
        // Before the address changes, so the conversation reads «Сохранено в редакторе» on the way back.
        await tellDraft(created.id);
        dispatch({ type: "saved", record: created });
        void libraryIndex.refresh();
        const nextPage = system ? adminRecordPath("library", created.id) : recordPath(created.id);
        // The new page's editor takes what it shows: «Сохранено», the way back, or MC-18's notice of a company record.
        handOnCreated(nextPage);
        if (!system) toast.success(TEXT.created(created.kind));
        // The form is saved: nothing is held, so the new address replaces this one without a question.
        leaveGuard.release();
        router.replace(nextPage);
        return;
      }
      const result = await recordAction(
        {
          recordId: saved.id,
          kind: definition.kind,
          action: "save",
          version,
          readSaved: () => client.get(saved.id),
        },
        () => client.save(saved.id, { ...definition, version: version ?? saved.version }),
      );
      dispatch({ type: "saved", record: result });
      void tellDraft(result.id);
      void libraryIndex.refresh();
      announcer.getState().announce("announce.saved");
      // «Обновить там» is about the owner's own workflows; a company record has none.
      if (result.kind === "agent" && !system) void offerUpdateThere(result);
    } catch (cause) {
      // `recordAction` has logged the refusal.
      if (cause instanceof RecordConflictError) {
        setConflictError(cause);
        dispatch({ type: "conflict", saved: cause.saved });
        return;
      }
      const text = describeLibraryError(cause, {
        where: "editor",
        admin: system,
        kind: definition.kind,
        name: definition.name,
        model: definition.kind === "agent" ? (definition.content.model ?? undefined) : undefined,
        ...refusedServer(definition, choices.servers),
      });
      if (text.place.at === "screen") {
        setGone(true);
        return;
      }
      dispatch({ type: "failed", error: text });
      setErrorsShown((count) => count + 1);
    }
  }

  /**
   * MC-13 «Обновить там»: the saved agent's own workflows that copied an executor from it are found by reading
   * each of them; the notice offers to take the new version there. Nothing is changed until it is pressed.
   */
  async function offerUpdateThere(agent: AgentRecord): Promise<void> {
    const workflows = await workflowsUsing(agent.id, libraryIndex);
    if (workflows.length === 0) return;
    toast(
      TEXT.usedIn(
        agent.name,
        workflows.map((workflow) => workflow.name),
      ),
      { action: { label: TEXT.updateThere, onClick: () => void updateThere(agent, workflows) } },
    );
  }

  async function updateThere(agent: AgentRecord, workflows: readonly WorkflowRecord[]): Promise<void> {
    const results = await updateWorkflows({ agent, workflows, allowedServers: choices.servers, libraryIndex });
    const namesOf = (outcome: "updated" | "failed"): string[] =>
      results.filter((result) => result.outcome === outcome).map((result) => result.workflow.name);
    const updated = namesOf("updated");
    const failed = namesOf("failed");
    // MC-13: the systems the new version did not bring in, named as «Взять новую версию» names them.
    const dropped = [...new Set(results.flatMap((result) => (result.outcome === "updated" ? result.dropped : [])))];
    if (updated.length > 0) {
      toast.success(TEXT.updated(updated), dropped.length === 0 ? undefined : { description: droppedServersText(dropped) });
    }
    if (failed.length > 0) toast.error(TEXT.notUpdated(failed));
  }

  /** The checks before sending: a field error stops the save and takes the focus. */
  const passes = (): boolean => {
    const found: FieldErrors = values.kind === "agent" ? validateAgent(values) : validateWorkflow(values);
    setChecked(found);
    if (Object.keys(found).length === 0) return true;
    setErrorsShown((count) => count + 1);
    return false;
  };

  /** «Сохранить» / «Создать», Ctrl+S; in a conflict — «Сохранить мои правки». */
  const save = (): void => {
    if (saving || !changed) return;
    if (view.status === "conflict") {
      saveMine();
      return;
    }
    if (!passes()) return;
    dispatch({ type: "save" });
    void send(values, view.version);
  };

  /** Saves the typed values over the version saved elsewhere, as its next version (Flow 1). */
  const saveMine = (): void => {
    if (saving || !passes()) return;
    const version = view.conflict?.saved?.version ?? view.version;
    dispatch({ type: "saveMine" });
    void send(values, version);
  };

  const withRestore = (): void => {
    toast(TEXT.discarded, { action: { label: TEXT.restore, onClick: () => dispatch({ type: "restore" }) } });
  };

  const discard = (): void => {
    dispatch({ type: "discard" });
    setChecked({});
    withRestore();
  };

  const takeSaved = (): void => {
    dispatch({ type: "takeSaved" });
    setChecked({});
    withRestore();
  };

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    save();
  };

  // Ctrl+S / Cmd+S while the focus is inside the form, not a shortcut of the shell.
  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>): void => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      save();
    }
  };

  const title = record?.name ?? TEXT.newTitle(values.kind);
  // The panel offers no «Использовать в чате» and no owner's launch hint (record-editor.md, «Системная»).
  const usable = !system && record !== null && canUseInChat(record);
  const everyoneGets = system && record !== null && (record.audience.everyone === true || record.builtinKey === CHAT_BUILTIN_KEY);
  const conflictText =
    view.conflict === null || conflictError === null
      ? null
      : describeLibraryError(conflictError, {
          where: "editor",
          admin: system,
          changedFields: view.conflict.fields.map((field) => field.label),
        }).text;

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={title}
        area={system ? PANEL_TITLE : undefined}
        parent={system ? sectionParent("library") : { title: TEXT.library, href: libraryPath() }}
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
      <form ref={formRef} noValidate onSubmit={submit} onKeyDown={onKeyDown} className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto">
          {/* The panel's compact density: 16 px between sections (foundations, Spacing & Density). */}
          <div className={cn("mx-auto flex w-full max-w-180 flex-col px-4", system ? "gap-4 py-4" : "gap-5 py-4 md:py-6")}>
            {record !== null && (
              <div className="flex flex-col gap-1">
                <RecordLabel variant="under" summary={record} showSource={false} />
                {usable && <p className="text-muted-foreground text-sm leading-5">{ownLaunchHint(record.kind)}</p>}
                {copy.error !== null && (
                  <p id={copyErrorId} role="alert" className="text-destructive text-xs leading-4">
                    {copy.error}
                  </p>
                )}
              </div>
            )}
            {record?.ban != null && (
              <div role="alert">
                <FormWarning>{banText(format, record.ban.closedAt)}</FormWarning>
              </div>
            )}
            {/* A disabled fieldset disables every native field inside while the save runs. */}
            <fieldset disabled={saving} className="contents">
              {values.kind === "agent" && base.kind === "agent" && (
                <AgentFields
                  mode={mode}
                  recordId={saved?.id ?? null}
                  base={base}
                  values={values}
                  onChange={input}
                  errors={errors}
                  choices={choices}
                />
              )}
              {values.kind === "workflow" && (
                <WorkflowFields
                  mode={mode}
                  saved={saved}
                  values={values}
                  onChange={input}
                  onTakeNewVersion={(index, executor) => dispatch({ type: "takeNewVersion", index, executor })}
                  errors={errors}
                  choices={choices}
                />
              )}
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
          <p className={cn(CAPTION, "mx-auto w-full max-w-180 px-4 pb-2 text-muted-foreground")}>{TEXT.everyoneGets(record.kind)}</p>
        )}
        <SavePanel
          status={view.status}
          isNew={saved === null}
          onUseInChat={usable ? () => inChat({ record: { id: record.id, kind: record.kind, name: record.name } }) : null}
          onBackToChat={back === null ? null : () => leaveThenGo(() => router.push(threadPath(back.threadId)))}
          onDiscard={discard}
          useInChatRef={useInChatRef}
        />
      </form>
    </div>
  );
}
