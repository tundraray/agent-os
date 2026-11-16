import { SignInErrorSchema, type SignInError } from "@agent-os/contracts";

/** How LG-02 looks: the subtle danger block, or the neutral one for a reason that is not a failure. */
export type LoginReasonTone = "error" | "neutral";

export type LoginReasonView = { text: string; tone: LoginReasonTone };

/** Texts of the sign-in page (uxrd MC-3). A wrong login and a wrong password share one text. */
export const LOGIN_TEXT = {
  invalidCredentials: "Неверный логин или пароль.",
  cancelled: "Вход отменён. Попробуйте ещё раз.",
  accountDisabled: "Ваша учётная запись отключена. Обратитесь к администратору Agent OS.",
  sessionExpired: "Сеанс закончился. Войдите снова.",
  signedOut: "Вы вышли из Agent OS.",
  loginRequired: "Введите логин",
  passwordRequired: "Введите пароль",
} as const;

/** «{название}» of MC-3 when the provider is unknown to the page (switched off, or the id is missing). */
const noEmailText = (providerName: string | undefined): string =>
  `${providerName ?? "Провайдер"} не сообщил вашу почту, поэтому войти нельзя. Войдите другим способом или обратитесь к администратору Agent OS.`;

export const signInFailedText = (providerName: string | undefined): string =>
  `Не удалось войти${providerName === undefined ? "" : ` через ${providerName}`}. Попробуйте ещё раз или обратитесь к администратору Agent OS.`;

/** Text of each provider sign-in error; a function is a text that names the provider. */
const SIGN_IN_ERROR_TEXT: Record<SignInError, string | ((providerName: string | undefined) => string)> = {
  cancelled: LOGIN_TEXT.cancelled,
  failed: signInFailedText,
  no_email: noEmailText,
  account_disabled: LOGIN_TEXT.accountDisabled,
  provider_unavailable: signInFailedText,
};

/** `reason` of /login: the 401 handler sets `expired` or `disabled`, «Выйти» sets `signed_out`. */
const QUERY_REASON_VIEW = {
  expired: { text: LOGIN_TEXT.sessionExpired, tone: "neutral" },
  signed_out: { text: LOGIN_TEXT.signedOut, tone: "neutral" },
  disabled: { text: LOGIN_TEXT.accountDisabled, tone: "error" },
} as const satisfies Record<string, LoginReasonView>;

export type LoginReason = keyof typeof QUERY_REASON_VIEW;

/** The only way the /login address is built (design-identity.md, Contract «Вход и сеанс»). */
export function loginPath({ reason, next }: { reason: LoginReason; next?: string }): string {
  const query = new URLSearchParams({ reason });
  if (next !== undefined) query.set("next", next);
  return `/login?${query.toString()}`;
}

const isLoginReason = (value: string): value is LoginReason => Object.hasOwn(QUERY_REASON_VIEW, value);

const signInErrorText = (error: string | undefined) => {
  const parsed = SignInErrorSchema.safeParse(error);
  return parsed.success ? SIGN_IN_ERROR_TEXT[parsed.data] : undefined;
};

/** Whether the reason of `error` names the provider, so the page waits for the provider list before showing it. */
export const signInErrorNamesProvider = (error: string | undefined): boolean =>
  typeof signInErrorText(error) === "function";

/**
 * LG-02 text for the query of /login: `error` (return from a provider) wins over `reason` (401 handler,
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
  const errorText = signInErrorText(error);
  if (errorText !== undefined) {
    return { text: typeof errorText === "function" ? errorText(providerName) : errorText, tone: "error" };
  }
  if (reason !== undefined && isLoginReason(reason)) return QUERY_REASON_VIEW[reason];
  return null;
}
