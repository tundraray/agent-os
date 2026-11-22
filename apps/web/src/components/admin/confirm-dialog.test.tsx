import { useState } from 'react';
import { render, screen } from '@/test/render';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from './confirm-dialog';

function Harness({
  onConfirm,
  onClose,
}: {
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) onClose();
      }}
      title="Удалить?"
      body="Навсегда"
      confirmLabel="Удалить"
      onConfirm={onConfirm}
      refusalText={() => null}
    />
  );
}

describe('ConfirmDialog', () => {
  // Risk: a dialog closed mid-request lets its follow-up run unseen and a reopened one send the request again.
  it('keeps the dialog open and sends one request while the confirmed request runs', async () => {
    const user = userEvent.setup();
    let finish: () => void = () => undefined;
    const onConfirm = vi.fn(
      () => new Promise<void>((resolve) => (finish = resolve)),
    );
    const onClose = vi.fn();
    render(<Harness onConfirm={onConfirm} onClose={onClose} />);

    await user.click(await screen.findByRole('button', { name: 'Удалить' }));
    expect(screen.getByRole('button', { name: 'Отмена' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Удалить' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Удалить' }));
    await user.keyboard('{Escape}');

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();

    finish();
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});
