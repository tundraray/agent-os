import { SignInErrorSchema, type SignInError } from "@agent-os/contracts";

/** How LG-02 looks: the subtle danger block, or the neutral one for a reason that is not a failure. */
export type LoginReasonTone = "error" | "neutral";

/** Key of a reason text in the `login.reason` messages; the `…Named` ones take the provider's name. */
export type LoginReasonKey =
  | "invalidCredentials"
  | "cancelled"
  | "accountDisabled"
  | "sessionExpired"
  | "signedOut"
  | "signInFailed"
  | "signInFailedNamed"
  | "noEmail"
  | "noEmailNamed";

/** A reason of LG-02 as data: the component that shows it translates the key (uxrd MC-3). */
export type LoginReasonView = { key: LoginReasonKey; tone: LoginReasonTone; provider?: string };

/** A reason that names the provider: one text with its name, one for a provider unknown to the page. */
type ProviderReason = { named: LoginReasonKey; unnamed: LoginReasonKey };

const SIGN_IN_FAILED: ProviderReason = { named: "signInFailedNamed", unnamed: "signInFailed" };

/** Reason of each provider sign-in error. */
const SIGN_IN_ERROR_REASON: Record<SignInError, LoginReasonKey | ProviderReason> = {
  cancelled: "cancelled",
  failed: SIGN_IN_FAILED,
  no_email: { named: "noEmailNamed", unnamed: "noEmail" },
  account_disabled: "accountDisabled",
  provider_unavailable: SIGN_IN_FAILED,
};

/** `reason` of /login: the 401 handler sets `expired` or `disabled`, «Выйти» sets `signed_out`. */
const QUERY_REASON_VIEW = {
  expired: { key: "sessionExpired", tone: "neutral" },
  signed_out: { key: "signedOut", tone: "neutral" },
  disabled: { key: "accountDisabled", tone: "error" },
} as const satisfies Record<string, LoginReasonView>;

export type LoginReason = keyof typeof QUERY_REASON_VIEW;

/** The only way the /login address is built (design-identity.md, Contract «Вход и сеанс»). */
export function loginPath({ reason, next }: { reason: LoginReason; next?: string }): string {
  const query = new URLSearchParams({ reason });
  if (next !== undefined) query.set("next", next);
  return `/login?${query.toString()}`;
}

const isLoginReason = (value: string): value is LoginReason => Object.hasOwn(QUERY_REASON_VIEW, value);

const signInErrorReason = (error: string | undefined) => {
  const parsed = SignInErrorSchema.safeParse(error);
  return parsed.success ? SIGN_IN_ERROR_REASON[parsed.data] : undefined;
};

/** Whether the reason of `error` names the provider, so the page waits for the provider list before showing it. */
export const signInErrorNamesProvider = (error: string | undefined): boolean =>
  typeof signInErrorReason(error) === "object";

/** The general sign-in failure, through `providerName` when it is known. */
export const signInFailedReason = (providerName: string | undefined): LoginReasonView =>
  providerReasonView(SIGN_IN_FAILED, providerName);

function providerReasonView(reason: ProviderReason, providerName: string | undefined): LoginReasonView {
  return providerName === undefined
    ? { key: reason.unnamed, tone: "error" }
    : { key: reason.named, tone: "error", provider: providerName };
}

/**
 * LG-02 reason for the query of /login: `error` (return from a provider) wins over `reason` (401 handler,
 * sign-out). An unknown value shows nothing.
 */
export function loginReasonOf({
  reason,
  error,
  providerName,
}: {
  reason: string | undefined;
  error: string | undefined;
  providerName: string | undefined;
}): LoginReasonView | null {
  const errorReason = signInErrorReason(error);
  if (errorReason !== undefined) {
    return typeof errorReason === "object" ? providerReasonView(errorReason, providerName) : { key: errorReason, tone: "error" };
  }
  if (reason !== undefined && isLoginReason(reason)) return QUERY_REASON_VIEW[reason];
  return null;
}
