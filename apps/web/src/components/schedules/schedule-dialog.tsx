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
  type ToolPair,
} from '@agent-os/contracts';
import {
  AdminRadioField,
  AdminSelectField,
  AdminTextField,
  CAPTION,
  COMFORT_CONTROL,
  FormError,
} from '@/components/admin/admin-form';
import { FieldError } from '@/components/ui/field';
import { RECORD_KIND_ICON } from '@/components/library/record-label';
import {
  AllowedToolsField,
  listedPairs,
  useScheduleTools,
} from '@/components/schedules/allowed-tools';
import {
  checkRule,
  defaultRuleDraft,
  formatRunTime,
  isPastRefusal,
  laterRuleDraft,
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
import { builtinName } from '@/i18n/builtin-name';
import { describeApiError } from '@/lib/api/api-request';
import { canUseInChat } from '@/lib/library/record-rules';
import { logger } from '@/lib/logger';
import { startTimer } from '@/lib/timer';
import { schedulePath } from '@/lib/shell-route';
import { schedulesApi } from '@/lib/schedules/schedules-api';
import { describeSchedulesError } from '@/lib/schedules/schedules-errors';

/**
 * SH-02: the schedule dialog (settings-form «Форма диалога», comfortable density). A new schedule starts from
 * the message field — its text, its agent chip and its conversation (UXRD KD-1); an edit starts from the saved
 * schedule. The body mounts with the open dialog, so every open starts from those values. «Отправить позже» is the
 * create mode's `later` preset (improvements KD-6): «один раз» at the next whole hour, in this conversation.
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
      /** «Отправить позже» (IM-08): its title and button, «один раз» at the next whole hour, «В эту беседу». */
      later: boolean;
    }
  | { kind: 'edit'; schedule: ScheduleView };

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
            {t(
              mode.kind === 'edit'
                ? 'editTitle'
                : mode.later
                  ? 'laterTitle'
                  : 'createTitle',
            )}
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
  /** «Без вас» as ticked; the body sends only the pairs of the read list. */
  allowedTools: readonly ToolPair[];
};

type FieldErrors = {
  instruction?: string;
  agent?: string;
  rule?: RuleError;
  target?: string;
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
        rule: mode.later ? laterRuleDraft(now) : defaultRuleDraft(now),
        target:
          mode.later && mode.conversationId !== null
            ? 'this_conversation'
            : 'new_conversation',
        // IM-01: nothing is ticked by default.
        allowedTools: [],
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
      // A deleted conversation takes no replies, so the dialog opens on the only target that can be saved.
      target: schedule.conversation?.deleted
        ? 'new_conversation'
        : schedule.target,
      allowedTools: schedule.allowedTools,
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
  const tErrors = useTranslations('errors');
  const locale = useLocale();
  const format = useFormatter();
  const router = useRouter();
  const id = useId();
  const { libraryIndex } = useShellServices();
  const records = useStore(libraryIndex, (state) => state.records);
  const tools = useScheduleTools();
  const [start] = useState(() => startOf(mode, new Date()));
  const [values, setValues] = useState(start.values);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<ReactNode>(null);
  const [saving, setSaving] = useState(false);
  /** Grows with every set of field errors shown, so focus moves to the first of them again. */
  const [errorsShown, setErrorsShown] = useState(0);
  /** The reply conversation was deleted while the dialog was open: the server refused it on save. */
  const [conversationGone, setConversationGone] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const targetRef = useRef<HTMLDivElement>(null);

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
  const conversationDeleted =
    conversationGone || (conversation?.deleted ?? false);
  const thisConversationClosed = conversation === null || conversationDeleted;

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
    // FR-07: a pair the owner lost would be refused with a 400 they cannot fix, so nothing saves before the list.
    if (saving || tools.data === undefined) return;
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
      // A new schedule is refused for a deleted conversation even when it answers elsewhere; an edit keeps its own.
      conversationId:
        mode.kind === 'create' && conversationGone
          ? null
          : (conversation?.id ?? null),
      language: locale,
      allowedTools: listedPairs(values.allowedTools, tools.data.tools),
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

  /**
   * MC-5: a new schedule names its next run and opens from the notice; an edit says it was saved. A new schedule
   * comes from a conversation's composer, whose send button the bottom-right corner covers: its notice shows on top.
   */
  function notifySaved(saved: ScheduleView): void {
    if (mode.kind === 'edit') {
      toast.success(t('dialog.saved'));
      return;
    }
    const position = 'top-center';
    if (saved.nextRunAt === null) {
      toast.success(t('dialog.saved'), { position });
      return;
    }
    toast.success(
      t('dialog.created', {
        at: formatRunTime(format, saved.nextRunAt, saved.timeZone),
      }),
      {
        position,
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
      : conversationDeleted
        ? t('dialog.conversationDeleted')
        : t('dialog.thisConversationHint');

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
          <AdminSelectField
            id={fieldId('agent')}
            density="comfortable"
            label={t('dialog.agent')}
            value={values.agentId}
            options={[
              { id: CHAT_AGENT, name: t('dialog.chatAgent'), icon: BotIcon },
              ...agents.map((agent) => ({
                ...agent,
                icon: RECORD_KIND_ICON[agent.kind],
              })),
            ].map(({ id: value, name, icon: Icon }) => ({
              value,
              label: name,
              content: (
                <>
                  <Icon aria-hidden className="text-muted-foreground" />
                  {name}
                </>
              ),
            }))}
            error={errors.agent}
            onChange={(agentId) => set('agentId', agentId)}
          />
          <ScheduleRuleField
            draft={values.rule}
            onChange={(rule) => set('rule', rule)}
            timeZone={start.timeZone}
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
                  hint: t('dialog.newConversationHint'),
                  disabled: saving,
                },
                {
                  value: 'this_conversation',
                  label: thisConversationLabel,
                  hint: thisConversationHint,
                  disabled: saving || thisConversationClosed,
                },
              ]}
            />
            <FieldError className={CAPTION}>{errors.target}</FieldError>
          </div>
          <AllowedToolsField
            tools={tools}
            chosen={values.allowedTools}
            disabled={saving}
            onChange={(allowedTools) => set('allowedTools', allowedTools)}
          />
        </fieldset>
      </div>
      {formError !== null && <FormError>{formError}</FormError>}
      <DialogFooter className="sm:justify-start">
        <Button
          type="submit"
          className={COMFORT_CONTROL}
          disabled={saving || tools.data === undefined}
        >
          {saving && (
            <LoaderCircle
              className="animate-spin motion-reduce:animate-none"
              aria-hidden
            />
          )}
          {saving
            ? tCommon('saving')
            : t(
                mode.kind === 'edit'
                  ? 'dialog.save'
                  : mode.later
                    ? 'dialog.schedule'
                    : 'dialog.create',
              )}
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
