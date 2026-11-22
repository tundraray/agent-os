'use client';

import { useEffect, useRef, useState } from 'react';
import { Workflow } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { useStore } from 'zustand';
import type { Confirmation, RecordFocus, RecordKind, RunTaskListView } from '@agent-os/contracts';
import { RunTaskList, useRunTasks } from '@/components/agents/run-task-list';
import { DefinitionView } from '@/components/library/definition-view';
import { RecordLabel } from '@/components/library/record-label';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useResource, type Resource } from '@/hooks/use-resource';
import { isApiRequestError } from '@/lib/api/api-request';
import { FeedProvider, useFeedSelector, useFeedStoreSelector } from '@/lib/feed/feed-context';
import type { FeedState, FeedStore } from '@/lib/feed/feed-store';
import { recordCardOf } from '@/lib/feed/to-feed';
import { formatListTime } from '@/lib/i18n/formats';
import { libraryApi } from '@/lib/library/library-api';
import type { SchemaTab } from '@/lib/shell/workspace-store';
import { recordPath } from '@/lib/shell-route';
import { useShellServices } from './shell-actions';
import { ShellLink } from './shell-link';

/** Skeleton rows of the loading state (UXRD DA-12: the header and six rows). */
const SKELETON_ROWS = ['w-11/12', 'w-2/3', 'w-5/6', 'w-1/2', 'w-3/4', 'w-2/5'];

const NO_DECISIONS: readonly Confirmation[] = [];

const LINK_CLASS =
  'text-foreground focus-visible:ring-ring self-start rounded-sm text-sm leading-5 underline underline-offset-2 outline-none focus-visible:ring-2';

/** The record the conversation last touched (KD-6); null off a conversation and while it touched none. */
const selectFocus = (state: FeedState): RecordFocus | null => (state.view?.kind === 'thread' ? state.view.focus : null);
const selectRoot = (state: FeedState): string | null => (state.view?.kind === 'thread' ? state.view.chat.rootAgentId : null);
const selectThread = (state: FeedState): string | null => (state.view?.kind === 'thread' ? state.view.threadId : null);

/** The conversation's own task list as the panel and its automatic open read it. */
export type ChatTasks = {
  /** The conversation's root; null off a conversation and before its first read. */
  rootAgentId: string | null;
  tasks: Resource<RunTaskListView>;
  /** The tab «Задачи» is there: it comes with the conversation's first task and stays (UXRD DA-12). */
  tabShown: boolean;
};

/**
 * The open conversation's task list — its root's list, read once for the shell and re-read on every `tree` note of
 * the conversation (design-task-list.md, KD-5). `feed` is null where the panel is not offered.
 */
export function useChatTasks(feed: FeedStore | null): ChatTasks {
  const rootAgentId = useFeedStoreSelector(feed, selectRoot, null);
  const threadId = useFeedStoreSelector(feed, selectThread, null);
  const tasks = useRunTasks(rootAgentId, threadId);
  // The root that has had a task in this visit: deleting every task does not take the tab away.
  const [listedRoot, setListedRoot] = useState<string | null>(null);
  const hasTasks = (tasks.data?.tasks.length ?? 0) > 0;
  if (hasTasks && rootAgentId !== null && listedRoot !== rootAgentId) setListedRoot(rootAgentId);
  return { rootAgentId, tasks, tabShown: rootAgentId !== null && (hasTasks || listedRoot === rootAgentId) };
}

/**
 * The content of the panel «Схема» (deep-agents UXRD DA-12): the record in focus drawn as a column and, once the
 * conversation has a task, the tab «Задачи» with its own list. Read-only; `feed` is the open conversation's
 * store, null on `/` before its first message.
 */
export function SchemaPanel({ feed, chatTasks }: { feed: FeedStore | null; chatTasks: ChatTasks }) {
  return (
    <FeedProvider feed={feed}>
      <SchemaPanelContent chatTasks={chatTasks} />
    </FeedProvider>
  );
}

function SchemaPanelContent({ chatTasks }: { chatTasks: ChatTasks }) {
  const { workspace } = useShellServices();
  const tab = useStore(workspace, (state) => state.tab);
  const focus = useFeedSelector(selectFocus, null);

  if (!chatTasks.tabShown) return <FocusSchema focus={focus} />;
  return <SchemaTabs tasks={chatTasks.tasks} tab={tab} onTab={(next) => workspace.setTab(next)} focus={focus} />;
}

type SchemaTabsProps = {
  tasks: Resource<RunTaskListView>;
  tab: SchemaTab;
  onTab: (tab: SchemaTab) => void;
  focus: RecordFocus | null;
};

/** «Схема» and «Задачи · {N}» (MC-9): «Задачи» shows the conversation's list whatever record is in focus. */
function SchemaTabs({ tasks, tab, onTab, focus }: SchemaTabsProps) {
  const t = useTranslations('agents.tasks');
  const tSchema = useTranslations('shell.schema');
  const count = tasks.data?.tasks.length ?? 0;
  return (
    <Tabs value={tab} onValueChange={(value: SchemaTab) => onTab(value)} className="gap-3">
      <TabsList className="w-full">
        <TabsTrigger value="schema" className="pointer-coarse:h-11">
          {tSchema('title')}
        </TabsTrigger>
        <TabsTrigger value="tasks" className="pointer-coarse:h-11">
          {t('tabs.tasks', { count })}
        </TabsTrigger>
      </TabsList>
      <TabsContent value="schema">
        <FocusSchema focus={focus} />
      </TabsContent>
      <TabsContent value="tasks">
        <RunTaskList tasks={tasks} layout="panel" />
      </TabsContent>
    </Tabs>
  );
}

/** «Пусто» while the conversation touched no record, otherwise the record in focus. */
function FocusSchema({ focus }: { focus: RecordFocus | null }) {
  const t = useTranslations('shell.schema');
  if (focus === null) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
        <Workflow aria-hidden className="text-muted-foreground size-6" />
        <h3 className="text-foreground text-base leading-6 font-semibold">{t('emptyTitle')}</h3>
        <p className="text-muted-foreground max-w-xs text-sm leading-5">{t('emptyHint')}</p>
      </div>
    );
  }
  // A new key per record: nothing of one record's read carries over to the next.
  return <FocusRecord key={focus.recordId} focus={focus} />;
}

type KnownRecord = { kind: RecordKind; name: string };

/**
 * The record in focus, read by `GET /api/library/:id` and read again when the focus time changes (a new edit of
 * the same record, AC-28.2); the version on screen stays until the new one replaces it.
 */
function FocusRecord({ focus }: { focus: RecordFocus }) {
  const t = useTranslations('shell.schema');
  const tLibrary = useTranslations('library');
  const tCard = useTranslations('agents.recordCard');
  const format = useFormatter();
  const record = useResource(() => libraryApi.get(focus.recordId), focus.recordId, 'library');
  const { reload } = record;
  const readAt = useRef(focus.at);
  useEffect(() => {
    if (readAt.current === focus.at) return;
    readAt.current = focus.at;
    reload();
  }, [focus.at, reload]);

  // Name and kind for «удалён или закрыт для вас»: the last read in this panel, else the conversation's last card.
  const decisions = useFeedSelector((state) => state.view?.decisions ?? NO_DECISIONS, NO_DECISIONS);
  const [lastRead, setLastRead] = useState<KnownRecord | null>(null);
  if (record.data !== undefined && (lastRead?.name !== record.data.name || lastRead.kind !== record.data.kind)) {
    setLastRead({ kind: record.data.kind, name: record.data.name });
  }

  if (record.status === 'loading') return <SchemaSkeleton />;
  if (record.status === 'error' || record.data === undefined) {
    const known = lastRead ?? knownFromCards(decisions, focus.recordId);
    if (isApiRequestError(record.error) && record.error.kind === 'not_found' && known !== null) {
      return <p className="text-muted-foreground py-6 text-center text-sm leading-5">{t('gone', known)}</p>;
    }
    return (
      <div className="flex flex-col items-center gap-3 py-6 text-center">
        <p className="text-foreground text-sm leading-5">{t('loadError')}</p>
        <Button variant="outline" size="sm" className="pointer-coarse:h-11" onClick={reload}>
          {t('retry')}
        </Button>
      </div>
    );
  }

  const data = record.data;
  const changedHere = focus.action === 'created' || focus.action === 'changed';
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <RecordLabel variant="row" summary={data} />
        <span className="text-muted-foreground text-xs leading-4 font-medium">
          {tLibrary('kind', { kind: data.kind })}
          {changedHere && (
            <>
              {' · '}
              {tCard(focus.action === 'created' ? 'created' : 'changedOutcome', { time: formatListTime(format, focus.at) })}
            </>
          )}
        </span>
      </div>
      <DefinitionView definition={data} missingRights={data.missingRights} variant="schema" />
      <ShellLink href={recordPath(data.id)} className={LINK_CLASS}>
        {t('openInLibrary')}
      </ShellLink>
    </div>
  );
}

/** The record's name and kind on the conversation's latest card that names it; null when no card does. */
function knownFromCards(decisions: readonly Confirmation[], recordId: string): KnownRecord | null {
  const card = decisions
    .map(recordCardOf)
    .findLast((candidate) => candidate !== null && candidate.recordId === recordId);
  const shown = card?.next ?? card?.previous;
  return card == null || shown == null ? null : { kind: card.kind, name: shown.name };
}

function SchemaSkeleton() {
  return (
    <div aria-busy className="flex flex-col gap-3">
      <Skeleton className="h-5 w-1/2 motion-reduce:animate-none" />
      {SKELETON_ROWS.map((width) => (
        <Skeleton key={width} className={`h-4 ${width} motion-reduce:animate-none`} />
      ))}
    </div>
  );
}
