"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { CircleX, LoaderCircle } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { IdentityValidationReason } from "@agent-os/contracts";
import { Button } from "@/components/ui/button";
import { FieldGroup } from "@/components/ui/field";
import { PasswordField } from "@/components/password-field";
import { describeApiError, isApiRequestError } from "@/lib/api/api-request";
import { authApi } from "@/lib/auth/auth-api";
import { logger } from "@/lib/logger";

/** UXRD MC-35: a field's message, kept as its key so a language change redraws it. */
type FieldError = "wrongCurrent" | "currentRequired" | "weak";
type FieldErrors = { current?: FieldError; next?: FieldError };

/**
 * MA-03 of UXRD Screen 3: the change of one's own password, only for an account with a password
 * (`CurrentUser.hasPassword`). The 12..256 rule is the API's (`weak_password`), so the form checks only
 * that the fields are filled.
 */
export function PasswordSection({ hasPassword }: { hasPassword: boolean }) {
  const t = useTranslations("account.password");
  const headingId = useId();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  // settings-form «Сервер отказал»: MC-35 names no text for an answer other than its two reasons.
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const currentRef = useRef<HTMLInputElement>(null);
  const nextRef = useRef<HTMLInputElement>(null);
  const formErrorRef = useRef<HTMLDivElement>(null);

  // Fields are enabled again in the commit that shows the error, so focus moves after it (settings-form).
  useEffect(() => {
    if (errors.current !== undefined) currentRef.current?.focus();
    else if (errors.next !== undefined) nextRef.current?.focus();
  }, [errors]);
  useEffect(() => {
    if (failed) formErrorRef.current?.focus();
  }, [failed]);

  if (!hasPassword) return null;

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const checked: FieldErrors = {
      current: current === "" ? "currentRequired" : undefined,
      next: next === "" ? "weak" : undefined,
    };
    setFailed(false);
    setErrors(checked);
    if (checked.current !== undefined || checked.next !== undefined) return;

    setSaving(true);
    try {
      await authApi.changePassword({ currentPassword: current, newPassword: next });
      logger.info("account: password changed");
      setCurrent("");
      setNext("");
      toast.success(t("changed"));
    } catch (cause) {
      const reason = isApiRequestError(cause) ? cause.reason : undefined;
      if (reason === IdentityValidationReason.WRONG_CURRENT_PASSWORD) {
        logger.warn("account: password change refused", describeApiError(cause));
        setErrors({ current: "wrongCurrent" });
      } else if (reason === IdentityValidationReason.WEAK_PASSWORD) {
        logger.warn("account: password change refused", describeApiError(cause));
        setErrors({ next: "weak" });
      } else {
        logger.error("account: password change failed", describeApiError(cause));
        setFailed(true);
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <section aria-labelledby={headingId} className="flex max-w-160 flex-col gap-4">
      <h2 id={headingId} className="text-base leading-6 font-semibold">
        {t("heading")}
      </h2>
      <form noValidate onSubmit={handleSubmit}>
        <FieldGroup className="gap-4">
          <PasswordField
            id="current-password"
            label={t("current")}
            autoComplete="current-password"
            inputRef={currentRef}
            value={current}
            error={errors.current === undefined ? undefined : t(errors.current)}
            disabled={saving}
            onChange={(value) => {
              setCurrent(value);
              setErrors((shown) => ({ ...shown, current: undefined }));
            }}
          />
          <PasswordField
            id="new-password"
            label={t("next")}
            autoComplete="new-password"
            inputRef={nextRef}
            value={next}
            error={errors.next === undefined ? undefined : t(errors.next)}
            disabled={saving}
            onChange={(value) => {
              setNext(value);
              setErrors((shown) => ({ ...shown, next: undefined }));
            }}
          />
          {failed && (
            <div
              ref={formErrorRef}
              role="alert"
              tabIndex={-1}
              className="flex items-start gap-2 rounded-lg border border-destructive-border bg-destructive-subtle px-3 py-2.5 text-sm text-foreground outline-none"
            >
              <CircleX className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
              <p>{t("failed")}</p>
            </div>
          )}
          <div>
            <Button type="submit" className="h-9 pointer-coarse:h-11" disabled={saving}>
              {saving && <LoaderCircle className="animate-spin" aria-hidden />}
              {saving ? t("saving") : t("submit")}
            </Button>
          </div>
        </FieldGroup>
      </form>
    </section>
  );
}
