import type { ReactNode } from 'react';
import {
  LibraryErrorCode,
  LibraryRejectReasonSchema,
  ModelUnavailableReasonSchema,
  ForkRefusalReasonSchema,
  RecordNameTakenReasonSchema,
  ThreadsErrorCodeSchema,
  TrainingErrorCode,
  type RecordKind,
  type RecordSummary,
  type ToolRefusalReason,
} from '@agent-os/contracts';
import { failedText, type FailedAction } from '@/i18n/server-text';
import { replyFailureText } from '@/lib/access/access-texts';
import { isNotFound } from '@/lib/admin/admin-errors';
import { formatModel } from '@/lib/agents/format';
import { isApiRequestError, type ApiRequestError } from '@/lib/api/api-request';
import type { ErrorsTranslator } from '@/i18n/catalog';

/**
 * Texts of the library's errors and refusals and where each one shows (design-web.md, «Ошибки и их
 * место»; UXRD MC-6, MC-8, MC-10, MC-14, MC-16, MC-17). Screens keep no refusal texts of their own; each
 * function takes the `errors` messages, and a text that quotes the server is a node with its language mark.
 */

/** MC-14: why «Поделиться» is unavailable on the owner's record; `null` — it is available. */
export function shareBlockedReason(
  t: ErrorsTranslator,
  record: Pick<RecordSummary, 'ban'>,
  noRoles: boolean,
): string | null {
  if (record.ban !== null) return t('library.shareBlocked.banned');
  return noRoles ? t('library.shareBlocked.noRoles') : null;
}

/**
 * The memory and training result screens show «Не найдено» only for this: a 404, or a 403 `MEMORY_FORBIDDEN`
 * or `TRAINING_FORBIDDEN` of a deep agent the viewer sees but whose memory or training is closed to them
 * (UXRD ME-04). Any other refusal stays an error.
 */
export const isHiddenFromViewer = (error: unknown): boolean =>
  isNotFound(error) ||
  (isApiRequestError(error) &&
    error.kind === 'http' &&
    error.status === 403 &&
    (error.code === LibraryErrorCode.MEMORY_FORBIDDEN ||
      error.code === TrainingErrorCode.TRAINING_FORBIDDEN));

/** MC-4. */
export const copyFailed = (t: ErrorsTranslator, cause: unknown): ReactNode =>
  failedText(t, 'copy', cause);

/** MC-5. */
export const deleteFailed = (t: ErrorsTranslator, cause: unknown): ReactNode =>
  failedText(t, 'delete', cause);

/** Where the answer came from: the same code reads differently in different places. */
export type LibraryErrorWhere =
  | 'record_page'
  | 'editor'
  | 'share'
  | 'panel'
  | 'message'
  | 'first_message'
  | 'restart'
  /** The script form on the deep agent's card (self-learning MC-15). */
  | 'script'
  /** Under «Обучить» and «Обучить заново» (self-learning MC-9). */
  | 'train'
  /** In the activation dialog (self-learning MC-12). */
  | 'activate'
  /** Under the message field with the action chip (create-and-test MC-3). */
  | 'test_run'
  /** On the «Похожий агент» card and under the line instead of the field. */
  | 'take';

/** What the caller knows about the request that the error alone does not say. */
export type LibraryErrorContext = {
  where: LibraryErrorWhere;
  /** The record's kind: the taken name, an unavailable record, a refused start. */
  kind?: RecordKind;
  /** The name being saved. */
  name?: string;
  /** The model on the form (422 `model_not_allowed`). */
  model?: string;
  /** A server on the form the author has no access to (422 `server_not_allowed`). */
  server?: string;
  /** The role the owner is no longer in (422 `role_not_member`). */
  role?: string;
  /** A refused restart: the record is the viewer's own. */
  own?: boolean;
  /** The conflict's wording for an administrator. */
  admin?: boolean;
  /** The conflict's changed fields, by their form labels. */
  changedFields?: readonly string[];
};

export type LibraryErrorField = 'name' | 'servers' | 'model' | 'agents';

export type LibraryErrorPlace =
  /** RV-02 instead of the page. */
  | { at: 'screen' }
  /** MC-10 above the save panel. */
  | { at: 'conflict' }
  | { at: 'field'; field: LibraryErrorField }
  | { at: 'form' }
  | { at: 'notice' }
  /** The notice under the message field. */
  | { at: 'composer' };

/** `open` — the notice carries «Открыть» to the record (MC-16). */
export type LibraryErrorText = {
  place: LibraryErrorPlace;
  text: ReactNode;
  open: boolean;
};

const START_REFUSED = 'START_REFUSED';

/** The general place of a context, for an error without a place of its own. */
function placeOf(where: LibraryErrorWhere): LibraryErrorPlace {
  switch (where) {
    case 'editor':
    case 'share':
    case 'panel':
    case 'script':
    case 'train':
    case 'activate':
    case 'take':
      return { at: 'form' };
    case 'record_page':
    case 'restart':
      return { at: 'notice' };
    case 'message':
    case 'first_message':
    case 'test_run':
      return { at: 'composer' };
  }
}

/** The opening of the fallback «Не удалось …: {причина}» of a place. */
const failedActionOf = (where: LibraryErrorWhere): FailedAction =>
  where === 'take' ? 'take' : 'save';

const at = (
  place: LibraryErrorPlace,
  text: ReactNode,
  open = false,
): LibraryErrorText => ({ place, text, open });

/** The «Системы» field of a server error. */
const SERVERS_PLACE: LibraryErrorPlace = { at: 'field', field: 'servers' };

/** The refused model of a 409 `START_REFUSED` body, as the core reads it. */
const refusedModel = (error: ApiRequestError): string | null =>
  error.model ?? null;

/**
 * model-providers MC-12 of a refused start: «{Причина} — {вид} не запустился» for a start refused for the
 * model's provider or for no default chat model; `null` — another reason. `model` is null only on
 * `model_not_configured`, or when the refusal names no model.
 */
function providerNotStarted(
  t: ErrorsTranslator,
  reason: string | null | undefined,
  model: string | null,
  kind: RecordKind,
): string | null {
  if (reason === 'model_not_configured')
    return t('library.providerNotStarted.model_not_configured', { kind });
  const provider = ModelUnavailableReasonSchema.safeParse(reason);
  if (!provider.success) return null;
  return model === null
    ? t(`library.providerNotStarted.unnamed.${provider.data}`, { kind })
    : t(`library.providerNotStarted.named.${provider.data}`, {
        kind,
        model: formatModel(model),
      });
}

/** MC-16 of a start refused for the model, with what the viewer can do: change its model, or copy it. */
function modelNotStarted(
  t: ErrorsTranslator,
  model: string | null,
  kind: RecordKind,
  own: boolean,
): string {
  if (model === null)
    return t(
      own ? 'library.notStarted.ownUnnamed' : 'library.notStarted.otherUnnamed',
      { kind },
    );
  return t(own ? 'library.notStarted.own' : 'library.notStarted.other', {
    kind,
    model: formatModel(model),
  });
}

/** The first message of a new conversation, refused at start: model-providers MC-11, or MC-16 with «чат». */
function firstMessageRefused(
  t: ErrorsTranslator,
  error: ApiRequestError,
): LibraryErrorText | null {
  const model = refusedModel(error);
  if (error.reason === 'model_not_configured')
    return at({ at: 'composer' }, t('library.chatModelNotConfigured'));
  if (ModelUnavailableReasonSchema.safeParse(error.reason).success) {
    return at(
      { at: 'composer' },
      replyFailureText(t, error.reason ?? null, model),
    );
  }
  const byModel =
    error.reason === 'model_not_allowed' ||
    error.reason === 'model_not_connected';
  return byModel && model !== null
    ? at(
        { at: 'composer' },
        t('library.chatNotStarted', { model: formatModel(model) }),
      )
    : null;
}

/** 409 `START_REFUSED`: MC-16 (or MC-12 for a provider reason) at «Запустить с нуля» and on a message. */
function startRefused(
  t: ErrorsTranslator,
  error: ApiRequestError,
  context: LibraryErrorContext,
): LibraryErrorText | null {
  if (context.where === 'first_message') return firstMessageRefused(t, error);
  const place = placeOf(context.where);
  const kind = context.kind ?? 'agent';
  const model = refusedModel(error);
  if (error.reason === 'record_unavailable')
    return at(place, t('library.unavailable', { kind }));
  const byProvider = providerNotStarted(t, error.reason, model, kind);
  if (byProvider !== null) return at(place, byProvider, true);
  const byModel =
    error.reason === 'model_not_allowed' ||
    error.reason === 'model_not_connected';
  if (!byModel || model === null)
    return at(place, failedText(t, failedActionOf(context.where), error));
  return at(place, modelNotStarted(t, model, kind, context.own === true), true);
}

function rejected(
  t: ErrorsTranslator,
  error: ApiRequestError,
  context: LibraryErrorContext,
): LibraryErrorText {
  const form = placeOf(context.where);
  const fallback = failedText(t, 'save', error);
  const reason = LibraryRejectReasonSchema.safeParse(error.reason);
  if (!reason.success) return at(form, fallback);
  switch (reason.data) {
    case 'server_not_allowed':
      return at(
        SERVERS_PLACE,
        context.server === undefined
          ? fallback
          : t('library.serverNotAllowed', { server: context.server }),
      );
    case 'all_servers_not_allowed':
      return at(SERVERS_PLACE, fallback);
    case 'model_not_allowed':
      return at(
        { at: 'field', field: 'model' },
        context.model === undefined
          ? fallback
          : t('library.modelNotAllowed', { model: formatModel(context.model) }),
      );
    case 'agent_not_visible':
      return at({ at: 'field', field: 'agents' }, fallback);
    case 'role_not_member':
      return at(
        form,
        context.role === undefined
          ? fallback
          : t('library.roleNotMember', { role: context.role }),
      );
    case 'sharing_banned':
      return at(form, t('library.sharingBanned'));
    case 'skill_not_visible':
    case 'audience_fixed':
    case 'builtin':
    case 'holder_not_found':
      return at(form, fallback);
  }
}

function nameTaken(
  t: ErrorsTranslator,
  error: ApiRequestError,
  context: LibraryErrorContext,
): LibraryErrorText {
  const place: LibraryErrorPlace = { at: 'field', field: 'name' };
  const reason = RecordNameTakenReasonSchema.safeParse(error.reason);
  if (reason.success && reason.data === 'system')
    return at(place, t('library.systemName'));
  if (
    reason.success &&
    context.kind !== undefined &&
    context.name !== undefined
  ) {
    return at(
      place,
      t('library.nameTaken', { kind: context.kind, name: context.name }),
    );
  }
  return at(place, failedText(t, 'save', error));
}

function conflict(
  t: ErrorsTranslator,
  context: LibraryErrorContext,
): LibraryErrorText {
  if (context.where === 'script')
    return at({ at: 'conflict' }, t('library.conflict.script'));
  const fields = context.changedFields ?? [];
  const admin = context.admin === true;
  const text =
    fields.length === 0
      ? t(admin ? 'library.conflict.admin' : 'library.conflict.own')
      : t(
          admin ? 'library.conflict.adminFields' : 'library.conflict.ownFields',
          { fields: fields.join(', ') },
        );
  return at({ at: 'conflict' }, text);
}

/** MC-18: the reason a conversation cannot be forked now; `null` — another refusal or one without a text. */
function forkReason(t: ErrorsTranslator, error: unknown): string | null {
  if (
    !isApiRequestError(error) ||
    error.code !== ThreadsErrorCodeSchema.enum.FORK_REFUSED
  )
    return null;
  const reason = ForkRefusalReasonSchema.exclude(['not_a_chat']).safeParse(
    error.reason,
  );
  return reason.success ? t(`fork.reason.${reason.data}`) : null;
}

/** MC-18: the notice of a refused «Ответвить чат». */
export function forkRefusalText(t: ErrorsTranslator, error: unknown): string {
  const reason = forkReason(t, error);
  return reason === null ? t('fork.failed') : t('fork.refused', { reason });
}

/** MC-3 of a refused start; `TEST_RUN_RUNNING` carries a link, so the field builds that one itself. */
function testRunRefused(t: ErrorsTranslator, error: unknown): ReactNode {
  if (
    isApiRequestError(error) &&
    error.code === TrainingErrorCode.TRAINING_FORBIDDEN
  )
    return t('library.testRun.forbidden');
  const reason = forkReason(t, error);
  return reason === null
    ? failedText(t, 'test_run', error)
    : t('library.testRun.forkRefused', { reason });
}

/** MC-17: a message the test run's conversation does not take now. */
function notAccepting(
  t: ErrorsTranslator,
  error: ApiRequestError,
  context: LibraryErrorContext,
): ReactNode {
  if (error.reason === 'training_running' && context.name !== undefined)
    return t('library.testRun.trainingRunning', { name: context.name });
  if (error.reason === 'agent_deleted')
    return t('library.testRun.agentDeleted');
  return failedText(t, 'send', error);
}

/**
 * A refused library request as its place and text. `null` — no text of its own, only in a message's field:
 * it shows the failed send line of chat-shell MC-27 (network, 5xx, a refused first message without a model).
 * An unknown code reads «Не удалось сохранить: {причина}» with the server's message marked English.
 */
export function describeLibraryError(
  t: ErrorsTranslator,
  error: unknown,
  context: LibraryErrorContext & {
    where: Exclude<LibraryErrorWhere, 'message' | 'first_message'>;
  },
): LibraryErrorText;
export function describeLibraryError(
  t: ErrorsTranslator,
  error: unknown,
  context: LibraryErrorContext,
): LibraryErrorText | null;
export function describeLibraryError(
  t: ErrorsTranslator,
  error: unknown,
  context: LibraryErrorContext,
): LibraryErrorText | null {
  // A training's refusals are read by code and message only: their `START_REFUSED` carries no model (MC-9, MC-12).
  if (context.where === 'train' || context.where === 'activate') {
    return at(
      { at: 'form' },
      isApiRequestError(error) &&
        error.code === TrainingErrorCode.TRAINING_NO_PAST_TASKS
        ? t('library.noPastTasks')
        : failedText(t, context.where, error),
    );
  }
  if (context.where === 'test_run')
    return at({ at: 'composer' }, testRunRefused(t, error));
  const inMessage =
    context.where === 'message' || context.where === 'first_message';
  if (!isApiRequestError(error) || error.kind === 'network') {
    return inMessage
      ? null
      : at(
          placeOf(context.where),
          failedText(t, failedActionOf(context.where), error),
        );
  }

  switch (error.code) {
    case LibraryErrorCode.RECORD_NOT_FOUND:
      if (context.where === 'record_page' || context.where === 'editor')
        return at({ at: 'screen' }, t('library.notFound'));
      if (context.where === 'take')
        return at({ at: 'form' }, t('library.unavailable', { kind: 'agent' }));
      if (inMessage)
        return context.kind === undefined
          ? null
          : at(
              { at: 'composer' },
              t('library.unavailable', { kind: context.kind }),
            );
      break;
    case LibraryErrorCode.RECORD_VERSION_CONFLICT:
      return conflict(t, context);
    case LibraryErrorCode.RECORD_NAME_TAKEN:
      return nameTaken(t, error, context);
    case LibraryErrorCode.RECORD_REJECTED:
      return rejected(t, error, context);
    case START_REFUSED:
      return startRefused(t, error, context);
    case TrainingErrorCode.TEST_RUN_NOT_ACCEPTING:
      if (context.where === 'message')
        return at({ at: 'composer' }, notAccepting(t, error, context));
      break;
  }
  return inMessage
    ? null
    : at(
        placeOf(context.where),
        failedText(t, failedActionOf(context.where), error),
      );
}

/** What the tool-call block knows about the refused call. */
export type RefusalContext = {
  /** `start_agent` or `start_deep_agent`. */
  tool: string;
  kind: RecordKind;
  /** `refusalDetail.model` of the result, never the call's arguments. */
  model: string | null;
  /** The record the call names; without it the block has no action. */
  recordId: string | null;
  /** The record is the viewer's own. */
  own: boolean;
};

export type RefusalText = {
  text: string;
  action: { label: string; recordId: string } | null;
};

/**
 * The text and action of a refused library call (MC-16, MC-17; model-providers MC-12). `null` — not the library's refusal,
 * or one without a UXRD text: the block shows the platform's general refusal text.
 */
export function describeRefusal(
  t: ErrorsTranslator,
  reason: ToolRefusalReason | null,
  context: RefusalContext,
): RefusalText | null {
  const { kind, model, recordId } = context;
  const open =
    recordId === null ? null : { label: t('library.open'), recordId };
  switch (reason) {
    case 'record_unavailable':
      return { text: t('library.unavailable', { kind }), action: null };
    case 'model_not_allowed':
      return {
        text: modelNotStarted(t, model, kind, context.own),
        action: open,
      };
    case 'run_limit':
      return { text: t('library.runLimit'), action: null };
    case 'model_not_configured':
    case 'provider_missing':
    case 'provider_disabled':
    case 'provider_key_missing': {
      const text = providerNotStarted(t, reason, model, kind);
      return text === null ? null : { text, action: open };
    }
    default:
      return null;
  }
}
