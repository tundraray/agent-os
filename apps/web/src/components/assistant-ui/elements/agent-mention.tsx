'use client';

import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
  type SyntheticEvent,
  type TextareaHTMLAttributes,
} from 'react';
import { useTranslations } from 'next-intl';
import { useAui, useAuiState } from '@assistant-ui/react';
import { ClockIcon } from 'lucide-react';
import {
  useAgentCommands,
  useChatAgents,
  type ComposerCommand,
} from '@/components/assistant-ui/elements/composer-actions';
import { useShellServices } from '@/components/shell/shell-actions';
import type { SeedTarget } from '@/lib/threads/composer-seed';
import { cn } from '@/lib/utils';

/** The sign being typed — `@` of an agent or `/` of a command —, where it stands and what follows it up to the caret. */
type Mention = { sign: '@' | '/'; start: number; query: string };

/**
 * `@` at the start of the field or after whitespace (IM-12), or `/` as the field's first character (SL-01), with no
 * whitespace between it and the caret.
 */
function mentionAt(text: string, caret: number): Mention | null {
  const before = text.slice(0, caret);
  const command = /^\/(\S*)$/.exec(before);
  if (command !== null) return { sign: '/', start: 0, query: command[1] ?? '' };
  const match = /(?:^|\s)@(\S*)$/.exec(before);
  if (match === null) return null;
  const query = match[1] ?? '';
  return { sign: '@', start: caret - query.length - 1, query };
}

/**
 * A row of the list — an agent of «+» or a command. Choosing it removes the typed sign, puts `inserted` in its place
 * and runs `run`.
 */
type Row = Omit<ComposerCommand, 'run'> & {
  inserted?: string;
  run?: () => void;
};

function matching(rows: Row[], query: string): Row[] {
  const wanted = query.toLocaleLowerCase();
  return rows.filter((row) => row.name.toLocaleLowerCase().includes(wanted));
}

type FieldProps = Pick<
  TextareaHTMLAttributes<HTMLTextAreaElement>,
  | 'role'
  | 'aria-expanded'
  | 'aria-controls'
  | 'aria-activedescendant'
  | 'aria-autocomplete'
  | 'onChange'
  | 'onSelect'
  | 'onBlur'
>;

export type AgentMention = {
  /** The field's combobox attributes and the handlers that follow its caret. */
  fieldProps: FieldProps;
  /** Handles the list's keys while it is open; `true` when the key was the list's. */
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  /** The list above the field; `null` while closed. */
  list: ReactNode;
};

/**
 * improvements IM-12, KD-7: `@` in the field of a conversation with «+» opens the rows of «Агенты» above it; `/` as the
 * field's first character opens «Команды» (chat-scheduling SL-01, KD-6). The field stays assistant-ui's input and takes
 * the combobox role while the list is open; focus never leaves it. A choice removes the sign with what was typed after
 * it: an agent puts the same chip as «+», replacing the previous one; «Запланировать» starts the phrase «Запланируй: »
 * and keeps the chip; the other commands do what their «+» item does. Nothing is sent.
 */
export function useAgentMention(target: SeedTarget): AgentMention {
  const t = useTranslations('chat.composer');
  const aui = useAui();
  const { composerSeed } = useShellServices();
  const agents = useChatAgents();
  const agentCommands = useAgentCommands(target);
  const text = useAuiState((state) => state.composer.text);
  const listId = useId();
  const field = useRef<HTMLTextAreaElement | null>(null);
  // The caret the person put; `null` while the field is not theirs to type in (blurred, or text set by code).
  const [caret, setCaret] = useState<number | null>(null);
  const [active, setActive] = useState(0);
  // Esc closes the list of this `@` only: a new `@` opens it again.
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const restoreCaret = useRef<number | null>(null);

  useLayoutEffect(() => {
    const at = restoreCaret.current;
    const element = field.current;
    if (at === null || element === null || element.value !== text) return;
    restoreCaret.current = null;
    element.setSelectionRange(at, at);
  }, [text]);

  const mention =
    caret === null ? null : mentionAt(text, Math.min(caret, text.length));
  const open = mention !== null && mention.start !== dismissedAt;
  const rows: Row[] =
    mention?.sign === '/'
      ? [
          {
            key: 'schedule',
            icon: ClockIcon,
            name: t('commands.schedule'),
            hint: t('commands.scheduleHint'),
            // Only a phrase, through `setText`: a text seed would drop the agent chip (KD-6).
            inserted: t('commands.scheduleText'),
          },
          ...agentCommands,
        ]
      : agents.map((agent) => ({
          key: agent.chip.id,
          icon: agent.icon,
          name: agent.chip.name,
          hint: agent.hint,
          run: () => composerSeed.put(target, { record: agent.chip }),
        }));
  const shown = open ? matching(rows, mention.query) : [];
  const activeIndex = Math.min(active, Math.max(shown.length - 1, 0));
  const optionId = (index: number): string => `${listId}-${index}`;
  const activeId = open && shown.length > 0 ? optionId(activeIndex) : null;

  // ↑ ↓ past the five visible rows keep the active row in view.
  useLayoutEffect(() => {
    if (activeId === null) return;
    document.getElementById(activeId)?.scrollIntoView?.({ block: 'nearest' });
  }, [activeId]);

  const follow = (event: SyntheticEvent<HTMLTextAreaElement>): void => {
    field.current = event.currentTarget;
    setCaret(event.currentTarget.selectionStart);
  };

  const choose = (row: Row): void => {
    if (mention === null || caret === null) return;
    const inserted = row.inserted ?? '';
    restoreCaret.current = mention.start + inserted.length;
    setCaret(restoreCaret.current);
    aui.composer.setText(
      text.slice(0, mention.start) + inserted + text.slice(caret),
    );
    row.run?.();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open || event.nativeEvent.isComposing) return false;
    const chosen = shown[activeIndex];
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        if (shown.length === 0) return false;
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setActive((activeIndex + step + shown.length) % shown.length);
        break;
      }
      case 'Enter':
      case 'Tab':
        if (chosen === undefined || event.shiftKey) return false;
        choose(chosen);
        break;
      case 'Escape':
        setDismissedAt(mention.start);
        break;
      default:
        return false;
    }
    event.preventDefault();
    return true;
  };

  return {
    fieldProps: {
      ...(open && {
        role: 'combobox',
        'aria-expanded': true,
        'aria-controls': listId,
        'aria-autocomplete': 'list',
        'aria-activedescendant': activeId ?? undefined,
      }),
      onChange: (event: ChangeEvent<HTMLTextAreaElement>) => {
        follow(event);
        setActive(0);
        const { value, selectionStart } = event.currentTarget;
        if (mentionAt(value, selectionStart) === null) setDismissedAt(null);
      },
      onSelect: follow,
      onBlur: () => setCaret(null),
    },
    onKeyDown,
    list: open && (
      <div
        id={listId}
        role="listbox"
        aria-label={t(mention.sign === '/' ? 'commands.label' : 'agents')}
        className="bg-popover text-popover-foreground ring-foreground/10 absolute bottom-full left-0 z-20 mb-2 max-h-62 w-max max-w-full overflow-y-auto rounded-lg p-1 shadow-lg ring-1 max-[480px]:w-full"
      >
        {shown.length === 0 ? (
          <p className="text-muted-foreground px-1.5 py-1 text-sm">
            {mention.sign === '/'
              ? t('commands.none')
              : t(agents.length === 0 ? 'noAgents' : 'noAgentsMatch')}
          </p>
        ) : (
          shown.map((row, index) => {
            const Icon = row.icon;
            const selected = index === activeIndex;
            return (
              <div
                key={row.key}
                id={optionId(index)}
                role="option"
                aria-selected={selected}
                // The field keeps focus: a press must not blur it before the choice.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(row)}
                className={cn(
                  'flex cursor-default items-start gap-1.5 rounded-md px-1.5 py-1.5 text-sm select-none',
                  selected && 'bg-accent text-accent-foreground',
                )}
              >
                <Icon
                  aria-hidden
                  className="text-muted-foreground mt-0.5 size-4 shrink-0"
                />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{row.name}</span>
                  {/* SL-01, 360 px: the hints wrap in a list as wide as the field. */}
                  <span className="text-muted-foreground truncate text-xs leading-4 max-[480px]:whitespace-normal">
                    {row.hint}
                  </span>
                </span>
              </div>
            );
          })
        )}
      </div>
    ),
  };
}
