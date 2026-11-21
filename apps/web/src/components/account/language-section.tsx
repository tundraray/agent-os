"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useStore } from "zustand";
import { LanguageSchema, type Language } from "@agent-os/contracts";
import { useShellServices } from "@/components/shell/shell-actions";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { describeApiError } from "@/lib/api/api-request";
import { authApi } from "@/lib/auth/auth-api";
import type { CurrentUserStore } from "@/lib/auth/current-user";
import { logger } from "@/lib/logger";

/** MC-2: each language is named in itself, so the option carries its own `lang` (UXRD Accessibility). */
const OPTION_LABEL = { en: "optionEn", ru: "optionRu" } as const satisfies Record<Language, string>;
const OPTIONS = LanguageSchema.options.map((value) => ({ value, label: OPTION_LABEL[value] }));

/**
 * LN-01 of the i18n UXRD: the interface language, saved at once on choice (settings-form «Сохранение на
 * месте»). The checked option is `CurrentUser.language`; the section reads nothing itself. After the API
 * confirms, `router.refresh()` redraws the server tree in the new language (KD-3) and mounted state —
 * this group's focus included — stays. While saving and refreshing the group is marked unavailable but
 * not `disabled`, which would drop focus.
 */
export function LanguageSection({ currentUser }: { currentUser: CurrentUserStore }) {
  const t = useTranslations("account.language");
  const router = useRouter();
  const { announcer } = useShellServices();
  const headingId = useId();
  const hintId = useId();
  const user = useStore(currentUser, (state) => state.user);
  const [pending, setPending] = useState<Language | null>(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const [refreshing, startRefresh] = useTransition();
  const savedRef = useRef(false);
  const itemRefs = useRef(new Map<Language, HTMLElement>());

  // The refresh has committed: the announcer translates with the new catalog, so MC-6 speaks the new language.
  useEffect(() => {
    if (refreshing || !savedRef.current) return;
    savedRef.current = false;
    setPending(null);
    announcer.getState().announce("account.language.announced");
  }, [refreshing, announcer]);

  // UXRD «Focus order»: after a refusal focus stays on the option checked again, or the first one.
  useEffect(() => {
    if (!failed) return;
    const back = user?.language ?? LanguageSchema.options[0];
    itemRefs.current.get(back)?.focus();
  }, [failed, user?.language]);

  if (user === null) return null;

  const busy = saving || refreshing || pending !== null;
  const checked = pending ?? user.language;

  async function choose(language: Language): Promise<void> {
    if (busy || language === user?.language) return;
    setPending(language);
    setFailed(false);
    setSaving(true);
    try {
      await authApi.saveLanguage(language);
      logger.info("account: language saved", { language });
      currentUser.setLanguage(language);
      savedRef.current = true;
      startRefresh(() => router.refresh());
    } catch (cause) {
      logger.error("account: language save failed", { language, ...describeApiError(cause) });
      setPending(null);
      setFailed(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section aria-labelledby={headingId} className="flex max-w-160 flex-col gap-4">
      <h2 id={headingId} className="text-base leading-6 font-semibold">
        {t("heading")}
      </h2>
      <div className="flex flex-col gap-1.5">
        <RadioGroup
          aria-labelledby={headingId}
          aria-describedby={hintId}
          aria-disabled={busy || undefined}
          value={checked}
          onValueChange={(next) => {
            const option = OPTIONS.find((candidate) => candidate.value === next);
            if (option !== undefined) void choose(option.value);
          }}
          className="flex flex-wrap gap-6"
        >
          {OPTIONS.map((option) => (
            <Label
              key={option.value}
              lang={option.value}
              className="flex w-fit items-center gap-2 text-sm leading-5 font-normal text-foreground pointer-coarse:min-h-11"
            >
              <RadioGroupItem
                value={option.value}
                ref={(node: HTMLElement | null) => {
                  if (node === null) itemRefs.current.delete(option.value);
                  else itemRefs.current.set(option.value, node);
                }}
              />
              {t(option.label)}
            </Label>
          ))}
        </RadioGroup>
        {failed ? (
          <p id={hintId} role="alert" className="text-xs leading-4 text-destructive">
            {t("saveFailed")}
          </p>
        ) : (
          <p id={hintId} className="text-xs leading-4 text-muted-foreground">
            {checked === null ? t("notChosen") : t("appliesEverywhere")}
          </p>
        )}
      </div>
    </section>
  );
}
