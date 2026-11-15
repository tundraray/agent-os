import type { ZodType } from "zod";
import { ApiErrorSchema } from "@agent-os/contracts";
import { apiBaseUrl } from "@/lib/config";

export type ApiMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type ApiRequestErrorKind = "not_found" | "invalid_response" | "http" | "network";

type ApiRequestErrorInit = {
  kind: ApiRequestErrorKind;
  method: ApiMethod;
  path: string;
  status?: number;
  /** `errorCode` of the API error body, when the body is an ApiError that carries one. */
  code?: string;
  /** `reason` of the API error body, when present. */
  reason?: string;
  /** `message` of the API error body; replaces the classification text when present. */
  bodyMessage?: string;
};

export class ApiRequestError extends Error {
  readonly kind: ApiRequestErrorKind;
  readonly method: ApiMethod;
  /** Request path without the query string. */
  readonly path: string;
  readonly status?: number;
  readonly code?: string;
  readonly reason?: string;

  constructor({ kind, method, path, status, code, reason, bodyMessage }: ApiRequestErrorInit) {
    super(
      bodyMessage ??
        `API request failed: ${kind}${status === undefined ? "" : ` (${status})`}${code === undefined ? "" : ` ${code}`}`,
    );
    this.name = "ApiRequestError";
    this.kind = kind;
    this.method = method;
    this.path = path;
    this.status = status;
    this.code = code;
    this.reason = reason;
  }
}

export const isApiRequestError = (value: unknown): value is ApiRequestError =>
  value instanceof ApiRequestError;

/** Log-safe description of a failure: classification only, never request or response bodies. */
export const describeApiError = (
  error: unknown,
): {
  kind: ApiRequestErrorKind | "unknown";
  method: ApiMethod | undefined;
  path: string | undefined;
  status: number | undefined;
  code: string | undefined;
  reason: string | undefined;
} =>
  isApiRequestError(error)
    ? {
        kind: error.kind,
        method: error.method,
        path: error.path,
        status: error.status,
        code: error.code,
        reason: error.reason,
      }
    : { kind: "unknown", method: undefined, path: undefined, status: undefined, code: undefined, reason: undefined };

export type UnauthorizedHandler = (code: string | undefined) => void;

let unauthorizedHandler: UnauthorizedHandler | null = null;

/** Every 401 goes to this handler with its `errorCode` before the caller gets the error; `null` removes it. */
export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  unauthorizedHandler = handler;
}

type ApiRequestInput<T> = {
  path: string;
  method?: ApiMethod;
  body?: unknown;
  /** Response schema; without it the body is not read (204 and other bodiless answers). */
  schema?: ZodType<T>;
};

/** The web's only `fetch` to the API: session cookie, JSON body, schema-checked answer. */
export function apiRequest<T>(input: ApiRequestInput<T> & { schema: ZodType<T> }): Promise<T>;
export function apiRequest(input: ApiRequestInput<never> & { schema?: undefined }): Promise<void>;
export async function apiRequest<T>({
  path,
  method = "GET",
  body,
  schema,
}: ApiRequestInput<T>): Promise<T | void> {
  const where = { method, path: path.split("?")[0] };
  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl}${path}`, {
      method,
      credentials: "include",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiRequestError({ kind: "network", ...where });
  }
  if (!response.ok) {
    const details = await errorDetailsOf(response);
    if (response.status === 401) unauthorizedHandler?.(details.code);
    throw new ApiRequestError({
      kind: response.status === 404 ? "not_found" : "http",
      ...where,
      status: response.status,
      ...details,
    });
  }
  if (schema === undefined) return;
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new ApiRequestError({ kind: "invalid_response", ...where, status: response.status });
  }
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new ApiRequestError({ kind: "invalid_response", ...where, status: response.status });
  }
  return result.data;
}

/** Code, reason and message of an ApiError body; a body that is not JSON or not an ApiError has none. */
async function errorDetailsOf(
  response: Response,
): Promise<{ code?: string; reason?: string; bodyMessage?: string }> {
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    return {}; // the status alone classifies the failure
  }
  const result = ApiErrorSchema.safeParse(data);
  if (!result.success) return {};
  const { errorCode, reason, message } = result.data;
  return {
    code: errorCode,
    reason,
    bodyMessage: Array.isArray(message) ? message.join("; ") : message,
  };
}
