'use client';

import { useRef } from 'react';
import { toast } from 'sonner';
import { PasswordField } from '@/components/password-field';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { adminApi } from '@/lib/admin/admin-api';
import { accountRules, type AccountValues } from '@/lib/admin/form-rules';
import { AdminForm, AdminTextField } from '../admin-form';

/** UXRD MC-22. */
const TEXT = {
  title: 'Новая учётная запись',
  login: 'Логин',
  name: 'Имя',
  email: 'Почта',
  password: 'Начальный пароль',
  hint: 'Передайте логин и пароль сотруднику сами — он сменит пароль на странице «Мой доступ».',
  submit: 'Завести',
} as const;

/** DC-4: the notice names the login only, never the password. */
const createdText = (login: string): string => `Учётная запись ${login} заведена`;

const EMPTY: AccountValues = { login: '', name: '', email: '', password: '' };

type AccountDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** After the account is created: the list reads again. */
  onCreated: () => void;
};

/**
 * UXRD AD-16: a local account with its starting password. The form mounts with the dialog's content, so the
 * password lives only in the open dialog's state and is gone once it closes (Invariant 3).
 */
export function AccountDialog({ open, onOpenChange, onCreated }: AccountDialogProps) {
  const createdLogin = useRef<string | null>(null);

  const submit = async ({ login, name, email, password }: AccountValues): Promise<void> => {
    const user = await adminApi.users.create({ login: login.trim(), name: name.trim(), email: email.trim(), password });
    createdLogin.current = user.login ?? login.trim();
  };

  const created = (): void => {
    onOpenChange(false);
    if (createdLogin.current !== null) toast.success(createdText(createdLogin.current));
    createdLogin.current = null;
    onCreated();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{TEXT.title}</DialogTitle>
          <DialogDescription>{TEXT.hint}</DialogDescription>
        </DialogHeader>
        <AdminForm
          variant="dialog"
          initialValues={EMPTY}
          validate={accountRules}
          onSubmit={submit}
          submitLabel={TEXT.submit}
          onSaved={created}
          logEvent="admin: user create"
        >
          {(form) => (
            <>
              <AdminTextField
                {...form.field('login')}
                label={TEXT.login}
                value={form.values.login}
                onChange={(value) => form.set('login', value)}
              />
              <AdminTextField
                {...form.field('name')}
                label={TEXT.name}
                value={form.values.name}
                onChange={(value) => form.set('name', value)}
              />
              <AdminTextField
                {...form.field('email')}
                label={TEXT.email}
                type="email"
                inputMode="email"
                value={form.values.email}
                onChange={(value) => form.set('email', value)}
              />
              <PasswordField
                {...form.field('password')}
                label={TEXT.password}
                autoComplete="new-password"
                panel
                value={form.values.password}
                disabled={form.saving}
                onChange={(value) => form.set('password', value)}
              />
            </>
          )}
        </AdminForm>
      </DialogContent>
    </Dialog>
  );
}
