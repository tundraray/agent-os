"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { CircleX, Info, LoaderCircle } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "cn";
import { IdentityErrorCode, nextPath, type ProviderButtonList } from "@agent-os/contracts";
import { Button, buttonVariants } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldSeparator } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { PasswordField } from "@/components/password-field";
import { describeApiError, isApiRequestError } from "@/lib/api/api-request";
import { authApi } from "@/lib/auth/auth-api";
import { loginReasonOf, signInErrorNamesProvider, signInFailedReason, type LoginReasonView } from "@/lib/auth/login-reason";
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
  const t = useTranslations("login");
  const returnPath = nextPath(next);
  const [providers, setProviders] = useState<ProviderButtonList | null>(null);
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
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
      login: login.trim() === "" ? t("loginRequired") : undefined,
      password: password === "" ? t("passwordRequired") : undefined,
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
      window.location.assign(returnPath);
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
            <FieldLabel htmlFor="login">{t("loginLabel")}</FieldLabel>
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
          <PasswordField
            id="password"
            label={t("passwordLabel")}
            autoComplete="current-password"
            inputRef={passwordRef}
            value={password}
            error={fieldErrors.password}
            disabled={busy}
            onChange={(value) => {
              setPassword(value);
              setFieldErrors((current) => ({ ...current, password: undefined }));
            }}
          />
          <Button type="submit" size="lg" className="w-full" disabled={busy}>
            {submitting && <LoaderCircle className="animate-spin" aria-hidden />}
            {submitting ? t("submitting") : t("submit")}
          </Button>
          <FieldDescription>{t("forgotPassword")}</FieldDescription>
        </FieldGroup>
      </form>
      {providers !== null && providers.length > 0 && (
        <div className="flex flex-col gap-4">
          <FieldSeparator>{t("or")}</FieldSeparator>
          {providers.map((item) => {
            const leaving = leavingTo === item.id;
            return (
              <a
                key={item.id}
                href={authApi.providerSignInUrl(item.id, returnPath)}
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
                {t(leaving ? "providerLeaving" : "providerSignIn", { provider: item.name })}
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
  const t = useTranslations("login.reason");
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
      <p>{t(reason.key, { provider: reason.provider ?? "" })}</p>
    </div>
  );
}

/** One text for a wrong login and a wrong password (AC-01.3); the disabled account only after a right password. */
function passwordFailureReason(cause: unknown): LoginReasonView {
  if (isApiRequestError(cause) && cause.code === IdentityErrorCode.INVALID_CREDENTIALS) {
    return { key: "invalidCredentials", tone: "error" };
  }
  if (isApiRequestError(cause) && cause.code === IdentityErrorCode.ACCOUNT_DISABLED) {
    return { key: "accountDisabled", tone: "error" };
  }
  return signInFailedReason(undefined);
}
