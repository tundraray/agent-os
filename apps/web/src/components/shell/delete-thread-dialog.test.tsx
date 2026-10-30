import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { DeleteThreadDialog } from './delete-thread-dialog';

const A4_TEXT = 'Ответ ассистента в этой беседе ещё генерируется — он будет остановлен.';

type HarnessProps = {
  isRunning?: boolean;
  onConfirm?: () => void;
};

/** The dialog opened from a «⋯» button that is its final-focus target, as the thread list renders it. */
function Harness({ isRunning = false, onConfirm = vi.fn() }: HarnessProps) {
  const [open, setOpen] = useState(false);
  const actionsRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={actionsRef} type="button" onClick={() => setOpen(true)}>
        Действия с беседой «Отчёт Q3»
      </button>
      <DeleteThreadDialog
        open={open}
        threadTitle="Отчёт Q3"
        isRunning={isRunning}
        onConfirm={onConfirm}
        onOpenChange={setOpen}
        finalFocus={actionsRef}
      />
    </>
  );
}

async function openDialog(props: HarnessProps = {}) {
  const user = userEvent.setup();
  render(<Harness {...props} />);
  await user.click(screen.getByRole('button', { name: 'Действия с беседой «Отчёт Q3»' }));
  const dialog = await screen.findByRole('alertdialog', { name: 'Удалить беседу?' });
  return { user, dialog };
}

describe('DeleteThreadDialog — DLG-01 (AC-06.1, A-4)', () => {
  it('is an alertdialog «Удалить беседу?» naming the thread in «ёлочки», with focus on «Отмена»', async () => {
    const { dialog } = await openDialog();

    expect(dialog).toHaveAccessibleDescription(
      'Беседа «Отчёт Q3» и все её сообщения будут удалены. Это действие нельзя отменить.',
    );
    expect(within(dialog).getAllByRole('button').map((button) => button.textContent)).toEqual(['Отмена', 'Удалить']);
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Отмена' })).toHaveFocus());
    expect(within(dialog).queryByText(A4_TEXT)).toBeNull();
  });

  it('A-4: while a reply is generating the dialog adds that it will be stopped', async () => {
    const { dialog } = await openDialog({ isRunning: true });

    expect(within(dialog).getByText(A4_TEXT)).toBeVisible();
    expect(dialog).toHaveAccessibleDescription(expect.stringContaining(A4_TEXT));
  });

  it('«Удалить» confirms once and closes the dialog at once', async () => {
    const onConfirm = vi.fn<() => void>();
    const { user, dialog } = await openDialog({ onConfirm });

    await user.click(within(dialog).getByRole('button', { name: 'Удалить' }));

    expect(onConfirm).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

  it('«Отмена» closes without confirming and returns focus to «⋯»', async () => {
    const onConfirm = vi.fn<() => void>();
    const { user, dialog } = await openDialog({ onConfirm });

    await user.click(within(dialog).getByRole('button', { name: 'Отмена' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(onConfirm).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Действия с беседой «Отчёт Q3»' })).toHaveFocus());
  });
});
