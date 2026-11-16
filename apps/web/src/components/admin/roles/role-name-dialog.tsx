'use client';

import { useRef } from 'react';
import { useRouter } from 'next/navigation';
import { ROLE_NAME_MAX_LENGTH } from '@agent-os/contracts';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { adminApi } from '@/lib/admin/admin-api';
import { roleNameRules } from '@/lib/admin/form-rules';
import { adminRecordPath } from '@/lib/shell-route';
import { AdminForm, AdminTextField } from '../admin-form';

/** UXRD MC-26; «Сохранить» — MC-20. */
const TEXT = {
  create: 'Создать роль',
  rename: 'Переименовать',
  save: 'Сохранить',
  name: 'Название роли',
} as const;

type RoleNameDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
} & (
  | { role?: undefined; onRenamed?: undefined }
  | {
      /** Rename mode: the role whose name the dialog changes. */
      role: { id: string; name: string };
      /** After the new name is saved; the owner reads the role again. */
      onRenamed: () => void;
    }
);

/**
 * UXRD AD-05 «Создать роль» and AD-06 «Переименовать» — one dialog form with the role's name. A created role
 * opens its own page (plan Notes 6), so the dialog closes by the navigation and focus goes to the new page's
 * `h1`; a renamed role closes the dialog and focus returns to the control that opened it.
 */
export function RoleNameDialog({ open, onOpenChange, role, onRenamed }: RoleNameDialogProps) {
  const router = useRouter();
  const createdId = useRef<string | null>(null);

  const submit = async ({ name }: { name: string }): Promise<void> => {
    if (role !== undefined) {
      await adminApi.roles.update(role.id, { name });
      return;
    }
    const created = await adminApi.roles.create({ name });
    createdId.current = created.id;
  };

  const saved = (): void => {
    if (onRenamed !== undefined) {
      onOpenChange(false);
      onRenamed();
      return;
    }
    if (createdId.current === null) return;
    onOpenChange(false);
    router.push(adminRecordPath('roles', createdId.current));
  };

  const title = role === undefined ? TEXT.create : TEXT.rename;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <AdminForm
          variant="dialog"
          initialValues={{ name: role?.name ?? '' }}
          validate={roleNameRules}
          onSubmit={submit}
          submitLabel={role === undefined ? TEXT.create : TEXT.save}
          onSaved={saved}
          logEvent={role === undefined ? 'admin: role create' : 'admin: role rename'}
        >
          {(form) => (
            <AdminTextField
              {...form.field('name')}
              label={TEXT.name}
              value={form.values.name}
              maxLength={ROLE_NAME_MAX_LENGTH}
              onChange={(value) => form.set('name', value)}
            />
          )}
        </AdminForm>
      </DialogContent>
    </Dialog>
  );
}
