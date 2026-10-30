'use client';

import { useId, useRef, useState, type KeyboardEvent } from 'react';
import { Input } from '@/components/ui/input';

/** Server limit for a thread title (FR-15): input past it is not accepted. */
const MAX_TITLE_LENGTH = 200;

export type ThreadTitleFieldProps = {
  /** The title shown in the row; the field opens with it selected. */
  initialTitle: string;
  /** A trimmed, non-empty title that differs from `initialTitle`. */
  onSave: (title: string) => void;
  /** Esc, or leaving the field with nothing to save. */
  onCancel: () => void;
};

/**
 * SB-08: in-place rename field. Enter saves the trimmed title, Esc cancels, leaving the field saves when the
 * value is valid and changed. An empty value on Enter keeps the field open with «Введите название» (AC-05.3).
 */
export function ThreadTitleField({ initialTitle, onSave, onCancel }: ThreadTitleFieldProps) {
  const errorId = useId();
  const [value, setValue] = useState(initialTitle);
  const [invalid, setInvalid] = useState(false);
  // Enter/Esc close the field; the blur that follows the unmount must not finish it a second time.
  const finished = useRef(false);

  const finish = (title: string | null): void => {
    if (finished.current) return;
    finished.current = true;
    if (title === null || title === initialTitle) onCancel();
    else onSave(title);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape') {
      // Esc belongs to the field: the drawer around the list must stay open.
      event.preventDefault();
      event.stopPropagation();
      finish(null);
      return;
    }
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
    event.preventDefault();
    const title = value.trim();
    if (title === '') {
      setInvalid(true);
      return;
    }
    finish(title);
  };

  const onBlur = (): void => {
    const title = value.trim();
    finish(title === '' ? null : title);
  };

  return (
    <div data-shortcuts-blocked="" className="flex flex-col gap-1 py-0.5">
      <Input
        aria-label="Название беседы"
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? errorId : undefined}
        maxLength={MAX_TITLE_LENGTH}
        value={value}
        autoFocus
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => {
          setValue(event.target.value);
          if (event.target.value.trim() !== '') setInvalid(false);
        }}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
        className="bg-background h-8 pointer-coarse:h-10"
      />
      {invalid && (
        <p id={errorId} className="text-destructive px-0.5 text-xs">
          Введите название
        </p>
      )}
    </div>
  );
}
