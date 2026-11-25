'use client';

import { useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import { ArrowUpIcon, FlaskConicalIcon } from 'lucide-react';
import { useAui, useAuiState } from '@assistant-ui/react';
import { useStore } from 'zustand';
import { TEST_RUN_DESCRIPTION_MAX } from '@agent-os/contracts';
import { useShellServices } from '@/components/shell/shell-actions';
import { ShellLink } from '@/components/shell/shell-link';
import { TooltipIconButton } from '@/components/tooltip-icon-button';
import type { ErrorsTranslator } from '@/i18n/catalog';
import { describeApiError, isApiRequestError } from '@/lib/api/api-request';
import { focusShellTarget } from '@/lib/focus';
import { libraryApi } from '@/lib/library/library-api';
import { describeLibraryError } from '@/lib/library/library-errors';
import { logger } from '@/lib/logger';
import { threadPath } from '@/lib/shell-route';
import {
  NEW_THREAD_TARGET,
  type ActionChip,
  type SeedTarget,
} from '@/lib/threads/composer-seed';
import { cn } from '@/lib/utils';

/** The icon of «Создать и проверить агента»: its «+» row and its chip (create-and-test CT-01, CT-02). */
export const TEST_RUN_ICON = FlaskConicalIcon;

/** The counter shows once fewer than 400 characters are left (UXRD CT-02). */
const COUNTER_FROM = TEST_RUN_DESCRIPTION_MAX - 400;

export type TestRunStart = {
  target: SeedTarget;
  /** Starts the test run with the field's text; the composer's submit calls it instead of sending a message. */
  submit: (description: string) => void;
  pending: boolean;
  /** The MC-3 line under the field; `null` — none. */
  failure: ReactNode;
};

/** MC-3 of a refused start: a running test run is named by a link to its conversation. */
function refusalText(t: ErrorsTranslator, error: unknown): ReactNode {
  if (isApiRequestError(error) && error.testRun !== undefined) {
    const { id, title } = error.testRun;
    return t.rich('library.testRun.running', {
      title,
      link: (chunks) => (
        <ShellLink
          href={threadPath(id)}
          className="underline underline-offset-2"
        >
          {chunks}
        </ShellLink>
      ),
    });
  }
  return describeLibraryError(t, error, { where: 'test_run' }).text;
}

/**
 * KD-2, Flow 1: the composer with the action chip starts a test run — with `originThreadId` in a conversation,
 * so the server forks it — and opens its conversation; a refusal keeps the chip and the text.
 */
export function useTestRunStart(
  target: SeedTarget,
  chip: ActionChip | null,
): TestRunStart {
  const t = useTranslations('errors');
  const aui = useAui();
  const router = useRouter();
  const { composerSeed } = useShellServices();
  const [pending, setPending] = useState(false);
  const text = useAuiState((s) => s.composer.text);
  // A failure belongs to the chip and the text it was shown for: an edit or a new chip clears it.
  const [failed, setFailed] = useState<{
    chip: ActionChip | null;
    text: string;
    line: ReactNode;
  } | null>(null);
  const failure =
    failed !== null && failed.chip === chip && failed.text === text
      ? failed.line
      : null;
  const fail = (description: string, line: ReactNode): void =>
    setFailed({ chip, text: description, line });

  const start = async (description: string): Promise<void> => {
    const newChat = target === NEW_THREAD_TARGET;
    if (newChat && description.trim() === '') return;
    if (description.length > TEST_RUN_DESCRIPTION_MAX) {
      fail(description, t('library.testRun.tooLong'));
      return;
    }
    setFailed(null);
    setPending(true);
    try {
      const { testRunId } = await libraryApi.startTestRun(
        newChat ? { description } : { description, originThreadId: target },
      );
      composerSeed.clear(target, chip ?? undefined);
      aui.composer.setText('');
      router.push(threadPath(testRunId));
    } catch (error) {
      logger.warn('chat: test run start refused', {
        target,
        failure: describeApiError(error),
      });
      fail(description, refusalText(t, error));
      focusShellTarget('composer');
    } finally {
      setPending(false);
    }
  };

  return {
    target,
    submit: (description) => void start(description),
    pending,
    failure,
  };
}

/** MC-2 under the field: the cap and where the check runs, «Запускаем…» while starting, and the MC-3 counter. */
export function TestRunNote({
  id,
  target,
  pending,
}: {
  id: string;
  target: SeedTarget;
  pending: boolean;
}) {
  const t = useTranslations('chat.composer.testRun');
  const format = useFormatter();
  const { currentUser } = useShellServices();
  const capUsd = useStore(
    currentUser,
    (state) => state.user?.trainingCapUsd ?? null,
  );
  const length = useAuiState((s) => s.composer.text.length);
  if (capUsd === null) return null;
  const cap = format.number(capUsd, 'usd');
  return (
    <div
      id={id}
      className="text-muted-foreground mt-1 flex justify-between gap-2 px-2.5 text-xs leading-4"
    >
      <p>
        {pending
          ? t('starting')
          : target === NEW_THREAD_TARGET
            ? t('noteNew', { cap })
            : t('noteThread', { cap })}
      </p>
      {length > COUNTER_FROM && (
        <span
          aria-hidden
          className={cn(
            'shrink-0 self-end tabular-nums',
            length > TEST_RUN_DESCRIPTION_MAX && 'text-destructive',
          )}
        >
          {t('count', {
            count: format.number(length),
            max: format.number(TEST_RUN_DESCRIPTION_MAX),
          })}
        </span>
      )}
    </div>
  );
}

/**
 * «Создать и проверить» in place of assistant-ui's send button: a plain submit button, so it reaches the same
 * form submit as Enter; in a new chat an empty field cannot be sent (AC-12.2).
 */
export function TestRunSubmit({
  target,
  pending,
}: {
  target: SeedTarget;
  pending: boolean;
}) {
  const t = useTranslations('chat.composer.testRun');
  const empty = useAuiState((s) => s.composer.text.trim() === '');
  return (
    <TooltipIconButton
      tooltip={t('send')}
      side="bottom"
      type="submit"
      variant="default"
      size="icon"
      className="aui-composer-send size-7 rounded-full"
      aria-label={t('send')}
      disabled={pending || (target === NEW_THREAD_TARGET && empty)}
    >
      <ArrowUpIcon className="aui-composer-send-icon size-4" />
    </TooltipIconButton>
  );
}
