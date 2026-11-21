"use client";

import { useId } from "react";
import { ArrowRight, Info } from "lucide-react";
import { useTranslations } from "next-intl";
import { CAPTION } from "@/components/admin/admin-form";
import { ShellLink } from "@/components/shell/shell-link";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription } from "@/components/ui/field";
import { Label } from "@/components/ui/label";
import { KNOWLEDGE_TEXT } from "@/lib/library/knowledge-view";
import { cn } from "cn";

/** Self-learning UXRD, MC-1. */
const TEXT = {
  hint: "Запуски запоминают, где что нашли, и это получат все следующие запуски — кто бы их ни начал, даже без доступа к этим системам.",
  kept: "Знания сохранятся: включите снова — запуски продолжат с них.",
} as const;

export type SelfLearningFieldProps = {
  checked: boolean;
  /** The flag of the saved record: unticking a saved self-learning workflow shows that its knowledge is kept. */
  savedOn: boolean;
  /** The knowledge screen of a saved workflow; `null` while the workflow is new. */
  knowledgeHref: string | null;
  onChange: (checked: boolean) => void;
};

/**
 * «Самообучение» (self-learning UXRD, SL-01; record-editor.md, variant «Workflow»). The hint and the «kept» note
 * are the checkbox's description, not alerts. The link goes through `ShellLink`, so leaving with unsaved edits
 * is asked about by the shell's guard (MC-11).
 */
export function SelfLearningField({ checked, savedOn, knowledgeHref, onChange }: SelfLearningFieldProps) {
  const id = useId();
  const t = useTranslations("library");
  const hintId = `${id}-hint`;
  const noteId = `${id}-note`;
  const kept = savedOn && !checked;

  return (
    <Field className="gap-1.5">
      <Label className="flex w-fit items-center gap-2 text-sm leading-5 font-medium text-foreground pointer-coarse:min-h-11">
        <Checkbox
          checked={checked}
          aria-describedby={kept ? `${hintId} ${noteId}` : hintId}
          onCheckedChange={(next) => onChange(next)}
        />
        {t("fields.selfLearning")}
      </Label>
      <FieldDescription id={hintId} className={cn(CAPTION, "text-muted-foreground")}>
        {TEXT.hint}
      </FieldDescription>
      {kept && (
        <p id={noteId} className={cn(CAPTION, "flex items-start gap-1.5 text-foreground")}>
          <Info aria-hidden className="mt-px size-3.5 shrink-0 text-info" />
          {TEXT.kept}
        </p>
      )}
      {knowledgeHref !== null && (
        <ShellLink
          href={knowledgeHref}
          className="inline-flex w-fit items-center gap-1 rounded-sm text-sm leading-5 font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 pointer-coarse:min-h-11"
        >
          {KNOWLEDGE_TEXT.entry}
          <ArrowRight aria-hidden className="size-3.5" />
        </ShellLink>
      )}
    </Field>
  );
}
