"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { CircleX, Eye, EyeOff, Info, LoaderCircle } from "lucide-react";
import { cn } from "cn";
import { IdentityErrorCode, type ProviderButtonList } from "@agent-os/contracts";
import { Button, buttonVariants } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldSeparator } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { describeApiError, isApiRequestError } from "@/lib/api/api-request";
import { authApi } from "@/lib/auth/auth-api";
import {
  LOGIN_TEXT,
  loginReasonOf,
  safeNextPath,
  signInErrorNamesProvider,
  signInFailedText,
  type LoginReasonView,
} from "@/lib/auth/login-reason";
import { apiBaseUrl } from "@/lib/config";
import { logger } from "@/lib/logger";

export type LoginFormProps = {
  /** `reason` of the query: `expired`, `disabled`, `signed_out`. */
  reason?: string;
  /** `error` of the query after a failed provider sign-in. */
  error?: string;
  /** `provider` of the query: id of the provider the employee came back from. */
  provider?: string;
  next?: string;
};

type FieldErrors = { login?: string; password?: string };

/** LG-01..LG-03 of uxrd Screen 1: the reason, the login and password form and the provider buttons. */
export function LoginForm({ reason, error, provider, next }: LoginFormProps) {
  const nextPath = safeNextPath(next);
  const [providers, setProviders] = useState<ProviderButtonList | null>(null);
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [passwordShown, setPasswordShown] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formReason, setFormReason] = useState<LoginReasonView | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [leavingTo, setLeavingTo] = useState<string | null>(null);
  const loginRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    authApi
      .providers()
      .then((list) => {
        if (active) setProviders(list);
      })
      .catch((cause: unknown) => {
        // The password form still works; the page shows no provider buttons.
        logger.error("login: provider list failed", describeApiError(cause));
        if (active) setProviders([]);
      });
    return () => {
      active = false;
    };
  }, []);

  // After a refused sign-in the password field is enabled again in this commit, so it can take focus.
  useEffect(() => {
    if (formReason !== null) passwordRef.current?.focus();
  }, [formReason]);

  const providerName = providers?.find((item) => item.id === provider)?.name;
  const queryReason =
    providers === null && signInErrorNamesProvider(error) ? null : loginReasonOf({ reason, error, providerName });
  const shownReason = formReason ?? queryReason;
  const busy = submitting || leavingTo !== null;

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const errors: FieldErrors = {
      login: login.trim() === "" ? LOGIN_TEXT.loginRequired : undefined,
      password: password === "" ? LOGIN_TEXT.passwordRequired : undefined,
    };
    setFieldErrors(errors);
    if (errors.login !== undefined || errors.password !== undefined) {
      (errors.login !== undefined ? loginRef : passwordRef).current?.focus();
      return;
    }
    setSubmitting(true);
    try {
      await authApi.signInWithPassword({ login: login.trim(), password });
      logger.info("login: password sign-in succeeded");
      window.location.assign(nextPath);
    } catch (cause) {
      const refused =
        isApiRequestError(cause) &&
        (cause.code === IdentityErrorCode.INVALID_CREDENTIALS || cause.code === IdentityErrorCode.ACCOUNT_DISABLED);
      if (refused) logger.warn("login: password sign-in refused", describeApiError(cause));
      else logger.error("login: password sign-in failed", describeApiError(cause));
      setSubmitting(false);
      setFormReason(passwordFailureReason(cause));
      setPassword("");
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {shownReason !== null && <ReasonBlock reason={shownReason} />}
      <form noValidate onSubmit={handleSubmit}>
        <FieldGroup className="gap-4">
          <Field data-invalid={fieldErrors.login !== undefined}>
            <FieldLabel htmlFor="login">Логин</FieldLabel>
            <Input
              ref={loginRef}
              id="login"
              name="login"
              autoComplete="username"
              className="h-9"
              value={login}
              disabled={busy}
              aria-invalid={fieldErrors.login !== undefined}
              aria-describedby={fieldErrors.login !== undefined ? "login-error" : undefined}
              onChange={(event) => {
                setLogin(event.target.value);
                setFieldErrors((current) => ({ ...current, login: undefined }));
              }}
            />
            <FieldError id="login-error">{fieldErrors.login}</FieldError>
          </Field>
          <Field data-invalid={fieldErrors.password !== undefined}>
            <FieldLabel htmlFor="password">Пароль</FieldLabel>
            <div className="relative">
              <Input
                ref={passwordRef}
                id="password"
                name="password"
                type={passwordShown ? "text" : "password"}
                autoComplete="current-password"
                className="h-9 pr-10"
                value={password}
                disabled={busy}
                aria-invalid={fieldErrors.password !== undefined}
                aria-describedby={fieldErrors.password !== undefined ? "password-error" : undefined}
                onChange={(event) => {
                  setPassword(event.target.value);
                  setFieldErrors((current) => ({ ...current, password: undefined }));
                }}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="absolute top-1/2 right-1 -translate-y-1/2"
                aria-label={passwordShown ? "Скрыть пароль" : "Показать пароль"}
                aria-pressed={passwordShown}
                disabled={busy}
                onClick={() => setPasswordShown((shown) => !shown)}
              >
                {passwordShown ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
              </Button>
            </div>
            <FieldError id="password-error">{fieldErrors.password}</FieldError>
          </Field>
          <Button type="submit" size="lg" className="w-full" disabled={busy}>
            {submitting && <LoaderCircle className="animate-spin" aria-hidden />}
            {submitting ? "Входим…" : "Войти"}
          </Button>
          <FieldDescription>Забыли пароль — обратитесь к администратору Agent OS.</FieldDescription>
        </FieldGroup>
      </form>
      {providers !== null && providers.length > 0 && (
        <div className="flex flex-col gap-4">
          <FieldSeparator>или</FieldSeparator>
          {providers.map((item) => {
            const leaving = leavingTo === item.id;
            return (
              <a
                key={item.id}
                href={`${apiBaseUrl}/api/auth/sign-in/${encodeURIComponent(item.id)}?${new URLSearchParams({ next: nextPath }).toString()}`}
                aria-disabled={busy || undefined}
                tabIndex={busy ? -1 : undefined}
                className={cn(
                  buttonVariants({ variant: "outline", size: "lg" }),
                  "h-11 w-full",
                  busy && "pointer-events-none opacity-50",
                  leaving && "opacity-100",
                )}
                onClick={() => setLeavingTo(item.id)}
              >
                {leaving && <LoaderCircle className="animate-spin" aria-hidden />}
                {leaving ? `Переходим в ${item.name}…` : `Войти через ${item.name}`}
              </a>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** LG-02: the danger block for a failure, the muted one for «Вы вышли» and «Сеанс закончился». */
function ReasonBlock({ reason }: { reason: LoginReasonView }) {
  const neutral = reason.tone === "neutral";
  const Icon = neutral ? Info : CircleX;
  return (
    <div
      role={neutral ? "status" : "alert"}
      className={cn(
        "flex items-start gap-2 rounded-lg border px-3 py-2.5 text-sm text-foreground",
        neutral ? "border-border bg-muted" : "border-destructive-border bg-destructive-subtle",
      )}
    >
      <Icon className={cn("mt-0.5 size-4 shrink-0", neutral ? "text-muted-foreground" : "text-destructive")} aria-hidden />
      <p>{reason.text}</p>
    </div>
  );
}

/** One text for a wrong login and a wrong password (AC-01.3); the disabled account only after a right password. */
function passwordFailureReason(cause: unknown): LoginReasonView {
  if (isApiRequestError(cause) && cause.code === IdentityErrorCode.INVALID_CREDENTIALS) {
    return { text: LOGIN_TEXT.invalidCredentials, tone: "error" };
  }
  if (isApiRequestError(cause) && cause.code === IdentityErrorCode.ACCOUNT_DISABLED) {
    return { text: LOGIN_TEXT.accountDisabled, tone: "error" };
  }
  return { text: signInFailedText(undefined), tone: "error" };
}
