"use client";

import { useEffect, useRef, useState, type MouseEvent, type ReactNode, type Ref } from "react";
import { LoaderCircle, TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { CAPTION } from "@/components/admin/admin-form";
import { Button } from "@/components/ui/button";
import { cn } from "cn";
import type { RecordFormStatus } from "./use-record-form";

/** «Сохранено» stays this long, then the state line is empty (record-editor.md, States). */
const SAVED_SHOWN_MS = 4000;

/** A control that stays in the Tab order while unavailable (`aria-disabled`, record-editor.md, States). */
const unavailable = (event: MouseEvent<HTMLButtonElement>, off: boolean): boolean => {
  if (off) event.preventDefault();
  return off;
};

export type SavePanelProps = {
  status: RecordFormStatus;
  /** A new record: «Создать» instead of «Сохранить». */
  isNew: boolean;
  /** «Использовать в чате» in place of the save buttons after a save; `null` — the record has no such action. */
  onUseInChat: (() => void) | null;
  /** The editor was opened from a draft card: «Вернуться в беседу» takes that place instead (DC-12). */
  onBackToChat: (() => void) | null;
  onDiscard: () => void;
  /** The button that takes the focus after a save. */
  useInChatRef: Ref<HTMLButtonElement>;
};

/**
 * Part 10 of record-editor.md: sticks to the bottom of the main area. The state on the left (a dot only
 * below 768 px), «Отменить изменения» and «Сохранить» (a submit of the form) on the right; after a save,
 * «Использовать в чате» (or «Вернуться в беседу») takes their place. The panel keeps its height when its state changes.
 */
export function SavePanel({ status, isNew, onUseInChat, onBackToChat, onDiscard, useInChatRef }: SavePanelProps) {
  const t = useTranslations("library");
  const tCommon = useTranslations("common");
  const savedShown = useSavedShown(status);
  const saving = status === "saving";
  const changed = status === "changed" || status === "conflict";
  const next =
    onBackToChat !== null
      ? { label: t("editor.panel.backToChat"), onClick: onBackToChat }
      : onUseInChat !== null
        ? { label: t("row.useInChat"), onClick: onUseInChat }
        : null;
  const showNext = status === "saved" && next !== null;

  return (
    <div role="region" aria-label={t("editor.panel.region")}className="shrink-0 border-t border-border bg-background">
      <div className="mx-auto flex min-h-12 w-full max-w-180 items-center justify-between gap-2 px-4 py-2">
        <p
          key={`${status}-${savedShown}`}
          className={cn(CAPTION, "flex min-w-0 items-center gap-2 text-muted-foreground duration-150 animate-in fade-in-0 motion-reduce:animate-none")}
        >
          {changed && (
            <>
              <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-muted-foreground" />
              <span className="max-md:sr-only">{t("editor.panel.changed")}</span>
            </>
          )}
          {saving && (
            <>
              <LoaderCircle aria-hidden className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" />
              {tCommon("saving")}
            </>
          )}
          {status === "saved" && savedShown && tCommon("saved")}
        </p>
        <div className="flex shrink-0 items-center gap-2">
          {showNext ? (
            <Button ref={useInChatRef} type="button" variant="outline" size="sm" className="pointer-coarse:h-11" onClick={next.onClick}>
              {next.label}
            </Button>
          ) : (
            <>
              {changed && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="pointer-coarse:h-11"
                  aria-disabled={saving}
                  onClick={(event) => {
                    if (!unavailable(event, saving)) onDiscard();
                  }}
                >
                  <span className="max-md:hidden">{t("editor.panel.discard")}</span>
                  <span className="md:hidden">{t("editor.panel.discardShort")}</span>
                </Button>
              )}
              <Button
                type="submit"
                size="sm"
                className="pointer-coarse:h-11"
                aria-disabled={saving || !changed}
                onClick={(event) => unavailable(event, saving || !changed)}
              >
                {t(isNew ? "editor.panel.create" : "editor.panel.save")}
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** `true` for four seconds after the panel reaches «Сохранено». */
function useSavedShown(status: RecordFormStatus): boolean {
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    if (status !== "saved") return;
    const timer = setTimeout(() => setExpired(true), SAVED_SHOWN_MS);
    return () => {
      clearTimeout(timer);
      setExpired(false);
    };
  }, [status]);
  return status === "saved" && !expired;
}

export type ConflictBlockProps = {
  /** MC-10 with the fields the saved version changed, or without them when it could not be read. */
  text: ReactNode;
  /** `false` — the saved version was not read, so there is nothing to take. */
  canTakeSaved: boolean;
  onSaveMine: () => void;
  onTakeSaved: () => void;
};

/** Part 9 of record-editor.md: above the panel; takes the focus when it appears; the typed values stay. */
export function ConflictBlock({ text, canTakeSaved, onSaveMine, onTakeSaved }: ConflictBlockProps) {
  const t = useTranslations("library.editor.panel");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <div
      ref={ref}
      role="alert"
      tabIndex={-1}
      className="flex items-start gap-2 rounded-md border border-warning-border bg-warning-subtle px-3 py-2 text-sm leading-5 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
      <div className="flex min-w-0 flex-col gap-2">
        <p>{text}</p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" className="pointer-coarse:h-11" onClick={onSaveMine}>
            {t("saveMine")}
          </Button>
          {canTakeSaved && (
            <Button type="button" variant="outline" size="sm" className="pointer-coarse:h-11" onClick={onTakeSaved}>
              {t("takeSaved")}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
