'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useShellServices } from '@/components/shell/shell-actions';
import { describeApiError, isApiRequestError } from '@/lib/api/api-request';
import { logger } from '@/lib/logger';

/** A row's level and its marks; the marks count only while the level is `pick`. */
export type LevelValue<L extends string, M> = { level: L; marks: M };

/** One row of a level tab: a server of a role or an employee, or a role of a server. */
export type DraftRow<L extends string, M> = {
  key: string;
  value: LevelValue<L, M>;
};

export type DraftStatus = 'idle' | 'saving' | 'saved' | 'failed';

type LevelDraftOptions<R, L extends string, M> = {
  /** The tab's route as it was read; `undefined` while it is read. */
  read: R | undefined;
  /** The saved rows of a read or of a save's answer; a module-level function, so the rows are not rebuilt per render. */
  rowsOf: (response: R) => readonly DraftRow<L, M>[];
  /** The value of a row the answer does not hold: a role of a server without access. */
  blank: LevelValue<L, M>;
  sameMarks: (a: M, b: M) => boolean;
  /** The marks «Выборочно» starts with when the row comes from `from` (UXRD KD-10), by the response shown. */
  startPick: (key: string, from: LevelValue<L, M>, shown: R | undefined) => M;
  /** Sends the changed rows; answers the route's response after the save. */
  save: (changed: readonly DraftRow<L, M>[]) => Promise<R>;
  logEvent: string;
};

export type LevelDraft<L extends string, M> = {
  /** The row as the screen shows it: the draft, otherwise the saved value. */
  value: (key: string) => LevelValue<L, M>;
  isChanged: (key: string) => boolean;
  /** Changed rows, not marks: a row with a new level and new marks is one (access-level-editor, States). */
  changedCount: number;
  setLevel: (key: string, level: L) => void;
  setMarks: (key: string, marks: M) => void;
  discard: () => void;
  submit: () => Promise<void>;
  status: DraftStatus;
  /** The last refused save; cleared by the next change, discard or save. */
  error: unknown;
  /** The rows whose tools are open; kept with the draft, so switching tabs keeps them open. */
  isExpanded: (key: string) => boolean;
  setExpanded: (key: string, open: boolean) => void;
  collapseAll: () => void;
};

/** The draft and the response the screen shows: the last save's answer, otherwise the read. */
export type LevelDraftState<R, L extends string, M> = {
  shown: R | undefined;
  draft: LevelDraft<L, M>;
};

/**
 * The draft of a level tab (access-levels KD-7, UXRD KD-10, KD-11): it lives on the page, so switching tabs keeps
 * it, and while it has changes the shell's `leaveGuard` asks MC-37 before leaving. «Сохранить» sends only the
 * changed rows and takes the answer as the saved rows until the next read; a refusal leaves every change on screen.
 */
export function useLevelDraft<R, L extends string, M>({
  read,
  rowsOf,
  blank,
  sameMarks,
  startPick,
  save,
  logEvent,
}: LevelDraftOptions<R, L, M>): LevelDraftState<R, L, M> {
  const { leaveGuard } = useShellServices();
  // The answer of the last save replaces the read it was made on: the route is not read again after a save,
  // and a new read (a retry, another record) supersedes the answer.
  const [answered, setAnswered] = useState<{ read: R; value: R } | null>(null);
  const shown =
    answered !== null && answered.read === read ? answered.value : read;
  const [draft, setDraft] = useState<ReadonlyMap<string, LevelValue<L, M>>>(
    new Map(),
  );
  // The marks a row had when it left «Выборочно», shown again when it comes back before a save.
  const [pickMemory, setPickMemory] = useState<ReadonlyMap<string, M>>(
    new Map(),
  );
  const [status, setStatus] = useState<DraftStatus>('idle');
  const [error, setError] = useState<unknown>(null);
  const [expanded, setExpandedRows] = useState<ReadonlySet<string>>(new Set());

  const savedByKey = useMemo(
    () =>
      new Map(
        (shown === undefined ? [] : rowsOf(shown)).map((row) => [
          row.key,
          row.value,
        ]),
      ),
    [shown, rowsOf],
  );
  const savedValue = useCallback(
    (key: string): LevelValue<L, M> => savedByKey.get(key) ?? blank,
    [savedByKey, blank],
  );
  const same = useCallback(
    (a: LevelValue<L, M>, b: LevelValue<L, M>): boolean =>
      a.level === b.level &&
      (a.level !== 'pick' || sameMarks(a.marks, b.marks)),
    [sameMarks],
  );

  const value = (key: string): LevelValue<L, M> =>
    draft.get(key) ?? savedValue(key);

  /** A row equal to its saved value leaves the draft, so it stops counting. */
  const put = (key: string, next: LevelValue<L, M>): void => {
    setError(null);
    if (status === 'saved' || status === 'failed') setStatus('idle');
    setDraft((current) => {
      const updated = new Map(current);
      if (same(next, savedValue(key))) updated.delete(key);
      else updated.set(key, next);
      return updated;
    });
  };

  const setLevel = (key: string, level: L): void => {
    const current = value(key);
    if (current.level === level) return;
    if (current.level === 'pick')
      setPickMemory((memory) => new Map(memory).set(key, current.marks));
    if (level !== 'pick') {
      put(key, { level, marks: current.marks });
      return;
    }
    const stored = savedValue(key);
    const marks =
      pickMemory.get(key) ??
      (stored.level === 'pick' ? stored.marks : startPick(key, current, shown));
    put(key, { level, marks });
  };

  const setMarks = (key: string, marks: M): void =>
    put(key, { level: value(key).level, marks });

  const discard = (): void => {
    setDraft(new Map());
    setPickMemory(new Map());
    setError(null);
    setStatus('idle');
  };

  const submit = async (): Promise<void> => {
    if (draft.size === 0 || status === 'saving') return;
    const changed = [...draft].map(([key, next]) => ({ key, value: next }));
    setError(null);
    setStatus('saving');
    try {
      const after = await save(changed);
      if (read !== undefined) setAnswered({ read, value: after });
      setDraft(new Map());
      setPickMemory(new Map());
      setStatus('saved');
    } catch (refusal) {
      if (isApiRequestError(refusal))
        logger.warn(`${logEvent}: refused`, {
          changed: changed.length,
          ...describeApiError(refusal),
        });
      else logger.error(`${logEvent}: failed`, { error: refusal });
      setError(refusal);
      setStatus('failed');
    }
  };

  const changedCount = draft.size;
  useEffect(() => {
    if (changedCount > 0)
      leaveGuard.hold({ kind: 'access', changes: changedCount });
    else leaveGuard.release();
  }, [changedCount, leaveGuard]);
  useEffect(() => () => leaveGuard.release(), [leaveGuard]);

  const setExpanded = useCallback(
    (key: string, open: boolean): void =>
      setExpandedRows((current) => {
        if (current.has(key) === open) return current;
        const next = new Set(current);
        if (open) next.add(key);
        else next.delete(key);
        return next;
      }),
    [],
  );

  return {
    shown,
    draft: {
      value,
      isChanged: (key) => draft.has(key),
      changedCount,
      setLevel,
      setMarks,
      discard,
      submit,
      status,
      error,
      isExpanded: (key) => expanded.has(key),
      setExpanded,
      collapseAll: () => setExpandedRows(new Set()),
    },
  };
}
