'use client';

import { useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { ROLE_NAME_MAX_LENGTH } from '@agent-os/contracts';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useResource } from '@/hooks/use-resource';
import { adminApi } from '@/lib/admin/admin-api';
import { roleNameRules } from '@/lib/admin/form-rules';
import { builtinRoleName } from '@/i18n/builtin-name';
import { adminRecordPath } from '@/lib/shell-route';
import { AdminForm, AdminSelectField, AdminTextField } from '../admin-form';

/** The «Скопировать из роли» choice that copies nothing. */
const NO_COPY = 'none';

type RoleRef = { id: string; name: string };

type RoleNameDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
} & (
  | {
      role?: undefined;
      onRenamed?: undefined;
      /** «Создать копию» of a role's page: this role is chosen and the name is «{роль} (копия)». */
      copyOf?: RoleRef;
    }
  | {
      /** Rename mode: the role whose name the dialog changes. */
      role: RoleRef;
      /** After the new name is saved; the owner reads the role again. */
      onRenamed: () => void;
      copyOf?: undefined;
    }
);

/**
 * UXRD AD-17 «Новая роль» (with «Скопировать из роли») and AD-06 «Переименовать» — one dialog form. A created role
 * opens its own page on «Инструменты», so the dialog closes by the navigation and focus goes to the new page's `h1`;
 * a renamed role closes the dialog and focus returns to the control that opened it.
 */
export function RoleNameDialog({
  open,
  onOpenChange,
  role,
  onRenamed,
  copyOf,
}: RoleNameDialogProps) {
  const t = useTranslations('admin.roles');
  const router = useRouter();

  const created = (id: string, name: string): void => {
    onOpenChange(false);
    toast.success(t('created', { role: name }));
    router.push(adminRecordPath('roles', id));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {role === undefined ? t('newRole') : t('rename')}
          </DialogTitle>
        </DialogHeader>
        {role === undefined || onRenamed === undefined ? (
          <CreateRoleForm copyOf={copyOf} onCreated={created} />
        ) : (
          <AdminForm
            variant="dialog"
            initialValues={{ name: role.name }}
            validate={roleNameRules}
            onSubmit={async ({ name }) => {
              await adminApi.roles.update(role.id, { name });
            }}
            submitLabel={t('save')}
            onSaved={() => {
              onOpenChange(false);
              onRenamed();
            }}
            logEvent="admin: role rename"
          >
            {(form) => (
              <AdminTextField
                {...form.field('name')}
                label={t('name')}
                value={form.values.name}
                maxLength={ROLE_NAME_MAX_LENGTH}
                onChange={(value) => form.set('name', value)}
              />
            )}
          </AdminForm>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Mounted only while the dialog is open, so the roles to copy from are read only then. */
function CreateRoleForm({
  copyOf,
  onCreated,
}: {
  copyOf: RoleRef | undefined;
  onCreated: (id: string, name: string) => void;
}) {
  const t = useTranslations('admin.roles');
  const locale = useLocale();
  const roles = useResource(adminApi.roles.list, 'roles:copy');
  const createdRef = useRef<RoleRef | null>(null);
  // Every role but «Супер-администратор»: its copy is refused (AC-37.8); the chosen one stands even before the read.
  const samples =
    roles.data?.filter((entry) => entry.builtinKind !== 'super_admin') ??
    (copyOf === undefined ? [] : [copyOf]);
  const options = [
    { value: NO_COPY, label: t('noCopy') },
    ...samples.map((entry) => ({
      value: entry.id,
      label: builtinRoleName(entry.name, locale),
    })),
  ];

  return (
    <AdminForm
      variant="dialog"
      initialValues={{
        name:
          copyOf === undefined
            ? ''
            : t('copyName', { role: builtinRoleName(copyOf.name, locale) }),
        copyFrom: copyOf?.id ?? NO_COPY,
      }}
      validate={roleNameRules}
      onSubmit={async ({ name, copyFrom }) => {
        const createdRole = await adminApi.roles.create(
          copyFrom === NO_COPY ? { name } : { name, copyFrom },
        );
        createdRef.current = createdRole;
      }}
      submitLabel={t('createSubmit')}
      onSaved={() => {
        if (createdRef.current !== null)
          onCreated(createdRef.current.id, createdRef.current.name);
      }}
      logEvent="admin: role create"
    >
      {(form) => (
        <>
          <AdminTextField
            {...form.field('name')}
            label={t('name')}
            value={form.values.name}
            maxLength={ROLE_NAME_MAX_LENGTH}
            onChange={(value) => form.set('name', value)}
          />
          <AdminSelectField
            {...form.field('copyFrom')}
            label={`${t('copyFrom')} ${t('optional')}`}
            value={form.values.copyFrom}
            options={options}
            onChange={(value) => form.set('copyFrom', value)}
            hint={t('copyHint')}
          />
        </>
      )}
    </AdminForm>
  );
}
