'use client';

import { useState } from 'react';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import {
  PlugIcon,
  PlusIcon,
  WandSparklesIcon,
  type LucideIcon,
} from 'lucide-react';
import { useStore } from 'zustand';
import { TEST_RUN_ICON } from '@/components/assistant-ui/elements/test-run-start';
import { RECORD_KIND_ICON } from '@/components/library/record-label';
import type { InChatSeed } from '@/components/library/use-in-chat';
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
 * «+» of a conversation's composer: a library record usable in chat becomes the composer's chip, «Создать агента в
 * чате» puts the library's template text — both stay on this conversation, like «Использовать в чате» without the move.
 */
export function ComposerActions({ target }: { target: SeedTarget }) {
  const t = useTranslations('chat.composer');
  const tLibrary = useTranslations('library');
  const locale = useLocale();
  const format = useFormatter();
  const { libraryIndex, composerSeed, currentUser } = useShellServices();
  const records = useStore(libraryIndex, (state) => state.records);
  const user = useStore(currentUser, (state) => state.user);
  const usable = [...(records?.values() ?? [])].filter(canUseInChat);
  // A chosen item sends focus to the message field when the menu closes; any other close returns it to «+».
  const [chose, setChose] = useState(false);
  const put = (seed: InChatSeed) => composerSeed.put(target, seed);

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
          {usable.length === 0 ? (
            <DropdownMenuItem disabled>{t('noAgents')}</DropdownMenuItem>
          ) : (
            usable.map((record) => {
              const name = builtinName(record, locale);
              return (
                <ActionRow
                  key={record.id}
                  icon={RECORD_KIND_ICON[record.kind]}
                  name={name}
                  hint={record.description}
                  onClick={() =>
                    put({
                      record: { id: record.id, kind: record.kind, name },
                    })
                  }
                />
              );
            })
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
          icon={PlugIcon}
          name={t('connections')}
          hint={t('connectionsHint')}
          render={<ShellLink href={ACCOUNT_PATH} />}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
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
