'use client';

import { useLocale, useTranslations } from 'next-intl';
import type { CreateGrantBody, Grant, GrantEffect } from '@agent-os/contracts';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldError, FieldLabel } from '@/components/ui/field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useResource } from '@/hooks/use-resource';
import { adminApi } from '@/lib/admin/admin-api';
import {
  grantRules,
  quotaUsdOf,
  type GrantValues,
} from '@/lib/admin/form-rules';
import {
  modelOptions,
  modelUnavailableReason,
} from '@/lib/admin/model-providers';
import { cn } from '@/lib/utils';
import {
  AdminForm,
  AdminTextField,
  CAPTION,
  CONTROL_SIZE,
} from '../admin-form';

export type GrantHolderRef =
  { kind: 'role'; id: string } | { kind: 'user'; id: string };

/** DC-12: the models the holder already has with this effect; the dialog offers them as «уже есть» (MC-20). */
function heldModels(
  grants: readonly Grant[],
  effect: GrantEffect,
): ReadonlySet<string> {
  return new Set(
    grants
      .filter((grant) => grant.effect === effect)
      .map((grant) => grant.target.model),
  );
}

/** The body exactly as `CreateGrantBody` takes it: one holder, and `quotaUsd` only on an allow with a quota. */
function grantBody(
  holder: GrantHolderRef,
  effect: GrantEffect,
  values: GrantValues,
): CreateGrantBody {
  const holderId =
    holder.kind === 'role' ? { roleId: holder.id } : { userId: holder.id };
  const quotaUsd = values.quota === null ? null : quotaUsdOf(values.quota);
  return {
    ...holderId,
    effect,
    target: { kind: 'model', model: values.model },
    ...(quotaUsd === null ? {} : { quotaUsd }),
  };
}

type GrantDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  holder: GrantHolderRef;
  /** `deny` only for an employee (MC-25 «Запретить модель»). */
  effect: GrantEffect;
  /** The holder's grants: models already held with `effect` are offered as «уже есть». */
  grants: readonly Grant[];
  /** After the grant is created: the owner reads the grants again and closes the dialog. */
  onSaved: () => void;
};

/** UXRD GR-01: one dialog for a role's grant, a personal grant and a personal deny. */
export function GrantDialog({
  open,
  onOpenChange,
  effect,
  ...form
}: GrantDialogProps) {
  const t = useTranslations('admin.grants');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {effect === 'allow' ? t('addAllow') : t('addDeny')}
          </DialogTitle>
        </DialogHeader>
        <GrantForm effect={effect} {...form} />
      </DialogContent>
    </Dialog>
  );
}

/** Mounted with the dialog's content, so the catalogue is read on every opening (read-on-open). */
function GrantForm({
  holder,
  effect,
  grants,
  onSaved,
}: Omit<GrantDialogProps, 'open' | 'onOpenChange'>) {
  const t = useTranslations('admin.grants');
  const locale = useLocale();
  const models = useResource(adminApi.models.list, 'models');
  const providers = useResource(
    adminApi.modelProviders.list,
    'model-providers',
  );
  const held = heldModels(grants, effect);
  // UXRD MP-08: only chat models whose provider works; until the providers are read, none.
  const modelChoices = modelOptions({
    models: models.data ?? [],
    purpose: 'chat',
    readinessOf: (modelId) =>
      modelUnavailableReason(modelId, providers.data ?? []),
    locale,
  }).filter((option) => option.unavailableReason === null);
  const initialValues: GrantValues = {
    model: '',
    quota: effect === 'allow' ? '' : null,
  };

  return (
    <AdminForm
      variant="dialog"
      initialValues={initialValues}
      validate={grantRules}
      onSubmit={async (values) => {
        await adminApi.grants.create(grantBody(holder, effect, values));
      }}
      submitLabel={effect === 'allow' ? t('dialog.allow') : t('dialog.deny')}
      onSaved={onSaved}
      errorContext={{ grantEffect: effect }}
      logEvent="admin: grant create"
    >
      {(form) => (
        <>
          <SelectField
            {...form.field('model')}
            label={t('dialog.model')}
            value={form.values.model}
            onChange={(model) => form.set('model', model)}
            options={modelChoices.map((option) => ({
              value: option.value,
              label: option.label,
              held: held.has(option.value),
            }))}
          />
          {form.values.quota !== null && (
            <AdminTextField
              {...form.field('quota')}
              label={t('quota.label')}
              hint={t('quota.hint')}
              inputMode="decimal"
              value={form.values.quota}
              onChange={(quota) => form.set('quota', quota)}
            />
          )}
        </>
      )}
    </AdminForm>
  );
}

type SelectOption = {
  value: string;
  label: string;
  /** Cannot be chosen: the holder already has it («уже есть»). */
  held: boolean;
};

type SelectFieldProps = {
  id: string;
  label: string;
  error: string | undefined;
  value: string;
  onChange: (value: string) => void;
  options: readonly SelectOption[];
};

/** A drop-down field of the form (settings-form, shadcn `select`): label, 28 px trigger, field error. */
function SelectField({
  id,
  label,
  error,
  value,
  onChange,
  options,
}: SelectFieldProps) {
  const t = useTranslations('admin.grants');
  const errorId = `${id}-error`;
  return (
    <Field data-invalid={error !== undefined} className="gap-1.5">
      <FieldLabel
        htmlFor={id}
        className="text-data font-medium text-foreground"
      >
        {label}
      </FieldLabel>
      <Select
        value={value === '' ? null : value}
        onValueChange={(next) => onChange(next ?? '')}
        items={options.map((option) => ({
          value: option.value,
          label: option.label,
        }))}
      >
        <SelectTrigger
          id={id}
          size="sm"
          className={cn(CONTROL_SIZE, 'w-full', 'text-data')}
          aria-invalid={error !== undefined}
          aria-describedby={error !== undefined ? errorId : undefined}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem
              key={option.value}
              value={option.value}
              disabled={option.held}
              className="pointer-coarse:min-h-11"
            >
              <span className="text-data">{option.label}</span>
              {option.held && (
                <span className={cn(CAPTION, 'text-muted-foreground')}>
                  {t('dialog.held')}
                </span>
              )}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <FieldError id={errorId} className={CAPTION}>
        {error}
      </FieldError>
    </Field>
  );
}
