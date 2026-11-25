'use client';

import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { useRouter } from 'next/navigation';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { BotIcon, LoaderCircle } from 'lucide-react';
import { toast } from 'sonner';
import { useStore } from 'zustand';
import {
  CHAT_MESSAGE_MAX_LENGTH,
  SCHEDULE_NAME_MAX_LENGTH,
  type ChipRecord,
  type ScheduleBody,
  type ScheduleTarget,
  type ScheduleView,
} from '@agent-os/contracts';
import { CAPTION, FormError } from '@/components/admin/admin-form';
import { RECORD_KIND_ICON } from '@/components/library/record-label';
import {
  COMFORT_CONTROL,
  checkRule,
  defaultRuleDraft,
  formatRunTime,
  isPastRefusal,
  ruleDraftOf,
  ScheduleRuleField,
  type RuleDraft,
  type RuleError,
} from '@/components/schedules/schedule-rule-field';
import { useShellServices } from '@/components/shell/shell-actions';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { builtinName } from '@/i18n/builtin-name';
import { describeApiError } from '@/lib/api/api-request';
import { canUseInChat } from '@/lib/library/record-rules';
import { logger } from '@/lib/logger';
import { schedulePath } from '@/lib/shell-route';
import { schedulesApi } from '@/lib/schedules/schedules-api';
import { describeSchedulesError } from '@/lib/schedules/schedules-errors';
import { cn } from 'cn';

/**
 * SH-02: the schedule dialog (settings-form «Форма диалога», comfortable density). A new schedule starts from
 * the message field — its text, its agent chip and its conversation (UXRD KD-1); an edit starts from the saved
 * schedule. The body mounts with the open dialog, so every open starts from those values.
 */

export type ScheduleDialogMode =
  | {
      kind: 'create';
      /** The message field's text: the instruction. */
      text: string;
      /** The field's record chip; `null` — the chat agent. */
      agent: ChipRecord | null;
      /** The open conversation; `null` in a new chat without messages. */
      conversationId: string | null;
    }
  | { kind: 'edit'; schedule: ScheduleView };

export type ScheduleDialogProps = {
  mode: ScheduleDialogMode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The schedule as the server saved it; the dialog has closed by then. */
  onSaved: (schedule: ScheduleView) => void;
};

export function ScheduleDialog({
  mode,
  open,
  onOpenChange,
  onSaved,
}: ScheduleDialogProps) {
  const t = useTranslations('schedules.dialog');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col sm:max-w-140">
        <DialogHeader>
          <DialogTitle className="text-base leading-6 font-semibold">
            {t(mode.kind === 'create' ? 'createTitle' : 'editTitle')}
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

/** The value of «Агент чата» in the agent select: record ids are UUIDs, so it never meets one. */
const CHAT_AGENT = 'chat';

type Values = {
  name: string;
  instruction: string;
  agentId: string;
  rule: RuleDraft;
  target: ScheduleTarget;
};

type FieldErrors = {
  instruction?: string;
  agent?: string;
  rule?: RuleError;
};

/** Where the dialog stands: the conversation it answers in, the zone it counts in and its first values. */
type Start = {
  values: Values;
  conversation: { id: string; title: string | null; deleted: boolean } | null;
  timeZone: string;
  /** The agent the dialog started with, kept as a choice even when the field no longer lists it. */
  agent: ChipRecord | null;
};

function startOf(mode: ScheduleDialogMode, now: Date): Start {
  if (mode.kind === 'create') {
    return {
      values: {
        name: '',
        instruction: mode.text,
        agentId: mode.agent?.id ?? CHAT_AGENT,
        rule: defaultRuleDraft(now),
        target: 'new_conversation',
      },
      conversation:
        mode.conversationId === null
          ? null
          : { id: mode.conversationId, title: null, deleted: false },
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      agent: mode.agent,
    };
  }
  const { schedule } = mode;
  return {
    values: {
      name: schedule.name,
      instruction: schedule.instruction,
      agentId: schedule.agent?.id ?? CHAT_AGENT,
      rule: ruleDraftOf(schedule.rule, now),
      target: schedule.target,
    },
    conversation: schedule.conversation,
    timeZone: schedule.timeZone,
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
  const locale = useLocale();
  const format = useFormatter();
  const router = useRouter();
  const id = useId();
  const { libraryIndex } = useShellServices();
  const records = useStore(libraryIndex, (state) => state.records);
  const [start] = useState(() => startOf(mode, new Date()));
  const [values, setValues] = useState(start.values);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<ReactNode>(null);
  const [saving, setSaving] = useState(false);
  /** Grows with every set of field errors shown, so focus moves to the first of them again. */
  const [errorsShown, setErrorsShown] = useState(0);
  const formRef = useRef<HTMLFormElement>(null);

  // Runs after the commit that enables the fields again, so the field can take focus.
  useEffect(() => {
    if (errorsShown === 0) return;
    formRef.current
      ?.querySelector<HTMLElement>('[aria-invalid="true"]')
      ?.focus();
  }, [errorsShown]);

  const agents = agentChoices(
    [...(records?.values() ?? [])].filter(canUseInChat).map((record) => ({
      id: record.id,
      kind: record.kind,
      name: builtinName(record, locale),
    })),
    start.agent,
  );
  const agentName =
    agents.find((agent) => agent.id === values.agentId)?.name ?? null;
  const conversation = start.conversation;
  const thisConversationClosed = conversation === null || conversation.deleted;

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
      agentId: values.agentId === CHAT_AGENT ? null : values.agentId,
      rule: checked.rule,
      timeZone: start.timeZone,
      target: values.target,
      conversationId: conversation?.id ?? null,
      language: locale,
    };
    setErrors({});
    setSaving(true);
    try {
      const saved =
        mode.kind === 'create'
          ? await schedulesApi.create(body)
          : await schedulesApi.update(mode.schedule.id, body);
      logger.info(
        `schedules: ${mode.kind === 'create' ? 'created' : 'saved'}`,
        {
          scheduleId: saved.id,
        },
      );
      notifySaved(saved);
      onSaved(saved);
    } catch (cause) {
      logger.warn('schedules: save refused', {
        scheduleId: mode.kind === 'edit' ? mode.schedule.id : null,
        ...describeApiError(cause),
      });
      setSaving(false);
      if (isPastRefusal(body.rule, cause)) {
        showErrors({ rule: 'past' });
        return;
      }
      const refusal = describeSchedulesError(t, cause, {
        where: 'dialog',
        agentName,
      });
      if (refusal.place === 'agent') showErrors({ agent: refusal.text });
      else setFormError(refusal.text);
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
  const thisConversationLabel =
    conversation?.title == null
      ? t('dialog.thisConversation')
      : t('dialog.namedConversation', { title: conversation.title });
  const thisConversationHint =
    conversation === null
      ? t('dialog.noConversationYet')
      : conversation.deleted
        ? t('dialog.conversationDeleted')
        : t('dialog.thisConversationHint');

  return (
    <form
      ref={formRef}
      noValidate
      onSubmit={(event) => void submit(event)}
      className="flex min-h-0 flex-col gap-4"
    >
      {/* A disabled fieldset disables every native field and button inside while the request runs. */}
      <fieldset
        disabled={saving}
        className="-mx-4 flex min-h-0 flex-col gap-4 overflow-y-auto px-4"
      >
        <TextField
          id={fieldId('name')}
          label={t('dialog.name')}
          optional={t('dialog.optional')}
          hint={t('dialog.nameHint')}
        >
          {(describedBy) => (
            <Input
              id={fieldId('name')}
              autoComplete="off"
              maxLength={SCHEDULE_NAME_MAX_LENGTH}
              className={cn(COMFORT_CONTROL, 'text-sm md:text-sm')}
              value={values.name}
              aria-describedby={describedBy}
              onChange={(event) => set('name', event.target.value)}
            />
          )}
        </TextField>
        <TextField
          id={fieldId('instruction')}
          label={t('dialog.instruction')}
          hint={t('dialog.instructionHint')}
          error={errors.instruction}
        >
          {(describedBy) => (
            <Textarea
              id={fieldId('instruction')}
              maxLength={CHAT_MESSAGE_MAX_LENGTH}
              className="max-h-48 min-h-20 text-sm md:text-sm"
              value={values.instruction}
              aria-invalid={errors.instruction !== undefined}
              aria-describedby={describedBy}
              onChange={(event) => set('instruction', event.target.value)}
            />
          )}
        </TextField>
        <TextField
          id={fieldId('agent')}
          label={t('dialog.agent')}
          error={errors.agent}
        >
          {(describedBy) => (
            <AgentSelect
              id={fieldId('agent')}
              value={values.agentId}
              agents={agents}
              chatAgent={t('dialog.chatAgent')}
              invalid={errors.agent !== undefined}
              describedBy={describedBy}
              onChange={(agentId) => set('agentId', agentId)}
            />
          )}
        </TextField>
        <ScheduleRuleField
          draft={values.rule}
          onChange={(rule) => set('rule', rule)}
          timeZone={start.timeZone}
          error={errors.rule ?? null}
        />
        <TargetField
          label={t('dialog.target')}
          value={values.target}
          onChange={(target) => set('target', target)}
          options={[
            {
              value: 'new_conversation',
              label: t('dialog.newConversation'),
              hint: t('dialog.newConversationHint'),
              disabled: false,
            },
            {
              value: 'this_conversation',
              label: thisConversationLabel,
              hint: thisConversationHint,
              disabled: thisConversationClosed,
            },
          ]}
        />
      </fieldset>
      {formError !== null && <FormError>{formError}</FormError>}
      <DialogFooter className="sm:justify-start">
        <Button type="submit" className={COMFORT_CONTROL} disabled={saving}>
          {saving && (
            <LoaderCircle
              className="animate-spin motion-reduce:animate-none"
              aria-hidden
            />
          )}
          {saving
            ? tCommon('saving')
            : t(mode.kind === 'create' ? 'dialog.create' : 'dialog.save')}
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

/** A labelled field of the form: label, the control, a hint and the field error (settings-form). */
function TextField({
  id,
  label,
  optional,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  optional?: string;
  hint?: string;
  error?: string;
  children: (describedBy: string | undefined) => ReactNode;
}) {
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy =
    [hint === undefined ? null : hintId, error === undefined ? null : errorId]
      .filter((part) => part !== null)
      .join(' ') || undefined;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-foreground">
        {label}
        {optional !== undefined && (
          <span className="font-normal text-muted-foreground"> {optional}</span>
        )}
      </label>
      {children(describedBy)}
      {hint !== undefined && (
        <p id={hintId} className={cn(CAPTION, 'text-muted-foreground')}>
          {hint}
        </p>
      )}
      {error !== undefined && (
        <p id={errorId} className={cn(CAPTION, 'text-destructive')}>
          {error}
        </p>
      )}
    </div>
  );
}

/** «Агент»: «Агент чата» first, then the agents of «+» with their icons (SH-02). */
function AgentSelect({
  id,
  value,
  agents,
  chatAgent,
  invalid,
  describedBy,
  onChange,
}: {
  id: string;
  value: string;
  agents: readonly ChipRecord[];
  chatAgent: string;
  invalid: boolean;
  describedBy: string | undefined;
  onChange: (agentId: string) => void;
}) {
  const options = [
    { value: CHAT_AGENT, label: chatAgent, icon: BotIcon },
    ...agents.map((agent) => ({
      value: agent.id,
      label: agent.name,
      icon: RECORD_KIND_ICON[agent.kind],
    })),
  ];
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        if (typeof next === 'string') onChange(next);
      }}
      items={options.map(({ value: item, label }) => ({ value: item, label }))}
    >
      <SelectTrigger
        id={id}
        className={cn(COMFORT_CONTROL, 'w-full text-sm')}
        aria-invalid={invalid}
        aria-describedby={describedBy}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map(({ value: item, label, icon: Icon }) => (
          <SelectItem
            key={item}
            value={item}
            className="text-sm pointer-coarse:min-h-11"
          >
            <Icon aria-hidden className="text-muted-foreground" />
            {label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

type TargetOption = {
  value: ScheduleTarget;
  label: string;
  hint: string;
  disabled: boolean;
};

/** «Куда писать ответ»: a radio group whose unavailable choice says why under it (MC-2). */
function TargetField({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: ScheduleTarget;
  options: readonly TargetOption[];
  onChange: (target: ScheduleTarget) => void;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <span id={id} className="text-sm font-medium text-foreground">
        {label}
      </span>
      <RadioGroup
        aria-labelledby={id}
        value={value}
        onValueChange={(next) => {
          const chosen = options.find((option) => option.value === next);
          if (chosen !== undefined) onChange(chosen.value);
        }}
        className="gap-2"
      >
        {options.map((option) => (
          <div key={option.value} className="flex flex-col gap-0.5">
            <label className="flex w-fit items-center gap-2 text-sm text-foreground has-disabled:text-muted-foreground pointer-coarse:min-h-11">
              <RadioGroupItem
                value={option.value}
                disabled={option.disabled}
                aria-describedby={`${id}-${option.value}`}
              />
              {option.label}
            </label>
            <p
              id={`${id}-${option.value}`}
              className={cn(CAPTION, 'pl-6 text-muted-foreground')}
            >
              {option.hint}
            </p>
          </div>
        ))}
      </RadioGroup>
    </div>
  );
}
