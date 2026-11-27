'use client';

import { useId } from 'react';
import { useTranslations } from 'next-intl';
import type {
  ScheduleTool,
  ScheduleToolsResponse,
  ToolPair,
} from '@agent-os/contracts';
import { CAPTION, FormError } from '@/components/admin/admin-form';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { FieldDescription, FieldLegend, FieldSet } from '@/components/ui/field';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useResource, type Resource } from '@/hooks/use-resource';
import type { SchedulesTranslator } from '@/i18n/catalog';
import { schedulesApi } from '@/lib/schedules/schedules-api';
import { cn } from 'cn';

/**
 * «Без вас» (improvements IM-01, IM-02): the changing MCP tools a schedule's run calls without a card. The dialog
 * and the page read the owner's tools on open (read-on-open); a failed read is logged by `useResource`.
 */
export const useScheduleTools = (): Resource<ScheduleToolsResponse> =>
  useResource(() => schedulesApi.tools(), 'schedule-tools', 'schedules');

const samePair = (a: ToolPair, b: ToolPair): boolean =>
  a.server === b.server && a.tool === b.tool;

/** The ticked pairs that are still the owner's: a pair the read list lacks is neither shown nor saved (FR-07). */
export const listedPairs = (
  chosen: readonly ToolPair[],
  tools: readonly ScheduleTool[],
): ToolPair[] =>
  chosen
    .filter((pair) => tools.some((tool) => samePair(tool, pair)))
    .map(({ server, tool }) => ({ server, tool }));

/** IM-02: «{действие} · {система}»; a pair without a title in the read list by its technical name. */
export const allowedToolLine = (
  t: SchedulesTranslator,
  pair: ToolPair,
  tools: readonly ScheduleTool[],
): string =>
  t('page.toolLine', {
    tool: tools.find((tool) => samePair(tool, pair))?.toolTitle ?? pair.tool,
    server: pair.server,
  });

const LABEL = 'text-sm leading-5 font-medium text-foreground';
const HINT = cn(CAPTION, 'text-muted-foreground');
const SKELETON_GROUPS = [0, 1] as const;
const SKELETON_ROWS = [0, 1] as const;

/** The tools by server, in the order the server sorted them. */
function byServer(tools: readonly ScheduleTool[]): [string, ScheduleTool[]][] {
  const groups = new Map<string, ScheduleTool[]>();
  for (const tool of tools)
    groups.set(tool.server, [...(groups.get(tool.server) ?? []), tool]);
  return [...groups];
}

/**
 * IM-01, the dialog's last field: a group per system with a checkbox per action, by the `ServersField` layout. The
 * list is the read one only, so a ticked pair the owner lost is not shown. Loading — the groups' skeleton; a failed
 * read — the form error with «Повторить»; no tools — the MC-1 line.
 */
export function AllowedToolsField({
  tools,
  chosen,
  disabled,
  onChange,
}: {
  tools: Resource<ScheduleToolsResponse>;
  chosen: readonly ToolPair[];
  disabled: boolean;
  onChange: (chosen: ToolPair[]) => void;
}) {
  const t = useTranslations('schedules.dialog.allowedTools');
  const id = useId();
  const hintId = `${id}-hint`;
  const toggle = (pair: ToolPair, checked: boolean): void =>
    onChange(
      checked
        ? [...chosen, pair]
        : chosen.filter((item) => !samePair(item, pair)),
    );

  return (
    <FieldSet
      aria-busy={tools.status === 'loading' || undefined}
      className="gap-2"
    >
      <FieldLegend variant="label" className={cn(LABEL, 'mb-0')}>
        {t('label')}
      </FieldLegend>
      <FieldDescription id={hintId} className={HINT}>
        {t('hint')}
      </FieldDescription>
      {tools.status === 'loading' && (
        <div aria-hidden className="flex flex-col gap-3">
          {SKELETON_GROUPS.map((group) => (
            <div key={group} className="flex flex-col gap-2">
              <Skeleton className="h-4 w-24" />
              {SKELETON_ROWS.map((row) => (
                <Skeleton key={row} className="h-5 w-3/5" />
              ))}
            </div>
          ))}
        </div>
      )}
      {tools.status === 'error' && (
        <FormError>
          {t('loadFailed')}{' '}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="ml-1 pointer-coarse:h-11"
            onClick={tools.reload}
          >
            {t('retry')}
          </Button>
        </FormError>
      )}
      {tools.data !== undefined &&
        (tools.data.tools.length === 0 ? (
          <p className="text-sm leading-5 text-muted-foreground">{t('none')}</p>
        ) : (
          byServer(tools.data.tools).map(([server, rows]) => (
            <ServerGroup
              key={server}
              server={server}
              rows={rows}
              chosen={chosen}
              hintId={hintId}
              disabled={disabled}
              onToggle={toggle}
            />
          ))
        ))}
    </FieldSet>
  );
}

function ServerGroup({
  server,
  rows,
  chosen,
  hintId,
  disabled,
  onToggle,
}: {
  server: string;
  rows: readonly ScheduleTool[];
  chosen: readonly ToolPair[];
  hintId: string;
  disabled: boolean;
  onToggle: (pair: ToolPair, checked: boolean) => void;
}) {
  const headerId = useId();
  return (
    <div
      role="group"
      aria-labelledby={headerId}
      className="flex flex-col gap-1"
    >
      <p id={headerId} className={HINT}>
        {server}
      </p>
      {rows.map((row) => (
        <Label
          key={row.tool}
          className="flex w-fit items-center gap-2 text-sm leading-5 font-normal text-foreground pointer-coarse:min-h-11"
        >
          <Checkbox
            checked={chosen.some((pair) => samePair(pair, row))}
            disabled={disabled}
            aria-describedby={hintId}
            onCheckedChange={(next) =>
              onToggle({ server: row.server, tool: row.tool }, next)
            }
          />
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 max-[480px]:flex-col">
            <span className="wrap-break-word">{row.toolTitle ?? row.tool}</span>
            {row.toolTitle !== undefined && (
              <span className="font-mono text-xs leading-4 break-all text-muted-foreground">
                {row.tool}
              </span>
            )}
          </span>
        </Label>
      ))}
    </div>
  );
}
