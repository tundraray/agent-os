'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import type { ForkRequest, ThreadSummary } from '@agent-os/contracts';
import { describeApiError } from '@/lib/api/api-request';
import { focusShellTarget } from '@/lib/focus';
import { forkRefusalText } from '@/lib/library/library-errors';
import { logger } from '@/lib/logger';
import { threadPath } from '@/lib/shell-route';
import { threadsApiClient } from '@/lib/threads/threads-api-client';
import { useShellServices } from './shell-actions';

/**
 * Forks a conversation (improvements KD-2): the branch, or null after a refusal, which is logged and shown as the
 * create-and-test MC-18 notice. Shared by the ways into a branch — its address and the side chat's tab.
 */
export function useForkThread(): (
  threadId: string,
  body?: ForkRequest,
) => Promise<ThreadSummary | null> {
  const tErrors = useTranslations('errors');
  return async (threadId, body) => {
    try {
      return await threadsApiClient.forkThread(threadId, body);
    } catch (error) {
      // The numbers only: the edited text is the employee's message and stays out of the log.
      logger.warn('[web-shell] thread fork refused', {
        threadId,
        throughSeq: body?.throughSeq,
        editSeq: body?.edit?.seq,
        ...describeApiError(error),
      });
      toast.error(forkRefusalText(tErrors, error));
      return null;
    }
  };
}

/**
 * Forks a conversation and enters the branch (create-and-test Flow 3; improvements KD-2): the branch's address,
 * focus in its composer and the MC-18 announcement. Resolves whether the branch opened, so the caller keeps its
 * own state on a refusal.
 */
export function useOpenBranch(): (
  threadId: string,
  body?: ForkRequest,
) => Promise<boolean> {
  const router = useRouter();
  const { announcer } = useShellServices();
  const tThread = useTranslations('shell.thread');
  const fork = useForkThread();
  return async (threadId, body) => {
    const thread = await fork(threadId, body);
    if (thread === null) return false;
    router.push(threadPath(thread.id));
    focusShellTarget('composer');
    announcer.getState().announce('announce.forkOpened', {
      title: thread.title ?? tThread('untitled'),
    });
    return true;
  };
}
