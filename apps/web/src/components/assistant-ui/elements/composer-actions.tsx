'use client';

import { useState } from 'react';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import {
  PlugIcon,
  PlusIcon,
  WandSparklesIcon,
  type LucideIcon,
} from 'lucide-react';
import type { ChipRecord } from '@agent-os/contracts';
import { useStore } from 'zustand';
import { TEST_RUN_ICON } from '@/components/assistant-ui/elements/test-run-start';
import { RECORD_KIND_ICON } from '@/components/library/record-label';
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
import { shellTargetElement } from '@/lib/focus';
import { canUseInChat } from '@/lib/library/record-rules';
import { ACCOUNT_PATH } from '@/lib/shell-route';
import { TEST_RUN_ACTION, type SeedTarget } from '@/lib/threads/composer-seed';

/**
 * «+» of a conversation's composer: a library record usable in chat becomes the composer's chip, and the agent
 * commands it shares with `/` put the library's template text or the test-run chip — all stay on this conversation,
 * like «Использовать в чате» without the move.
 */
export function ComposerActions({ target }: { target: SeedTarget }) {
  const t = useTranslations('chat.composer');
  const { composerSeed } = useShellServices();
  const agents = useChatAgents();
  const commands = useAgentCommands(target);
  // A chosen item sends focus to the message field when the menu closes; any other close returns it to «+».
  const [chose, setChose] = useState(false);

  return (
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
        finalFocus={chose ? () => shellTargetElement('composer') : true}
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
                onClick={() => composerSeed.put(target, { record: agent.chip })}
              />
            ))
          )}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        {commands.map((command) => (
          <ActionRow
            key={command.key}
            icon={command.icon}
            name={command.name}
            hint={command.hint}
            onClick={command.run}
          />
        ))}
        <ActionRow
          icon={PlugIcon}
          name={t('connections')}
          hint={t('connectionsHint')}
          render={<ShellLink href={ACCOUNT_PATH} />}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A command of the composer: a row of «+» and of the `/` list (chat-scheduling KD-6). */
export type ComposerCommand = {
  key: string;
  icon: LucideIcon;
  name: string;
  hint: string;
  run: () => void;
};

/**
 * The agent commands «+» and `/` share: «Создать агента в чате» puts the library's template text, «Создать и проверить
 * агента» the test-run chip — the latter only for an employee who may train their own agents.
 */
export function useAgentCommands(target: SeedTarget): ComposerCommand[] {
  const t = useTranslations('chat.composer');
  const tLibrary = useTranslations('library');
  const format = useFormatter();
  const { composerSeed, currentUser } = useShellServices();
  const user = useStore(currentUser, (state) => state.user);
  const createAgent: ComposerCommand = {
    key: 'createAgent',
    icon: WandSparklesIcon,
    name: t('createAgent'),
    hint: t('createAgentHint'),
    run: () => composerSeed.put(target, { text: tLibrary('screen.template') }),
  };
  if (user?.trainOwn !== true) return [createAgent];
  return [
    createAgent,
    {
      key: 'testRun',
      icon: TEST_RUN_ICON,
      name: t('testRun.name'),
      hint: t('testRun.hint', {
        cap: format.number(user.trainingCapUsd, 'usd'),
      }),
      run: () => composerSeed.put(target, { action: TEST_RUN_ACTION }),
    },
  ];
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
