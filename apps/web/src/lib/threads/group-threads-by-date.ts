export type DateGroupKey =
  'today' | 'yesterday' | 'previous7' | 'previous30' | 'older';

export type ThreadListEntry = {
  id: string;
  remoteId: string | undefined;
  title: string | undefined;
  activityAt: number;
  /** The row's menu offers «Ответвить чат» (create-and-test FK-01). */
  forkable: boolean;
  /** The conversation is a fork: the row shows the branch icon (FK-02). */
  forked: boolean;
};

/** A date group by its key; the list translates the key into the group's heading. */
export type ThreadGroup = { key: DateGroupKey; entries: ThreadListEntry[] };

const GROUP_ORDER: readonly DateGroupKey[] = [
  'today',
  'yesterday',
  'previous7',
  'previous30',
  'older',
];

const DAY_MS = 86_400_000;

export type ActivitySources = {
  /** Server activity time (`ThreadSummary.updatedAt`). */
  lastMessageAt: Date | undefined;
  /** Local lift written when a reply starts (D-11). */
  activityAt: number | undefined;
};

/** Effective activity time of a thread: the later of its two sources; a thread with neither counts as active now. */
export function entryActivityAt(
  { lastMessageAt, activityAt }: ActivitySources,
  now: Date,
): number {
  const times = [lastMessageAt?.getTime(), activityAt].filter(
    (time) => time !== undefined,
  );
  return times.length > 0 ? Math.max(...times) : now.getTime();
}

function startOfDay(time: number): number {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function groupKeyFor(days: number): DateGroupKey {
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days <= 7) return 'previous7';
  if (days <= 30) return 'previous30';
  return 'older';
}

/** Calendar-day difference in the browser time zone; DST-safe via rounding (days of 23 or 25 hours). */
export function groupThreadsByDate(
  entries: readonly ThreadListEntry[],
  now: Date,
): ThreadGroup[] {
  const today = startOfDay(now.getTime());
  // Array.prototype.sort is stable, so equal activity times keep their original order.
  const sorted = [...entries].sort((a, b) => b.activityAt - a.activityAt);

  const buckets = new Map<DateGroupKey, ThreadListEntry[]>();
  for (const entry of sorted) {
    const key = groupKeyFor(
      Math.round((today - startOfDay(entry.activityAt)) / DAY_MS),
    );
    const bucket = buckets.get(key);
    if (bucket) bucket.push(entry);
    else buckets.set(key, [entry]);
  }

  return GROUP_ORDER.flatMap((key) => {
    const bucket = buckets.get(key);
    return bucket ? [{ key, entries: bucket }] : [];
  });
}
