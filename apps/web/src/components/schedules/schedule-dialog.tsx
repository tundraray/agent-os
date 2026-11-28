'use client';

import {
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentProps,
  type FormEvent,
  type ReactNode,
} from 'react';
import { useRouter } from 'next/navigation';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { LoaderCircle } from 'lucide-react';
import { toast } from 'sonner';
import {
  CHAT_MESSAGE_MAX_LENGTH,
  SCHEDULE_NAME_MAX_LENGTH,
  type ChipRecord,
  type ScheduleAccess,
  type ScheduleBody,
  type ScheduleTarget,
  type ScheduleView,
} from '@agent-os/contracts';
import { AgentField } from '@/components/agent-field';
import {
  AdminRadioField,
  AdminTextField,
  CAPTION,
  COMFORT_CONTROL,
  FormError,
} from '@/components/admin/admin-form';
import { Checkbox } from '@/components/ui/checkbox';
import { FieldError } from '@/components/ui/field';
import {
  checkRule,
  defaultRuleDraft,
  formatRunTime,
  isPastRefusal,
  ruleDraftOf,
  ScheduleRuleField,
  type RuleDraft,
  type RuleError,
} from '@/components/schedules/schedule-rule-field';
import { useChatAgents } from '@/components/assistant-ui/elements/composer-actions';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from 'cn';
import { describeApiError } from '@/lib/api/api-request';
import { logger } from '@/lib/logger';
import { startTimer } from '@/lib/timer';
import { schedulePath } from '@/lib/shell-route';
import { schedulesApi } from '@/lib/schedules/schedules-api';
import { describeSchedulesError } from '@/lib/schedules/schedules-errors';

/**
 * SP-04: the schedule dialog (settings-form «Форма диалога», comfortable density), opened by the pages and by the
 * schedule card. A new schedule starts empty, with the chat agent, the default rule, the browser's zone and «Только
 * чтение»; an edit starts from the saved schedule. The body mounts with the open dialog, so every open starts from
 * those values — and with the consent unticked (chat-scheduling KD-3, KD-5).
 */

export type ScheduleDialogMode =
  { kind: 'create' } | { kind: 'edit'; schedule: ScheduleView };

export type ScheduleDialogProps = {
  mode: ScheduleDialogMode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The schedule as the server saved it; the dialog has closed by then. */
  onSaved: (schedule: ScheduleView) => void;
  /** Where focus goes on close when the dialog opened from a menu item, which unmounts with its menu. */
  finalFocus?: ComponentProps<typeof DialogContent>['finalFocus'];
};

export function ScheduleDialog({
  mode,
  open,
  onOpenChange,
  onSaved,
  finalFocus,
}: ScheduleDialogProps) {
  const t = useTranslations('schedules.dialog');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        finalFocus={finalFocus}
        className="flex max-h-[calc(100dvh-2rem)] flex-col sm:max-w-140"
      >
        <DialogHeader>
          <DialogTitle className="text-base leading-6 font-semibold">
            {t(mode.kind === 'edit' ? 'editTitle' : 'createTitle')}
          </DialogTitle>
        </DialogHeader>
        <ScheduleForm
          mode={mode}
          onSaved={(saved) => {
            onOpenChange(false);
            onSaved(saved);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

type Values = {
  name: string;
  instruction: string;
  /** `null` — the chat agent. */
  agentId: string | null;
  rule: RuleDraft;
  timeZone: string;
  target: ScheduleTarget;
  access: ScheduleAccess;
};

type FieldErrors = {
  instruction?: string;
  agent?: string;
  rule?: RuleError;
  target?: string;
};

/** Where the dialog stands: the conversation it answers in and its first values. */
type Start = {
  values: Values;
  conversation: ScheduleView['conversation'];
  /** The agent the dialog started with, kept as a choice even when the field no longer lists it. */
  agent: ChipRecord | null;
};

function startOf(mode: ScheduleDialogMode, now: Date): Start {
  if (mode.kind === 'create') {
    return {
      values: {
        name: '',
        instruction: '',
        agentId: null,
        rule: defaultRuleDraft(now),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        target: 'new_conversation',
        access: 'read',
      },
      conversation: null,
      agent: null,
    };
  }
  const { schedule } = mode;
  return {
    values: {
      name: schedule.name,
      instruction: schedule.instruction,
      agentId: schedule.agent?.id ?? null,
      rule: ruleDraftOf(schedule.rule, now),
      timeZone: schedule.timeZone,
      // A deleted conversation takes no replies, so the dialog opens on the only target that can be saved.
      target: schedule.conversation?.deleted
        ? 'new_conversation'
        : schedule.target,
      access: schedule.access,
    },
    conversation: schedule.conversation,
    agent: schedule.agent,
  };
}

function ScheduleForm({
  mode,
  onSaved,
}: {
  mode: ScheduleDialogMode;
  onSaved: (schedule: ScheduleView) => void;
}) {
  const t = useTranslations('schedules');
  const tCommon = useTranslations('common');
  const tErrors = useTranslations('errors');
  const tThread = useTranslations('shell.thread');
  const locale = useLocale();
  const format = useFormatter();
  const router = useRouter();
  const id = useId();
  const chatAgents = useChatAgents();
  const [start] = useState(() => startOf(mode, new Date()));
  const [values, setValues] = useState(start.values);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<ReactNode>(null);
  const [saving, setSaving] = useState(false);
  /** The consent to «Полный доступ»: never ticked on open, cleared by every new choice of the access (AC-04.3). */
  const [consent, setConsent] = useState(false);
  /** Grows with every set of field errors shown, so focus moves to the first of them again. */
  const [errorsShown, setErrorsShown] = useState(0);
  /** The reply conversation was deleted while the dialog was open: the server refused it on save. */
  const [conversationGone, setConversationGone] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const targetRef = useRef<HTMLDivElement>(null);
  const consentRef = useRef<HTMLButtonElement>(null);

  // Runs after the commit that enables the fields again, so the field can take focus. The radio group carries no
  // invalid mark of its own, so its error focuses the chosen radio.
  useEffect(() => {
    if (errorsShown === 0) return;
    (
      formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]') ??
      targetRef.current?.querySelector<HTMLElement>('[data-checked]')
    )?.focus();
  }, [errorsShown]);

  const agents = agentChoices(
    chatAgents.map((agent) => agent.chip),
    start.agent,
  );
  const agentName =
    agents.find((agent) => agent.id === values.agentId)?.name ?? null;
  const conversation = start.conversation;
  // SP-04: the schedule's own conversation is a choice while it is there; a new schedule has none.
  const replyConversation =
    conversation === null || conversation.deleted || conversationGone
      ? null
      : conversation;
  /** KD-3: «Полный доступ» without the consent ticked holds the save. */
  const consentMissing = values.access === 'full' && !consent;

  const set = <Key extends keyof Values>(
    key: Key,
    value: Values[Key],
  ): void => {
    setValues((current) => ({ ...current, [key]: value }));
    const field = key === 'agentId' ? 'agent' : key;
    setErrors((shown) => ({ ...shown, [field]: undefined }));
  };

  const showErrors = (shown: FieldErrors): void => {
    setErrors(shown);
    setErrorsShown((count) => count + 1);
  };

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (saving) return;
    if (consentMissing) {
      consentRef.current?.focus();
      return;
    }
    setFormError(null);
    const checked = checkRule(values.rule);
    const instruction = values.instruction.trim();
    const found: FieldErrors = {
      ...(instruction === '' ? { instruction: t('errors.instruction') } : {}),
      ...('error' in checked ? { rule: checked.error } : {}),
    };
    if (!('rule' in checked) || Object.keys(found).length > 0) {
      showErrors(found);
      return;
    }
    const body: ScheduleBody = {
      name: values.name.trim(),
      instruction,
      agentId: values.agentId,
      rule: checked.rule,
      timeZone: values.timeZone,
      target: values.target,
      conversationId: conversation?.id ?? null,
      language: locale,
      access: values.access,
      // Only the ticked consent reaches here with `full`: `consentMissing` returned above.
      ...(values.access === 'full' ? { consent: true } : {}),
    };
    setErrors({});
    setSaving(true);
    const durationMs = startTimer();
    try {
      const saved =
        mode.kind === 'create'
          ? await schedulesApi.create(body)
          : await schedulesApi.update(mode.schedule.id, body);
      logger.info(
        `schedules: ${mode.kind === 'create' ? 'created' : 'saved'}`,
        { scheduleId: saved.id, durationMs: durationMs() },
      );
      notifySaved(saved);
      onSaved(saved);
    } catch (cause) {
      logger.warn('schedules: save refused', {
        scheduleId: mode.kind === 'edit' ? mode.schedule.id : null,
        durationMs: durationMs(),
        ...describeApiError(cause),
      });
      setSaving(false);
      if (isPastRefusal(body.rule, cause)) {
        showErrors({ rule: 'past' });
        return;
      }
      const refusal = describeSchedulesError(tErrors, cause, {
        where: 'dialog',
        agentName,
      });
      if (refusal.place === 'agent') showErrors({ agent: refusal.text });
      else if (refusal.place === 'target') {
        setConversationGone(true);
        setValues((current) => ({ ...current, target: 'new_conversation' }));
        showErrors({ target: refusal.text });
      } else setFormError(refusal.text);
    }
  }

  /** MC-5: a new schedule names its next run and opens from the notice; an edit says it was saved. */
  function notifySaved(saved: ScheduleView): void {
    if (mode.kind === 'edit' || saved.nextRunAt === null) {
      toast.success(t('dialog.saved'));
      return;
    }
    toast.success(
      t('dialog.created', {
        at: formatRunTime(format, saved.nextRunAt, saved.timeZone),
      }),
      {
        action: {
          label: t('dialog.open'),
          onClick: () => router.push(schedulePath(saved.id)),
        },
      },
    );
  }

  const fieldId = (key: string): string => `${id}-${key}`;
  const consentHintId = fieldId('consent-hint');

  return (
    <form
      ref={formRef}
      noValidate
      onSubmit={(event) => void submit(event)}
      className="flex min-h-0 flex-col gap-4"
    >
      {/* The body scrolls in a div: a fieldset as the scroll container does not clip its content in the browser,
          so the fields slid under the footer. */}
      <div className="-mx-4 min-h-0 overflow-y-auto px-4">
        {/* A disabled fieldset disables every native field and button inside while the request runs. */}
        <fieldset disabled={saving} className="flex min-w-0 flex-col gap-4">
          <AdminTextField
            id={fieldId('name')}
            density="comfortable"
            label={t('dialog.name')}
            optional={t('dialog.optional')}
            hint={t('dialog.nameHint')}
            maxLength={SCHEDULE_NAME_MAX_LENGTH}
            value={values.name}
            error={undefined}
            onChange={(name) => set('name', name)}
          />
          <AdminTextField
            id={fieldId('instruction')}
            density="comfortable"
            multiline
            inputClassName="max-h-48 min-h-20"
            label={t('dialog.instruction')}
            hint={t('dialog.instructionHint')}
            maxLength={CHAT_MESSAGE_MAX_LENGTH}
            value={values.instruction}
            error={errors.instruction}
            onChange={(instruction) => set('instruction', instruction)}
          />
          <AgentField
            id={fieldId('agent')}
            agents={agents}
            value={values.agentId}
            error={errors.agent}
            onChange={(agentId) => set('agentId', agentId)}
          />
          <ScheduleRuleField
            draft={values.rule}
            onChange={(rule) => set('rule', rule)}
            timeZone={values.timeZone}
            onTimeZoneChange={(timeZone) => set('timeZone', timeZone)}
            error={errors.rule ?? null}
            disabled={saving}
          />
          <div ref={targetRef} className="flex flex-col gap-1.5">
            <AdminRadioField
              density="comfortable"
              label={t('dialog.target')}
              value={values.target}
              onChange={(target) => set('target', target)}
              options={[
                {
                  value: 'new_conversation',
                  label: t('dialog.newConversation'),
                  hint: t(
                    replyConversation === null
                      ? 'dialog.onlyNewConversationHint'
                      : 'dialog.newConversationHint',
                  ),
                  disabled: saving,
                },
                ...(replyConversation === null
                  ? []
                  : [
                      {
                        value: 'this_conversation' as const,
                        label: t('dialog.namedConversation', {
                          title:
                            replyConversation.title.trim() === ''
                              ? tThread('untitled')
                              : replyConversation.title,
                        }),
                        hint: t('dialog.thisConversationHint'),
                        disabled: saving,
                      },
                    ]),
              ]}
            />
            <FieldError className={CAPTION}>{errors.target}</FieldError>
          </div>
          <AdminRadioField
            density="comfortable"
            label={t('dialog.access.label')}
            value={values.access}
            onChange={(access) => {
              set('access', access);
              setConsent(false);
            }}
            options={(['read', 'full'] as const).map((access) => ({
              value: access,
              label: t(`dialog.access.${access}`),
              hint: t(`dialog.access.${access}Hint`),
              disabled: saving,
            }))}
          />
          {values.access === 'full' && (
            <label className="flex animate-in items-start gap-2 rounded-md border border-border bg-card p-2 text-sm leading-5 text-foreground fade-in-0 duration-(--duration-fast) motion-reduce:animate-none">
              <Checkbox
                ref={consentRef}
                checked={consent}
                onCheckedChange={setConsent}
                disabled={saving}
                className="mt-0.5 pointer-coarse:after:-inset-3.5"
              />
              <span>{t('dialog.access.consent')}</span>
            </label>
          )}
        </fieldset>
      </div>
      {formError !== null && <FormError>{formError}</FormError>}
      {consentMissing && (
        <p id={consentHintId} className={cn(CAPTION, 'text-muted-foreground')}>
          {t('dialog.access.consentHint')}
        </p>
      )}
      <DialogFooter className="sm:justify-start">
        <Button
          type="submit"
          className={cn(COMFORT_CONTROL, 'aria-disabled:opacity-50')}
          disabled={saving}
          aria-disabled={consentMissing || undefined}
          aria-describedby={consentMissing ? consentHintId : undefined}
        >
          {saving && (
            <LoaderCircle
              className="animate-spin motion-reduce:animate-none"
              aria-hidden
            />
          )}
          {saving
            ? tCommon('saving')
            : t(mode.kind === 'edit' ? 'dialog.save' : 'dialog.create')}
        </Button>
        <DialogClose
          render={
            <Button
              type="button"
              variant="outline"
              className={COMFORT_CONTROL}
            />
          }
          disabled={saving}
        >
          {tCommon('cancel')}
        </DialogClose>
      </DialogFooter>
    </form>
  );
}

/** The agents of «+» by name, with the dialog's starting agent kept when the field no longer lists it. */
function agentChoices(
  usable: readonly ChipRecord[],
  started: ChipRecord | null,
): ChipRecord[] {
  const known =
    started === null || usable.some((agent) => agent.id === started.id);
  return known ? [...usable] : [...usable, started];
}
