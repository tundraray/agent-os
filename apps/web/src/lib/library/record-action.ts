import {
  LibraryErrorCode,
  type RecordDetail,
  type RecordKind,
} from '@agent-os/contracts';
import {
  ApiRequestError,
  describeApiError,
  isApiRequestError,
} from '@/lib/api/api-request';
import { logger } from '@/lib/logger';

/** Every change of a record the web makes (design-web.md, Логирование). */
export type RecordChange =
  'create' | 'save' | 'audience' | 'copy' | 'delete' | 'close' | 'unban';

export type RecordActionInput = {
  /** `null` while the record is being created. */
  recordId: string | null;
  kind: RecordKind;
  action: RecordChange;
  /** The version the edit started from; `null` for a change that sends none. */
  version: number | null;
  /** Reads the saved record after a version conflict (Flow 1), so the log and MC-10 get its version. */
  readSaved?: () => Promise<RecordDetail>;
};

/**
 * 409 `RECORD_VERSION_CONFLICT` with the record as saved now; `saved` is `null` when it was not read
 * (no `readSaved`, or the read failed) — MC-10 then shows no list of fields.
 */
export class RecordConflictError extends ApiRequestError {
  readonly saved: RecordDetail | null;

  constructor(conflict: ApiRequestError, saved: RecordDetail | null) {
    super({
      kind: conflict.kind,
      method: conflict.method,
      path: conflict.path,
      status: conflict.status,
      code: conflict.code,
      reason: conflict.reason,
      bodyMessage: conflict.message,
      model: conflict.model,
    });
    this.name = 'RecordConflictError';
    this.saved = saved;
  }
}

const isConflict = (error: unknown): error is ApiRequestError =>
  isApiRequestError(error) &&
  error.code === LibraryErrorCode.RECORD_VERSION_CONFLICT;

/** The saved record after a conflict; a failed read is logged and leaves `null`. */
async function readSavedAfterConflict(
  input: RecordActionInput,
): Promise<RecordDetail | null> {
  if (input.readSaved === undefined) return null;
  try {
    return await input.readSaved();
  } catch (error) {
    logger.error('library: saved record read after conflict failed', {
      recordId: input.recordId,
      ...describeApiError(error),
    });
    return null;
  }
}

/** The id of the record in a change's answer: a created record, or a copy's `record`. */
function answeredRecordId(result: unknown): string | null {
  if (typeof result !== 'object' || result === null) return null;
  if ('id' in result && typeof result.id === 'string') return result.id;
  if ('record' in result) return answeredRecordId(result.record);
  return null;
}

/** The ids a success logs: a create names the new record; a copy names its source and the copy. */
function loggedIds(
  input: RecordActionInput,
  result: unknown,
): { recordId: string | null; copyId?: string | null } {
  if (input.action === 'create') return { recordId: answeredRecordId(result) };
  if (input.action === 'copy')
    return { recordId: input.recordId, copyId: answeredRecordId(result) };
  return { recordId: input.recordId };
}

/**
 * The one wrapper of every change of a record: runs `call`, logs the record, kind, action, version,
 * outcome and `durationMs` (a conflict adds the edit's and the saved version), and throws the error on.
 * The prompt, rules, description and content never reach the log.
 */
export async function recordAction<T>(
  input: RecordActionInput,
  call: () => Promise<T>,
): Promise<T> {
  const { recordId, kind, action, version } = input;
  const started = performance.now();
  const durationMs = () => Math.round(performance.now() - started);
  try {
    const result = await call();
    logger.info('library: record changed', {
      ...loggedIds(input, result),
      kind,
      action,
      version,
      outcome: 'ok',
      durationMs: durationMs(),
    });
    return result;
  } catch (error) {
    // Nested: the request's `kind` (`http`, `network`) would overwrite the record's.
    const fields = {
      recordId,
      kind,
      action,
      version,
      outcome: 'refused',
      durationMs: durationMs(),
      failure: describeApiError(error),
    };
    if (!isConflict(error)) {
      logger.warn('library: record change refused', fields);
      throw error;
    }
    const saved = await readSavedAfterConflict(input);
    logger.warn('library: record change refused', {
      ...fields,
      editVersion: version,
      savedVersion: saved?.version ?? null,
    });
    throw new RecordConflictError(error, saved);
  }
}
