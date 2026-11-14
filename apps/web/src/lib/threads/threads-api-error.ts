export type ThreadsApiErrorKind = "not_found" | "invalid_response" | "http" | "network";

export class ThreadsApiError extends Error {
  constructor(
    readonly kind: ThreadsApiErrorKind,
    readonly status?: number,
    /** `errorCode` of the API error body, when the body is an ApiError that carries one. */
    readonly code?: string,
  ) {
    super(
      `Threads API request failed: ${kind}${status === undefined ? "" : ` (${status})`}${code === undefined ? "" : ` ${code}`}`,
    );
    this.name = "ThreadsApiError";
  }
}

export const isThreadsApiError = (value: unknown): value is ThreadsApiError =>
  value instanceof ThreadsApiError;

/** Log-safe description of a failure: classification only, never response bodies or user text. */
export const describeThreadsError = (
  error: unknown,
): { kind: ThreadsApiErrorKind | "unknown"; status: number | undefined; code: string | undefined } =>
  isThreadsApiError(error)
    ? { kind: error.kind, status: error.status, code: error.code }
    : { kind: "unknown", status: undefined, code: undefined };
