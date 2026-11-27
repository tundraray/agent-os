'use client';

import { useState, type ReactNode } from 'react';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import {
  ClockIcon,
  PlugIcon,
  PlusIcon,
  WandSparklesIcon,
  type LucideIcon,
} from 'lucide-react';
import { useAui, useAuiState } from '@assistant-ui/react';
import type { ChipRecord } from '@agent-os/contracts';
import { useStore } from 'zustand';
import { TEST_RUN_ICON } from '@/components/assistant-ui/elements/test-run-start';
import { RECORD_KIND_ICON } from '@/components/library/record-label';
import type { InChatSeed } from '@/components/library/use-in-chat';
import {
  ScheduleDialog,
  type ScheduleDialogMode,
} from '@/components/schedules/schedule-dialog';
import { useShellServices } from '@/components/shell/shell-actions';
import { ShellLink } from '@/components/shell/shell-link';
import { TooltipIconButton } from '@/components/tooltip-icon-button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { builtinName } from '@/i18n/builtin-name';
import { focusShellTarget, shellTargetElement } from '@/lib/focus';
import { canUseInChat } from '@/lib/library/record-rules';
import { ACCOUNT_PATH } from '@/lib/shell-route';
import {
  NEW_THREAD_TARGET,
  TEST_RUN_ACTION,
  type SeedTarget,
} from '@/lib/threads/composer-seed';

/**
 * «+» of a conversation's composer: a library record usable in chat becomes the composer's chip, «Создать агента в
 * чате» puts the library's template text — both stay on this conversation, like «Использовать в чате» without the move.
 * «Запланировать» opens the schedule dialog with the field's text and record chip (schedules SH-01, KD-1).
 */
export function ComposerActions({ target }: { target: SeedTarget }) {
  const schedule = useComposerSchedule(target);
  const t = useTranslations('chat.composer');
  const tLibrary = useTranslations('library');
  const format = useFormatter();
  const { composerSeed, currentUser } = useShellServices();
  const user = useStore(currentUser, (state) => state.user);
  const agents = useChatAgents();
  // A chosen item sends focus to the message field when the menu closes; any other close returns it to «+».
  const [chose, setChose] = useState(false);
  const put = (seed: InChatSeed) => composerSeed.put(target, seed);

  return (
    <>
      <DropdownMenu
        onOpenChange={(open, { reason }) =>
          setChose(!open && reason === 'item-press')
        }
      >
        <DropdownMenuTrigger
          render={
            <TooltipIconButton
              tooltip={t('add')}
              side="bottom"
              type="button"
              variant="ghost"
              size="icon"
              className="text-muted-foreground hover:text-foreground size-7 rounded-full"
              aria-label={t('add')}
            />
          }
        >
          <PlusIcon className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          finalFocus={
            // The dialog is open: the menu leaves focus to it.
            schedule.opened
              ? false
              : chose
                ? () => shellTargetElement('composer')
                : true
          }
          className="max-h-[min(20rem,var(--available-height))] w-sm max-w-[calc(100vw-2rem)]"
        >
          <DropdownMenuGroup>
            <DropdownMenuLabel>{t('agents')}</DropdownMenuLabel>
            {agents.length === 0 ? (
              <DropdownMenuItem disabled>{t('noAgents')}</DropdownMenuItem>
            ) : (
              agents.map((agent) => (
                <ActionRow
                  key={agent.chip.id}
                  icon={agent.icon}
                  name={agent.chip.name}
                  hint={agent.hint}
                  onClick={() => put({ record: agent.chip })}
                />
              ))
            )}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <ActionRow
            icon={WandSparklesIcon}
            name={t('createAgent')}
            hint={t('createAgentHint')}
            onClick={() => put({ text: tLibrary('screen.template') })}
          />
          {user?.trainOwn === true && (
            <ActionRow
              icon={TEST_RUN_ICON}
              name={t('testRun.name')}
              hint={t('testRun.hint', {
                cap: format.number(user.trainingCapUsd, 'usd'),
              })}
              onClick={() => put({ action: TEST_RUN_ACTION })}
            />
          )}
          <ActionRow
            icon={ClockIcon}
            name={t('schedule')}
            hint={t('scheduleHint')}
            onClick={() => schedule.open(false)}
          />
          <ActionRow
            icon={PlugIcon}
            name={t('connections')}
            hint={t('connectionsHint')}
            render={<ShellLink href={ACCOUNT_PATH} />}
          />
        </DropdownMenuContent>
      </DropdownMenu>
      {schedule.dialog}
    </>
  );
}

/**
 * improvements IM-08: «Отправить позже» left of «Отправить» opens the schedule dialog preset to «later». It stands
 * in a conversation that has messages, while the field holds text and no action chip.
 */
export function SendLater({ target }: { target: SeedTarget }) {
  const t = useTranslations('chat.composer');
  const { composerSeed } = useShellServices();
  const schedule = useComposerSchedule(target);
  const typed = useAuiState((state) => state.composer.text.trim() !== '');
  const actionChip = useStore(composerSeed, (state) => {
    const chip = state.chips.get(target);
    return chip !== undefined && 'action' in chip;
  });
  const shown = target !== NEW_THREAD_TARGET && typed && !actionChip;
  return (
    <>
      {shown && (
        <TooltipIconButton
          tooltip={t('sendLater')}
          side="bottom"
          type="button"
          variant="ghost"
          size="icon"
          className="text-muted-foreground hover:text-foreground size-8 rounded-full max-[480px]:size-11"
          aria-label={t('sendLater')}
          onClick={() => schedule.open(true)}
        >
          <ClockIcon className="size-4" />
        </TooltipIconButton>
      )}
      {schedule.dialog}
    </>
  );
}

/**
 * The schedule dialog opened from a conversation's composer, shared by «Запланировать» of «+» and «Отправить
 * позже»: it starts from the field's text and record chip, and a saved schedule empties both (schedules KD-1).
 */
function useComposerSchedule(target: SeedTarget): {
  open: (later: boolean) => void;
  opened: boolean;
  dialog: ReactNode;
} {
  const aui = useAui();
  const { composerSeed } = useShellServices();
  // The dialog is open while `mode` is set.
  const [mode, setMode] = useState<ScheduleDialogMode | null>(null);

  const open = (later: boolean): void => {
    const chip = composerSeed.getState().chips.get(target);
    setMode({
      kind: 'create',
      text: aui.composer.getState().text,
      agent: chip !== undefined && 'id' in chip ? chip : null,
      conversationId: target === NEW_THREAD_TARGET ? null : target,
      later,
    });
  };

  /** KD-1: the instruction now lives in the schedule, so the field and its chip are emptied. */
  const scheduled = (): void => {
    const chip =
      mode?.kind === 'create' && mode.agent !== null ? mode.agent : undefined;
    if (chip !== undefined) composerSeed.clear(target, chip);
    aui.composer.setText('');
    focusShellTarget('composer');
  };

  return {
    open,
    opened: mode !== null,
    dialog: mode !== null && (
      <ScheduleDialog
        mode={mode}
        open
        onOpenChange={(next) => {
          if (!next) setMode(null);
        }}
        onSaved={scheduled}
        finalFocus={() => shellTargetElement('composer')}
      />
    ),
  };
}

/** A library record usable in chat, as a row of «Агенты» in «+» and in the `@` list (improvements KD-7). */
export type ChatAgent = { chip: ChipRecord; icon: LucideIcon; hint: string };

/** The rows of «Агенты»: the library's records usable in chat, with the name in the interface's language. */
export function useChatAgents(): ChatAgent[] {
  const locale = useLocale();
  const { libraryIndex } = useShellServices();
  const records = useStore(libraryIndex, (state) => state.records);
  return [...(records?.values() ?? [])].filter(canUseInChat).map((record) => ({
    chip: {
      id: record.id,
      kind: record.kind,
      name: builtinName(record, locale),
    },
    icon: RECORD_KIND_ICON[record.kind],
    hint: record.description,
  }));
}

type ActionRowProps = Pick<
  Parameters<typeof DropdownMenuItem>[0],
  'onClick' | 'render'
> & {
  icon: LucideIcon;
  name: string;
  hint: string;
};

function ActionRow({ icon: Icon, name, hint, ...item }: ActionRowProps) {
  return (
    <DropdownMenuItem className="items-start py-1.5" {...item}>
      <Icon aria-hidden className="text-muted-foreground mt-0.5" />
      <span className="flex min-w-0 flex-col">
        <span className="truncate">{name}</span>
        <span className="text-muted-foreground truncate text-xs leading-4">
          {hint}
        </span>
      </span>
    </DropdownMenuItem>
  );
}
