export type ThreadsApiErrorKind = "not_found" | "invalid_response" | "http" | "network";

export class ThreadsApiError extends Error {
  constructor(
    readonly kind: ThreadsApiErrorKind,
    readonly status?: number,
  ) {
    super(`Threads API request failed: ${kind}${status === undefined ? "" : ` (${status})`}`);
    this.name = "ThreadsApiError";
  }
}

export const isThreadsApiError = (value: unknown): value is ThreadsApiError =>
  value instanceof ThreadsApiError;

/** Log-safe description of a failure: classification only, never response bodies or user text. */
export const describeThreadsError = (
  error: unknown,
): { kind: ThreadsApiErrorKind | "unknown"; status: number | undefined } =>
  isThreadsApiError(error)
    ? { kind: error.kind, status: error.status }
    : { kind: "unknown", status: undefined };
