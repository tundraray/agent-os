'use client';

import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ChevronRightIcon, Undo2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type {
  McpServerView,
  McpToolView,
  UpdateMcpToolBody,
} from '@agent-os/contracts';
import { useShellServices } from '@/components/shell/shell-actions';
import { StateBadge } from '@/components/state-badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { adminApi } from '@/lib/admin/admin-api';
import { logger } from '@/lib/logger';
import { cn } from '@/lib/utils';
import {
  CAPTION,
  CONTROL_SIZE,
  describeRefusal,
  FormWarning,
} from '../admin-form';
import { ConfirmDialog } from '../confirm-dialog';

type ToolGroup = 'changes' | 'reads';
const GROUPS: readonly ToolGroup[] = ['changes', 'reads'];

const LOG_EVENT = 'admin: server tool';

const groupOf = (readOnly: boolean): ToolGroup =>
  readOnly ? 'reads' : 'changes';

const titleOf = (tool: McpToolView): string => tool.title ?? tool.name;

/**
 * The class a tool has without the admin's correction: «changes» while it is new, else the server's mark, without
 * a mark «changes» (AC-36.4).
 */
const serverClass = (tool: McpToolView): boolean =>
  !tool.isNew && tool.serverReadOnly === true;

/** By the title and the technical name, case-insensitive (access-level-editor, part 6). */
const matches = (tool: McpToolView, needle: string): boolean =>
  needle === '' ||
  titleOf(tool).toLocaleLowerCase().includes(needle) ||
  tool.name.toLocaleLowerCase().includes(needle);

/** Each tool keeps the group it had when the tab opened; a tool the list did not have yet takes its own. */
const placeTools = (
  placed: ReadonlyMap<string, ToolGroup>,
  tools: readonly McpToolView[],
): ReadonlyMap<string, ToolGroup> => {
  const next = new Map(placed);
  for (const tool of tools)
    if (!next.has(tool.name)) next.set(tool.name, groupOf(tool.readOnly));
  return next;
};

type ServerToolsTabProps = {
  server: McpServerView;
  /** Where the tab goes to connect the administrator's own account (a page address, never a request). */
  connectUrl: string;
  /** A change of one tool; a server that is gone reads the server again (the page's `rereadOnNotFound`). */
  change: <T>(request: () => Promise<T>) => Promise<T>;
  /**
   * A tool's class or switch was saved, or the new tools were marked reviewed: the page reads the server again, and
   * what the levels of «Доступ» give follows it.
   */
  onToolSaved: () => void;
};

/**
 * UXRD ST-01: access-level-editor, variant «Настройки инструментов» — the tools in the groups «Меняют» and «Читают»
 * by the class they had when the tab opened; «Доступен» and the class save each at once (UXRD KD-11), a move to
 * «Читает» only after MC-36's confirmation (AC-36.5). New tools count as changing until «Отметить просмотренными»,
 * after which every tool stands in the group of its class again.
 */
export function ServerToolsTab({
  server,
  connectUrl,
  change,
  onToolSaved,
}: ServerToolsTabProps) {
  const t = useTranslations('admin.servers.tools');
  const tPage = useTranslations('admin.servers.page');
  const tErrors = useTranslations('errors');
  const [reviewing, setReviewing] = useState(false);
  const [reviewError, setReviewError] = useState<ReactNode>(null);
  // A saved answer stands only until the page's re-read of the server (started by `onToolSaved`) arrives, so the
  // control does not flick back to the old value in between; the page's server stays the one truth.
  const [answers, setAnswers] = useState<{
    of: readonly McpToolView[];
    views: ReadonlyMap<string, McpToolView>;
  }>({ of: server.tools, views: new Map() });
  if (answers.of !== server.tools)
    setAnswers({ of: server.tools, views: new Map() });
  const tools = server.tools.map(
    (tool) => answers.views.get(tool.name) ?? tool,
  );

  const [placed, setPlaced] = useState(() => placeTools(new Map(), tools));
  if (tools.some((tool) => !placed.has(tool.name)))
    setPlaced(placeTools(placed, tools));

  const [query, setQuery] = useState('');
  const [onlyNew, setOnlyNew] = useState(false);
  const [openGroups, setOpenGroups] = useState<
    Readonly<Record<ToolGroup, boolean>>
  >({ changes: true, reads: false });

  if (tools.length === 0)
    return (
      <div className="flex flex-col items-center gap-1 py-12 text-center">
        <p className="text-sm leading-5 font-medium text-foreground">
          {t('empty')}
        </p>
        <p className={cn(CAPTION, 'max-w-md text-muted-foreground')}>
          {server.status === 'awaiting_admin_account'
            ? t('awaitingHint', { server: server.name })
            : t('noToolsHint')}
        </p>
        {server.status === 'awaiting_admin_account' && (
          <a
            href={connectUrl}
            className={buttonVariants({
              size: 'sm',
              className: cn(CONTROL_SIZE, 'mt-3'),
            })}
          >
            {tPage('connect')}
          </a>
        )}
      </div>
    );

  const saved = (view: McpToolView): void => {
    setAnswers((current) => ({
      of: current.of,
      views: new Map(current.views).set(view.name, view),
    }));
    onToolSaved();
  };

  /** «Отметить просмотренными»: the server's answer places every tool by its class without the new marks. */
  const markReviewed = async (): Promise<void> => {
    setReviewError(null);
    setReviewing(true);
    try {
      const view = await change(() =>
        adminApi.servers.markToolsReviewed(server.name),
      );
      logger.info(`${LOG_EVENT}s: marked reviewed`, { server: server.name });
      setAnswers((current) => ({
        of: current.of,
        views: new Map(view.tools.map((tool) => [tool.name, tool])),
      }));
      setPlaced(placeTools(new Map(), view.tools));
      setOnlyNew(false);
      onToolSaved();
    } catch (cause) {
      setReviewError(
        describeRefusal(tErrors, cause, { logEvent: LOG_EVENT })?.text ?? null,
      );
    } finally {
      setReviewing(false);
    }
  };

  const needle = query.trim().toLocaleLowerCase();
  const filtering = needle !== '' || onlyNew;
  const shownOf = (group: ToolGroup) =>
    tools.filter(
      (tool) =>
        placed.get(tool.name) === group &&
        matches(tool, needle) &&
        (!onlyNew || tool.isNew),
    );
  const newCount = tools.filter((tool) => tool.isNew).length;
  const nothingShown = GROUPS.every((group) => shownOf(group).length === 0);

  return (
    <div className="flex flex-col gap-3">
      <p className="text-data text-muted-foreground">{t('description')}</p>
      {newCount > 0 && (
        <FormWarning>
          <span className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <span>{t('newWarning', { count: newCount })}</span>
            <span className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className={CONTROL_SIZE}
                aria-pressed={onlyNew}
                onClick={() => setOnlyNew(!onlyNew)}
              >
                {onlyNew ? t('showAll') : t('showNew')}
              </Button>
              <Button
                type="button"
                size="sm"
                className={CONTROL_SIZE}
                disabled={reviewing}
                onClick={() => void markReviewed()}
              >
                {t('markReviewed')}
              </Button>
            </span>
          </span>
          {reviewError !== null && (
            <p role="alert" className={cn(CAPTION, 'mt-1 text-destructive')}>
              {reviewError}
            </p>
          )}
        </FormWarning>
      )}
      <Input
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && query !== '') {
            event.stopPropagation();
            setQuery('');
          }
        }}
        aria-label={t('search')}
        placeholder={t('search')}
        className={cn(CONTROL_SIZE, 'text-data md:w-72 md:text-data')}
      />
      {nothingShown ? (
        <p className="flex flex-wrap items-center gap-2 text-data text-muted-foreground">
          {t('noMatches')}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={CONTROL_SIZE}
            onClick={() => {
              setQuery('');
              setOnlyNew(false);
            }}
          >
            {t('resetSearch')}
          </Button>
        </p>
      ) : (
        <section
          aria-label={t('listName', { server: server.name })}
          className="flex min-w-0 flex-col gap-2"
        >
          {GROUPS.map((group) => {
            const inGroup = tools.filter(
              (tool) => placed.get(tool.name) === group,
            );
            const shown = shownOf(group);
            if (inGroup.length === 0 || (filtering && shown.length === 0))
              return null;
            return (
              <ToolGroupBlock
                key={group}
                server={server.name}
                group={group}
                // A closed group with matches opens by itself while the search or «Показать новые» holds.
                open={openGroups[group] || filtering}
                onOpenChange={(open) =>
                  setOpenGroups((current) => ({ ...current, [group]: open }))
                }
                total={inGroup.length}
                disabledCount={inGroup.filter((tool) => !tool.enabled).length}
              >
                {shown.map((tool) => (
                  <ToolSettingsRow
                    key={tool.name}
                    server={server.name}
                    tool={tool}
                    placedGroup={group}
                    change={change}
                    onSaved={saved}
                  />
                ))}
              </ToolGroupBlock>
            );
          })}
        </section>
      )}
    </div>
  );
}

type ToolGroupBlockProps = {
  server: string;
  group: ToolGroup;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  total: number;
  disabledCount: number;
  children: ReactNode;
};

/** Part 7 without the group's checkbox: the chevron, «Меняют · {m}» or «Читают · {m}» and «выключено: {k}». */
function ToolGroupBlock({
  server,
  group,
  open,
  onOpenChange,
  total,
  disabledCount,
  children,
}: ToolGroupBlockProps) {
  const t = useTranslations('admin.servers.tools');
  const tLevels = useTranslations('admin.levels.group');
  const listId = useId();
  const name =
    group === 'changes'
      ? tLevels('toggleChanges', { server })
      : tLevels('toggleReads', { server });
  return (
    <div className="flex flex-col">
      <div className="flex min-h-8 items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="size-7 pointer-coarse:size-11"
          aria-expanded={open}
          aria-controls={listId}
          aria-label={name}
          onClick={() => onOpenChange(!open)}
        >
          <ChevronRightIcon
            aria-hidden
            className={cn(
              'size-3.5 transition-transform duration-150 motion-reduce:transition-none',
              open && 'rotate-90',
            )}
          />
        </Button>
        <span className="text-data font-medium">
          {t(`group.${group}`, { m: total })}
        </span>
        {disabledCount > 0 && (
          <span className={cn(CAPTION, 'text-muted-foreground')}>
            {t('group.disabled', { k: disabledCount })}
          </span>
        )}
      </div>
      {open && (
        <ul id={listId} aria-label={name} className="flex flex-col pl-9">
          {children}
        </ul>
      )}
    </div>
  );
}

type ToolSettingsRowProps = {
  server: string;
  tool: McpToolView;
  /** The group the tool stands in until the tab opens again. */
  placedGroup: ToolGroup;
  change: ServerToolsTabProps['change'];
  onSaved: (view: McpToolView) => void;
};

/** A control being saved: the position it shows until the answer. */
type Pending = { enabled?: boolean; readOnly?: boolean };

/**
 * Part 8, variant «Настройки инструментов»: the title, the technical name, «новый», the description with «Ещё», and
 * «Доступен» and the class, each saved at once. A refusal puts the control back and names the reason under the row.
 */
function ToolSettingsRow({
  server,
  tool,
  placedGroup,
  change,
  onSaved,
}: ToolSettingsRowProps) {
  const t = useTranslations('admin.servers.tools');
  const tErrors = useTranslations('errors');
  const { announcer } = useShellServices();
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState<ReactNode>(null);
  /** The body a move to «Читает» sends once confirmed. */
  const [confirming, setConfirming] = useState<UpdateMcpToolBody | null>(null);
  const title = titleOf(tool);
  const enabled = pending?.enabled ?? tool.enabled;
  const readOnly = pending?.readOnly ?? tool.readOnly;
  const group = groupOf(readOnly);

  /** Sends the change; throws on a refusal (the confirmation shows it itself). */
  const send = async (body: UpdateMcpToolBody): Promise<void> => {
    const view = await change(() =>
      adminApi.servers.updateTool(server, tool.name, body),
    );
    logger.info(`${LOG_EVENT}: saved`, {
      server,
      tool: tool.name,
      enabled: view.enabled,
      readOnly: view.readOnly,
      overridden: view.overridden,
    });
    onSaved(view);
    const announce =
      body.enabled === undefined
        ? view.readOnly
          ? 'admin.servers.tools.announce.reads'
          : 'admin.servers.tools.announce.changes'
        : view.enabled
          ? 'admin.servers.tools.announce.enabled'
          : 'admin.servers.tools.announce.disabled';
    announcer.getState().announce(announce, { tool: title });
  };

  /** settings-form «Сохранение на месте»: the control stands in its new position and is unavailable until the answer. */
  const saveInPlace = async (
    body: UpdateMcpToolBody,
    shown: Pending,
  ): Promise<void> => {
    setError(null);
    setPending(shown);
    try {
      await send(body);
    } catch (cause) {
      setError(
        describeRefusal(tErrors, cause, { logEvent: LOG_EVENT })?.text ?? null,
      );
    } finally {
      setPending(null);
    }
  };

  /** AC-36.5: a move to «Читает» lets calls go without the employee's confirmation — it is asked first. */
  const sendClass = (body: UpdateMcpToolBody, next: boolean): void => {
    if (next && !readOnly) {
      setError(null);
      setConfirming(body);
      return;
    }
    void saveInPlace(body, { readOnly: next });
  };

  /** `readOnly: null` when the class asked for is the server's own: the correction goes, not a copy of the mark. */
  const toClass = (next: boolean): void => {
    if (next === readOnly) return;
    sendClass({ readOnly: next === serverClass(tool) ? null : next }, next);
  };

  const saving = pending !== null;
  const serverMark =
    tool.serverReadOnly === null
      ? 'none'
      : tool.serverReadOnly
        ? 'reads'
        : 'changes';

  return (
    <li
      data-tool={tool.name}
      className="flex flex-col gap-1 border-b border-border py-2 last:border-b-0"
    >
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-1 basis-64 flex-col gap-0.5">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
            <span
              className={cn(
                // A long title without spaces wraps instead of widening the page.
                'min-w-0 text-data [overflow-wrap:anywhere]',
                enabled ? 'text-foreground' : 'text-muted-foreground',
              )}
            >
              {title}
            </span>
            <span
              className="max-w-full min-w-0 truncate font-mono text-mono-compact text-muted-foreground"
              title={tool.name}
            >
              {tool.name}
            </span>
            {tool.isNew && (
              <StateBadge variant="source">{t('isNew')}</StateBadge>
            )}
          </div>
          {group !== placedGroup && (
            <p className={cn(CAPTION, 'text-muted-foreground')}>
              {t(`movedTo.${group}`)}
            </p>
          )}
          {tool.description !== '' && <Description text={tool.description} />}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <label className="flex items-center gap-2">
            <Switch
              checked={enabled}
              disabled={saving}
              aria-label={t('availableName', { title })}
              onCheckedChange={(next) =>
                void saveInPlace({ enabled: next }, { enabled: next })
              }
              className="pointer-coarse:after:-inset-3"
            />
            <span
              aria-hidden
              className={cn(
                'text-data text-foreground',
                saving && 'opacity-50',
              )}
            >
              {t('available')}
            </span>
          </label>
          <Select
            value={group}
            onValueChange={(next) => {
              if (next === 'reads' || next === 'changes')
                toClass(next === 'reads');
            }}
            items={GROUPS.map((value) => ({
              value,
              label: t(`class.${value}`),
            }))}
            disabled={saving}
          >
            <SelectTrigger
              size="sm"
              aria-label={t('className', { title })}
              className={cn(CONTROL_SIZE, 'w-30 text-data')}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {GROUPS.map((value) => (
                <SelectItem
                  key={value}
                  value={value}
                  className="pointer-coarse:min-h-11"
                >
                  {t(`class.${value}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {tool.isNew && !tool.overridden && (
            <span className={cn(CAPTION, 'text-muted-foreground')}>
              {t('newClass')}
            </span>
          )}
          {tool.overridden && (
            <span className="flex items-center gap-2">
              <StateBadge variant="source">{t('overridden')}</StateBadge>
              <span className={cn(CAPTION, 'text-muted-foreground')}>
                {t(`serverMark.${serverMark}`)}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="size-7 pointer-coarse:size-11"
                aria-label={t('revertName', { title })}
                title={t('revert')}
                disabled={saving}
                onClick={() => sendClass({ readOnly: null }, serverClass(tool))}
              >
                <Undo2 aria-hidden className="size-3.5" />
              </Button>
            </span>
          )}
        </div>
      </div>
      {error !== null && (
        <p role="alert" className={cn(CAPTION, 'text-destructive')}>
          {error}
        </p>
      )}
      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
        title={t('confirm.title', { tool: title })}
        body={t('confirm.body')}
        confirmLabel={t('confirm.action')}
        onConfirm={async () => {
          if (confirming !== null) await send(confirming);
        }}
        logEvent={LOG_EVENT}
      />
    </li>
  );
}

/** The server's description in one Caption line; «Ещё» shows it whole, only when the line cuts it. */
function Description({ text }: { text: string }) {
  const t = useTranslations('admin.servers.tools');
  const ref = useRef<HTMLParagraphElement>(null);
  const [whole, setWhole] = useState(false);
  const [cut, setCut] = useState(false);

  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null || whole) return;
    const measure = (): void =>
      setCut(element.scrollWidth > element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text, whole]);

  return (
    <div className="flex min-w-0 items-baseline gap-2">
      <p
        ref={ref}
        className={cn(
          CAPTION,
          'min-w-0 text-muted-foreground',
          whole ? '[overflow-wrap:anywhere]' : 'truncate',
        )}
      >
        {text}
      </p>
      {(cut || whole) && (
        <Button
          type="button"
          variant="link"
          size="sm"
          className={cn(CAPTION, 'h-auto shrink-0 p-0 pointer-coarse:min-h-11')}
          aria-expanded={whole}
          onClick={() => setWhole(!whole)}
        >
          {whole ? t('less') : t('more')}
        </Button>
      )}
    </div>
  );
}
