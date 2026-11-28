'use client';

import { useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { LoaderCircle } from 'lucide-react';
import { toast } from 'sonner';
import {
  ALL_SERVERS,
  type CopyResult,
  type MissingRight,
  type RecordDetail,
  type RecordSummary,
} from '@agent-os/contracts';
import { FormError } from '@/components/admin/admin-form';
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
import { formatModel } from '@/lib/agents/format';
import { describeApiError } from '@/lib/api/api-request';
import { builtinName } from '@/i18n/builtin-name';
import type { LibraryTranslator } from '@/i18n/catalog';
import { libraryApi } from '@/lib/library/library-api';
import { copyFailed } from '@/lib/library/library-errors';
import { recordAction } from '@/lib/library/record-action';
import { logger } from '@/lib/logger';
import { recordPath } from '@/lib/shell-route';
import { useLeaveThenGo } from './use-in-chat';

/** What a copy reads of a record: a library row, or a record page with its content. */
export type CopySource = RecordSummary | RecordDetail;

/** Systems of one part of the record: the agent or the deep agent itself (`subagent` `null`), or a subagent. */
type PartServers = { subagent: string | null; servers: readonly string[] };

type CopyPlan = {
  record: CopySource;
  /** Systems the copy loses: the copier has no access to them (from `missingRights`). */
  dropped: PartServers[];
  /** A company record with «Все системы»: the systems the copy gets instead; `null` — not such a record. */
  allServers: readonly string[] | null;
  /** The record's skills by id, as its read names them; empty for a skill. */
  skillNames: ReadonlyMap<string, string>;
  /** Skills the copy loses: the copier's library list does not hold them (agent-guidance KD-7, AC-06.8). */
  hiddenSkills: readonly string[];
};

const droppedOf = (rights: readonly MissingRight[]): PartServers[] =>
  rights
    .filter((right) => right.servers.length > 0)
    .map(({ subagent, servers }) => ({ subagent, servers }));

const hasAllServers = (record: RecordDetail): boolean =>
  record.kind !== 'skill' &&
  (record.content.servers.includes(ALL_SERVERS) ||
    (record.kind === 'deep_agent' &&
      record.content.subagents.some((subagent) =>
        subagent.servers.includes(ALL_SERVERS),
      )));

/**
 * What the dialog must name before the copy. A library row has no content, so an agent or a deep agent is read first:
 * its skills the copier does not see in `records` are lost (agent-guidance KD-7). Only a company record can hold
 * «Все системы», and the copier's own systems then come from `choices`.
 */
async function planCopy(
  record: CopySource,
  records: ReadonlyMap<string, RecordSummary> | null,
): Promise<CopyPlan> {
  const dropped = droppedOf(record.missingRights);
  const detail =
    'content' in record || record.kind === 'skill'
      ? record
      : await libraryApi.get(record.id);
  const connected = 'connectedSkills' in detail ? detail.connectedSkills : [];
  const skillNames = new Map(connected.map((skill) => [skill.id, skill.name]));
  const hiddenSkills = connected
    .filter((skill) => records?.has(skill.id) !== true)
    .map((skill) => skill.name);
  const allServers =
    record.author === null && 'content' in detail && hasAllServers(detail)
      ? (await libraryApi.choices()).servers
      : null;
  return { record, dropped, allServers, skillNames, hiddenSkills };
}

const partLine = (
  t: LibraryTranslator,
  { subagent, servers }: PartServers,
): string =>
  subagent === null
    ? servers.join(', ')
    : t('subagentLine', { subagent, text: servers.join(', ') });

/**
 * The notice of MC-4 (and MC-19): the copy's name, then the dropped systems in the wording of MC-13 and both
 * models of every replacement.
 */
function copiedNotice(
  t: LibraryTranslator,
  result: CopyResult,
  skillNames: ReadonlyMap<string, string>,
): { title: string; description: string | undefined } {
  const { name } = result.record;
  const removedSkills = result.removedSkills.flatMap(
    (id) => skillNames.get(id) ?? [],
  );
  const runsNowhere =
    result.replacedModels.length === 0 &&
    result.record.missingRights.some((right) => right.model !== null);
  const replaced = (from: string, to: string): string =>
    t('copy.replaced', { from: formatModel(from), to: formatModel(to) });
  const details = [
    ...(result.removedServers.length === 0
      ? []
      : [
          t('droppedServers', {
            servers: result.removedServers
              .map((part) => partLine(t, part))
              .join('; '),
          }),
        ]),
    ...result.replacedModels.map(({ subagent, from, to }) =>
      subagent === null
        ? replaced(from, to)
        : t('subagentLine', { subagent, text: replaced(from, to) }),
    ),
    // A removed skill the source read does not name was deleted meanwhile: it vanishes without a mark (UXRD SK-01).
    ...(removedSkills.length === 0
      ? []
      : [t('copy.removedSkills', { names: removedSkills.join(', ') })]),
  ];
  return {
    title: runsNowhere
      ? t('copy.noModels', { name })
      : t('copy.saved', { name }),
    description: details.length === 0 ? undefined : `${details.join('. ')}.`,
  };
}

export type CopyRecord = {
  /** «Скопировать себе»: copies at once, or first opens the dialog that names what the copy will not get. */
  copy: (record: CopySource) => void;
  /** A copy or its preparation is running: the trigger shows `LoaderCircle` and is unavailable. */
  pending: boolean;
  /** MC-4 «Не удалось скопировать: {причина}» of the last direct copy, `null` — none; the dialog shows its own. */
  error: ReactNode;
  /** The dialog of LB-03; the caller renders it. */
  dialog: ReactNode;
};

/**
 * «Скопировать себе» (UXRD LB-03, MC-4): one `POST …/copy` through `recordAction`, then `libraryIndex` is
 * re-read (the copy joins «Мои»), the notice names the dropped systems and both models of a replacement,
 * and its «Открыть» leads to the copy's page.
 */
export function useCopyRecord(): CopyRecord {
  const { libraryIndex, announcer } = useShellServices();
  const router = useRouter();
  const locale = useLocale();
  const t = useTranslations('errors');
  const tLibrary = useTranslations('library');
  const leaveThenGo = useLeaveThenGo();
  const [plan, setPlan] = useState<CopyPlan | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ReactNode>(null);

  async function run({ record, skillNames }: CopyPlan): Promise<void> {
    const result = await recordAction(
      { recordId: record.id, kind: record.kind, action: 'copy', version: null },
      () => libraryApi.copy(record.id, locale),
    );
    void libraryIndex.refresh();
    const notice = copiedNotice(tLibrary, result, skillNames);
    toast.success(notice.title, {
      description: notice.description,
      action: {
        label: tLibrary('open'),
        onClick: () =>
          leaveThenGo(() => router.push(recordPath(result.record.id))),
      },
    });
    announcer
      .getState()
      .announce('announce.copySaved', { name: result.record.name });
  }

  async function copy(record: CopySource): Promise<void> {
    if (pending) return;
    setPending(true);
    setError(null);
    let next: CopyPlan;
    try {
      next = await planCopy(record, libraryIndex.getState().records);
    } catch (cause) {
      logger.warn('library: copy preparation read failed', {
        recordId: record.id,
        ...describeApiError(cause),
      });
      setError(copyFailed(t, cause));
      setPending(false);
      return;
    }
    if (
      next.dropped.length > 0 ||
      next.allServers !== null ||
      next.hiddenSkills.length > 0
    ) {
      setPlan(next);
      setPending(false);
      return;
    }
    try {
      await run(next);
    } catch (cause) {
      // `recordAction` has logged the refusal.
      setError(copyFailed(t, cause));
    } finally {
      setPending(false);
    }
  }

  async function confirm(): Promise<void> {
    if (plan === null || pending) return;
    setPending(true);
    setError(null);
    try {
      await run(plan);
      setPlan(null);
    } catch (cause) {
      setError(copyFailed(t, cause));
    } finally {
      setPending(false);
    }
  }

  const close = (open: boolean): void => {
    if (open || pending) return;
    setPlan(null);
    setError(null);
  };

  const dialog = (
    <Dialog open={plan !== null} onOpenChange={close}>
      {plan !== null && (
        <DialogContent size="full-narrow">
          <DialogHeader>
            <DialogTitle>
              {tLibrary('copy.title', {
                name: builtinName(plan.record, locale),
              })}
            </DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3 text-sm leading-5">
            <p>{tLibrary('copy.onlyYou')}</p>
            <CopyLines
              heading={tLibrary('copy.dropped')}
              parts={plan.dropped}
            />
            {plan.allServers !== null && (
              <CopyLines
                heading={tLibrary('copy.allServers')}
                parts={[{ subagent: null, servers: plan.allServers }]}
              />
            )}
            {plan.hiddenSkills.length > 0 && (
              <p>
                {tLibrary('copy.droppedSkills', {
                  names: plan.hiddenSkills.join(', '),
                })}
              </p>
            )}
            {error !== null && <FormError>{error}</FormError>}
          </div>
          <DialogFooter>
            <DialogClose
              render={<Button type="button" variant="outline" size="sm" />}
              disabled={pending}
            >
              {tLibrary('cancel')}
            </DialogClose>
            <Button
              type="button"
              size="sm"
              disabled={pending}
              onClick={() => void confirm()}
            >
              {pending && (
                <LoaderCircle
                  className="animate-spin motion-reduce:animate-none"
                  aria-hidden
                />
              )}
              {tLibrary('copy.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );

  return {
    copy: (record) => void copy(record),
    pending,
    error: plan === null ? error : null,
    dialog,
  };
}

/** «{системы}» of the agent itself in one line; a deep agent's parts one line each. */
function CopyLines({
  heading,
  parts,
}: {
  heading: string;
  parts: readonly PartServers[];
}) {
  const t = useTranslations('library');
  if (parts.length === 0) return null;
  const single =
    parts.length === 1 && parts[0]?.subagent === null ? parts[0] : null;
  if (single !== null)
    return <p>{`${heading} ${single.servers.join(', ')}`}</p>;
  return (
    <div className="flex flex-col gap-1">
      <p>{heading}</p>
      <ul className="flex flex-col gap-1 pl-4">
        {parts.map((part) => (
          <li key={part.subagent ?? ''} className="list-disc">
            {partLine(t, part)}
          </li>
        ))}
      </ul>
    </div>
  );
}
