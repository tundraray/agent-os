import {
  LibraryErrorCode,
  LibraryRejectReasonSchema,
  ModelUnavailableReasonSchema,
  RecordNameTakenReasonSchema,
  type RecordKind,
  type RecordSummary,
  type SaveOwnRefusal,
  type ToolRefusalReason,
} from '@agent-os/contracts';
import { isNotFound } from '@/lib/admin/admin-errors';
import { ADMIN_TEXT, saveFailed } from '@/lib/admin/admin-texts';
import { isApiRequestError, type ApiRequestError } from '@/lib/api/api-request';
import { capitalize, formatModel, providerReasonText } from '@/lib/agents/format';
import { chatFailureText } from '@/lib/access/access-texts';

/**
 * Texts of the library's errors and refusals and where each one shows (design-web.md, «Ошибки и их
 * место»; UXRD MC-6, MC-8, MC-10, MC-14, MC-16, MC-17). Screens keep no refusal texts of their own.
 */

/** «агент» / «workflow», or with a capital letter at the start of a sentence. */
export function kindWord(kind: RecordKind, capital = false): string {
  const word = kind === 'agent' ? 'агент' : 'workflow';
  return capital ? word.charAt(0).toUpperCase() + word.slice(1) : word;
}

/** MC-13 (and the MC-4 notice): systems that did not come in, because the author has no access to them. */
export const DROPPED_SERVERS = 'Не вошли системы, к которым у вас нет доступа:';

export const droppedServersText = (servers: readonly string[]): string => `${DROPPED_SERVERS} ${servers.join(', ')}`;

/** MC-14: why «Поделиться» is unavailable on the owner's record; `null` — it is available. */
export function shareBlockedReason(record: Pick<RecordSummary, 'ban'>, noRoles: boolean): string | null {
  if (record.ban !== null) return 'Доступ закрыл администратор — делиться нельзя';
  return noRoles ? 'У вас нет ролей — поделиться не с кем' : null;
}

/**
 * The reason of a failed request in the server's words, or «нет связи с сервером» — the {причина} of MC-4,
 * MC-5 and MC-13.
 */
export function failureReason(cause: unknown): string {
  if (isApiRequestError(cause) && cause.kind === 'network') return 'нет связи с сервером';
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * The knowledge screen shows «Не найдено» only for this: a 404, or a 403 `KNOWLEDGE_FORBIDDEN` of a workflow
 * the viewer sees but whose knowledge is closed to them (AC-11.3). Any other refusal stays an error.
 */
export const isKnowledgeHidden = (error: unknown): boolean =>
  isNotFound(error) ||
  (isApiRequestError(error) &&
    error.kind === 'http' &&
    error.status === 403 &&
    error.code === LibraryErrorCode.KNOWLEDGE_FORBIDDEN);

/** MC-4. */
export const copyFailed = (cause: unknown): string => `Не удалось скопировать: ${failureReason(cause)}`;

/** MC-5. */
export const deleteFailed = (cause: unknown): string => `Не удалось удалить: ${failureReason(cause)}`;

/** Where the answer came from: the same code reads differently in different places. */
export type LibraryErrorWhere =
  | 'record_page'
  | 'editor'
  | 'share'
  | 'panel'
  | 'message'
  | 'first_message'
  | 'restart';

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
  /** The executor whose card a server error belongs to (a model error stays at the «Модель» field). */
  executor?: string;
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
  | { at: 'executor'; executor: string }
  | { at: 'form' }
  | { at: 'notice' }
  /** The notice under the message field. */
  | { at: 'composer' };

/** `open` — the notice carries «Открыть» to the record (MC-16). */
export type LibraryErrorText = { place: LibraryErrorPlace; text: string; open: boolean };

const NOT_FOUND_TEXT = 'Такого агента или workflow нет: его удалили, закрыли для вас или ссылка неверна.';
const START_REFUSED = 'START_REFUSED';

const unavailableText = (kind: RecordKind): string =>
  `${kindWord(kind, true)} недоступен: его удалили или закрыли для вас`;

const notStartedText = (model: string, subject: string): string =>
  `Модель ${formatModel(model)} вам недоступна — ${subject} не запустился`;

/** The general place of a context, for an error without a place of its own. */
function placeOf(where: LibraryErrorWhere): LibraryErrorPlace {
  switch (where) {
    case 'editor':
    case 'share':
    case 'panel':
      return { at: 'form' };
    case 'record_page':
    case 'restart':
      return { at: 'notice' };
    case 'message':
    case 'first_message':
      return { at: 'composer' };
  }
}

const at = (place: LibraryErrorPlace, text: string, open = false): LibraryErrorText => ({ place, text, open });

/** The «Системы» field of a server error, or the executor's card when the caller names it. */
const serversPlace = (context: LibraryErrorContext): LibraryErrorPlace =>
  context.executor === undefined ? { at: 'field', field: 'servers' } : { at: 'executor', executor: context.executor };

/** The refused model of a 409 `START_REFUSED` body, as the core reads it. */
const refusedModel = (error: ApiRequestError): string | null => error.model ?? null;

/** model-providers MC-11 at the message field: the first message found no default chat model. */
const CHAT_MODEL_NOT_CONFIGURED = 'Модель для чата не настроена. Обратитесь к администратору Agent OS.';

/**
 * The {Причина} of model-providers MC-12, capitalised: a start refused for the model's provider (MC-9 words)
 * or for no default chat model; `null` — another reason. `model` is null only on `model_not_configured`.
 */
function providerRefusal(reason: string | null | undefined, model: string | null): string | null {
  if (reason === 'model_not_configured') return 'Модель не настроена';
  const provider = ModelUnavailableReasonSchema.safeParse(reason);
  if (!provider.success) return null;
  return capitalize(providerReasonText(provider.data, model === null ? undefined : formatModel(model)));
}

/** model-providers MC-12 of a refused start: «{Причина} — {вид} не запустился». */
const providerNotStarted = (cause: string, kind: RecordKind): string => `${cause} — ${kindWord(kind)} не запустился`;

/**
 * 409 `START_REFUSED`: MC-16 (or MC-12 for a provider reason) at «Запустить с нуля»; on a new conversation's
 * first message, with «чат», or MC-11 for a provider reason or no default chat model.
 */
function startRefused(error: ApiRequestError, context: LibraryErrorContext): LibraryErrorText | null {
  const model = refusedModel(error);
  const byModel = error.reason === 'model_not_allowed' || error.reason === 'model_not_connected';
  const byProvider = providerRefusal(error.reason, model);
  if (context.where === 'first_message') {
    if (error.reason === 'model_not_configured') return at({ at: 'composer' }, CHAT_MODEL_NOT_CONFIGURED);
    if (byProvider !== null) return at({ at: 'composer' }, chatFailureText(error.reason ?? null, model));
    return byModel && model !== null ? at({ at: 'composer' }, notStartedText(model, 'чат')) : null;
  }
  const kind = context.kind ?? 'agent';
  if (error.reason === 'record_unavailable') return at(placeOf(context.where), unavailableText(kind));
  if (byProvider !== null) return at(placeOf(context.where), providerNotStarted(byProvider, kind), true);
  if (!byModel || model === null) return at(placeOf(context.where), saveFailed(error.message));
  const next =
    context.own === true ? 'Откройте его и выберите другую модель' : 'Скопируйте его себе — копия получит вашу модель';
  return at(placeOf(context.where), `${notStartedText(model, kindWord(kind))}. ${next}`, true);
}

function rejected(error: ApiRequestError, context: LibraryErrorContext): LibraryErrorText {
  const form = placeOf(context.where);
  const fallback = saveFailed(error.message);
  const reason = LibraryRejectReasonSchema.safeParse(error.reason);
  if (!reason.success) return at(form, fallback);
  switch (reason.data) {
    case 'server_not_allowed':
      return at(
        serversPlace(context),
        context.server === undefined ? fallback : `Нет доступа к системе ${context.server} — уберите её`,
      );
    case 'all_servers_not_allowed':
      return at(serversPlace(context), fallback);
    case 'model_not_allowed':
      return at(
        { at: 'field', field: 'model' },
        context.model === undefined ? fallback : `Модель ${formatModel(context.model)} вам недоступна — выберите другую`,
      );
    case 'agent_not_visible':
      return at({ at: 'field', field: 'agents' }, fallback);
    case 'role_not_member':
      return at(form, context.role === undefined ? fallback : saveFailed(`вы не состоите в роли ${context.role}`));
    case 'sharing_banned':
      return at(form, saveFailed('доступ закрыл администратор'));
    case 'audience_fixed':
    case 'builtin':
    case 'holder_not_found':
      return at(form, fallback);
  }
}

function nameTaken(error: ApiRequestError, context: LibraryErrorContext): LibraryErrorText {
  const place: LibraryErrorPlace = { at: 'field', field: 'name' };
  const reason = RecordNameTakenReasonSchema.safeParse(error.reason);
  if (reason.success && reason.data === 'system') {
    return at(place, 'Так называется агент от компании — выберите другое имя');
  }
  if (reason.success && context.kind !== undefined && context.name !== undefined) {
    return at(place, `У вас уже есть ${kindWord(context.kind)} «${context.name}»`);
  }
  return at(place, saveFailed(error.message));
}

function conflict(context: LibraryErrorContext): LibraryErrorText {
  const head =
    context.admin === true
      ? 'Изменения уже сохранили в другом окне.'
      : 'Вы уже сохранили изменения в другом окне или в чате.';
  const fields = context.changedFields ?? [];
  return at({ at: 'conflict' }, fields.length === 0 ? head : `${head} Там изменились: ${fields.join(', ')}.`);
}

/**
 * A refused library request as its place and text. `null` — no text of its own, only in a message's field:
 * it shows the failed send line of chat-shell MC-27 (network, 5xx, a refused first message without a model).
 * An unknown code reads «Не удалось сохранить: {причина}» with the server's message.
 */
export function describeLibraryError(
  error: unknown,
  context: LibraryErrorContext & { where: Exclude<LibraryErrorWhere, 'message' | 'first_message'> },
): LibraryErrorText;
export function describeLibraryError(error: unknown, context: LibraryErrorContext): LibraryErrorText | null;
export function describeLibraryError(error: unknown, context: LibraryErrorContext): LibraryErrorText | null {
  const inMessage = context.where === 'message' || context.where === 'first_message';
  if (!isApiRequestError(error)) {
    return inMessage ? null : at(placeOf(context.where), saveFailed(error instanceof Error ? error.message : String(error)));
  }
  if (error.kind === 'network') return inMessage ? null : at(placeOf(context.where), ADMIN_TEXT.noConnection);

  switch (error.code) {
    case LibraryErrorCode.RECORD_NOT_FOUND:
      if (context.where === 'record_page' || context.where === 'editor') return at({ at: 'screen' }, NOT_FOUND_TEXT);
      if (inMessage) return context.kind === undefined ? null : at({ at: 'composer' }, unavailableText(context.kind));
      break;
    case LibraryErrorCode.RECORD_VERSION_CONFLICT:
      return conflict(context);
    case LibraryErrorCode.RECORD_NAME_TAKEN:
      return nameTaken(error, context);
    case LibraryErrorCode.RECORD_REJECTED:
      return rejected(error, context);
    case START_REFUSED:
      return startRefused(error, context);
  }
  return inMessage ? null : at(placeOf(context.where), saveFailed(error.message));
}

/**
 * MC-8 on a draft card: why a draft's save was refused (a 200 whose draft keeps waiting with `refusal`).
 * `version_conflict` has no line here: the card shows the MC-15 stale line instead.
 */
export function describeDraftRefusal(
  refusal: SaveOwnRefusal,
  context: { kind: RecordKind; name: string; model?: string },
): string | null {
  switch (refusal) {
    case 'version_conflict':
      return null;
    case 'name_taken':
      return `У вас уже есть ${kindWord(context.kind)} «${context.name}»`;
    case 'system_name':
      return 'Так называется агент от компании — выберите другое имя';
    case 'model_not_allowed':
      return context.model === undefined
        ? saveFailed('модель вам недоступна')
        : `Модель ${formatModel(context.model)} вам недоступна — выберите другую`;
    case 'not_found':
      return unavailableText(context.kind);
    case 'shared':
      return `${kindWord(context.kind, true)} открыт ролям — правьте его в редакторе`;
    default:
      // The UXRD has no MC-8 text for these reasons, and a 200 refusal carries no server message to quote.
      return 'Не удалось сохранить — откройте черновик в редакторе: там видно, что исправить';
  }
}

/** What the tool-call block knows about the refused call. */
export type RefusalContext = {
  /** `start_agent`, `start_workflow` or `draft_record`. */
  tool: string;
  kind: RecordKind;
  /** `refusalDetail.model` of the result, never the call's arguments. */
  model: string | null;
  /** The record the call names; without it the block has no action. */
  recordId: string | null;
  /** The record is the viewer's own. */
  own: boolean;
  /** The record is the company's (a system record). */
  company?: boolean;
};

export type RefusalText = {
  text: string;
  action: { label: 'Открыть' | 'Открыть в редакторе'; recordId: string } | null;
};

/**
 * The text and action of a refused library call (MC-16, MC-17; model-providers MC-12). `null` — not the library's refusal,
 * or one without a UXRD text (`read_only` on a colleague's record, `invalid_arguments` of `draft_record`):
 * the block shows the platform's general refusal text.
 */
export function describeRefusal(reason: ToolRefusalReason | null, context: RefusalContext): RefusalText | null {
  const { kind, model, recordId } = context;
  const action = (label: 'Открыть' | 'Открыть в редакторе') => (recordId === null ? null : { label, recordId });
  switch (reason) {
    case 'record_unavailable':
      return { text: unavailableText(kind), action: null };
    case 'model_not_allowed': {
      const named = model === null ? 'Модель вам недоступна' : `Модель ${formatModel(model)} вам недоступна`;
      const next = context.own
        ? 'Откройте его и выберите другую модель'
        : 'Скопируйте его себе — копия получит вашу модель';
      return { text: `${named} — ${kindWord(kind)} не запустился. ${next}`, action: action('Открыть') };
    }
    case 'shared':
      return { text: `${kindWord(kind, true)} открыт ролям — правьте его в редакторе`, action: action('Открыть в редакторе') };
    case 'read_only':
      return context.company === true ? { text: 'Агентов от компании правят в панели администратора', action: null } : null;
    case 'run_limit':
      return { text: 'Предел вызовов исчерпан', action: null };
    case 'model_not_configured':
    case 'provider_missing':
    case 'provider_disabled':
    case 'provider_key_missing': {
      const cause = providerRefusal(reason, model);
      return cause === null ? null : { text: providerNotStarted(cause, kind), action: action('Открыть') };
    }
    default:
      return null;
  }
}
