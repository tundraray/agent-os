'use client';

import { useRef } from 'react';
import { useRouter } from 'next/navigation';
import { ROLE_NAME_MAX_LENGTH } from '@agent-os/contracts';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { adminApi } from '@/lib/admin/admin-api';
import { roleNameRules } from '@/lib/admin/form-rules';
import { focusShellTarget } from '@/lib/focus';
import { adminRecordPath } from '@/lib/shell-route';
import { AdminForm, AdminTextField } from '../admin-form';

/** UXRD MC-26. */
const TEXT = {
  create: 'Создать роль',
  name: 'Название роли',
} as const;

type RoleNameDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/**
 * UXRD AD-05: «Создать роль» — a dialog form with the role's name. A created role opens its own page
 * (plan Notes 6), so the dialog closes by the navigation and focus goes to the new page's `h1`.
 */
export function RoleNameDialog({ open, onOpenChange }: RoleNameDialogProps) {
  const router = useRouter();
  const createdId = useRef<string | null>(null);

  const submit = async ({ name }: { name: string }): Promise<void> => {
    const role = await adminApi.roles.create({ name });
    createdId.current = role.id;
  };

  const openCreated = (): void => {
    if (createdId.current === null) return;
    onOpenChange(false);
    focusShellTarget('page-title');
    router.push(adminRecordPath('roles', createdId.current));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{TEXT.create}</DialogTitle>
        </DialogHeader>
        <AdminForm
          variant="dialog"
          initialValues={{ name: '' }}
          validate={roleNameRules}
          onSubmit={submit}
          submitLabel={TEXT.create}
          onSaved={openCreated}
          logEvent="admin: role create"
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
