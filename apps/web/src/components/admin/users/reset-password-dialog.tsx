'use client';

import { PasswordField } from '@/components/password-field';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { adminApi } from '@/lib/admin/admin-api';
import { passwordResetRules } from '@/lib/admin/form-rules';
import { AdminForm } from '../admin-form';

/** UXRD MC-23. */
const TEXT = {
  password: 'Новый пароль',
  submit: 'Сбросить',
  done: 'Пароль сброшен — передайте новый сотруднику',
} as const;

const titleFor = (name: string): string => `Новый пароль для ${name}`;

type ResetPasswordDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  user: { id: string; name: string };
  /**
   * Runs the reset for the page: the page reads the employee again and handles a 404 itself (Error
   * handling); any other refusal reaches the form, which shows it at the field or above the actions.
   */
  track: (request: () => Promise<unknown>) => Promise<void>;
};

/**
 * UXRD AD-04 «Сбросить пароль» of a local account. The form mounts with the dialog's content, so the new
 * password lives only in the open dialog's state: a reopened dialog starts empty (Invariant 3).
 */
export function ResetPasswordDialog({ open, onOpenChange, user, track }: ResetPasswordDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{titleFor(user.name)}</DialogTitle>
        </DialogHeader>
        <AdminForm
          variant="dialog"
          initialValues={{ password: '' }}
          validate={passwordResetRules}
          onSubmit={({ password }) => track(() => adminApi.users.resetPassword(user.id, password))}
          submitLabel={TEXT.submit}
          savedText={TEXT.done}
          onSaved={() => onOpenChange(false)}
          logEvent="admin: user password reset"
        >
          {(form) => (
            <PasswordField
              {...form.field('password')}
              label={TEXT.password}
              autoComplete="new-password"
              panel
              value={form.values.password}
              disabled={form.saving}
              onChange={(value) => form.set('password', value)}
            />
          )}
        </AdminForm>
      </DialogContent>
    </Dialog>
  );
}
