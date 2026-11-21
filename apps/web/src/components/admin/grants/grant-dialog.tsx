'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import type { CreateGrantBody, Grant, GrantEffect, GrantTargetBody, McpServerSummary } from '@agent-os/contracts';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, FieldError, FieldLabel } from '@/components/ui/field';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useResource } from '@/hooks/use-resource';
import { adminApi } from '@/lib/admin/admin-api';
import { grantRules, quotaUsdOf, type GrantValues } from '@/lib/admin/form-rules';
import { modelOptions, modelUnavailableReason } from '@/lib/admin/model-providers';
import { cn } from '@/lib/utils';
import {
  AdminForm,
  AdminRadioField,
  AdminTextField,
  CAPTION,
  CONTROL_SIZE,
  type AdminFormApi,
  type AdminRadioOption,
} from '../admin-form';

export type GrantHolderRef = { kind: 'role'; id: string } | { kind: 'user'; id: string };

const KINDS: readonly GrantValues['kind'][] = ['server', 'tool', 'model'];

/** UXRD MC-25: the choice «Что». */
const KIND_LABEL = {
  server: 'dialog.kindServer',
  tool: 'dialog.kindTool',
  model: 'dialog.model',
} as const satisfies Record<GrantValues['kind'], string>;

/** One key per target, so a grant and a dialog choice compare as text. */
function targetKey(target: GrantTargetBody): string {
  switch (target.kind) {
    case 'server':
      return `server:${target.server}`;
    case 'tool':
      return `tool:${target.server}/${target.tool}`;
    case 'model':
      return `model:${target.model}`;
  }
}

/** DC-12: the targets the holder already has with this effect; the dialog offers them as «уже есть» (MC-20). */
function heldTargets(grants: readonly Grant[], effect: GrantEffect): ReadonlySet<string> {
  return new Set(grants.filter((grant) => grant.effect === effect).map((grant) => targetKey(grant.target)));
}

function targetOf({ kind, server, tool, model }: GrantValues): GrantTargetBody {
  switch (kind) {
    case 'server':
      return { kind, server };
    case 'tool':
      return { kind, server, tool };
    case 'model':
      return { kind, model };
  }
}

/** The body exactly as `CreateGrantBody` takes it: one holder, and `quotaUsd` only on a model allow with a quota. */
function grantBody(holder: GrantHolderRef, effect: GrantEffect, values: GrantValues): CreateGrantBody {
  const holderId = holder.kind === 'role' ? { roleId: holder.id } : { userId: holder.id };
  const quotaUsd = values.kind === 'model' && values.quota !== null ? quotaUsdOf(values.quota) : null;
  return { ...holderId, effect, target: targetOf(values), ...(quotaUsd === null ? {} : { quotaUsd }) };
}

type GrantDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  holder: GrantHolderRef;
  /** `deny` only for an employee (MC-25 «Добавить запрет»). */
  effect: GrantEffect;
  /** The holder's grants: targets already held with `effect` are offered as «уже есть». */
  grants: readonly Grant[];
  servers: readonly McpServerSummary[];
  /** After the grant is created: the owner reads the grants again and closes the dialog. */
  onSaved: () => void;
};

/** UXRD GR-01: one dialog for a role's grant, a personal grant and a personal deny. */
export function GrantDialog({ open, onOpenChange, effect, ...form }: GrantDialogProps) {
  const t = useTranslations('admin.grants');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{effect === 'allow' ? t('addAllow') : t('addDeny')}</DialogTitle>
        </DialogHeader>
        <GrantForm effect={effect} {...form} />
      </DialogContent>
    </Dialog>
  );
}

/** Mounted with the dialog's content, so the catalogue is read on every opening (read-on-open). */
function GrantForm({ holder, effect, grants, servers, onSaved }: Omit<GrantDialogProps, 'open' | 'onOpenChange'>) {
  const t = useTranslations('admin.grants');
  const models = useResource(adminApi.models.list, 'models');
  const providers = useResource(adminApi.modelProviders.list, 'model-providers');
  const held = heldTargets(grants, effect);
  // UXRD MP-08: only chat models whose provider works; until the providers are read, none.
  const modelChoices = modelOptions(models.data ?? [], 'chat', (modelId) =>
    modelUnavailableReason(modelId, providers.data ?? []),
  ).filter((option) => option.unavailableReason === null);
  const kinds: readonly AdminRadioOption<GrantValues['kind']>[] = KINDS.map((kind) => ({
    value: kind,
    label: t(KIND_LABEL[kind]),
  }));
  const initialValues: GrantValues = {
    kind: 'server',
    server: '',
    tool: '',
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
      submitLabel={t('dialog.submit')}
      onSaved={onSaved}
      errorContext={{ grantEffect: effect }}
      logEvent="admin: grant create"
    >
      {(form) => (
        <>
          <AdminRadioField
            label={t('dialog.what')}
            value={form.values.kind}
            options={kinds}
            onChange={(kind) => form.set('kind', kind)}
          />
          {form.values.kind !== 'model' && <ServerField form={form} servers={servers} held={held} />}
          {form.values.kind === 'tool' && form.values.server !== '' && <ToolField form={form} held={held} />}
          {form.values.kind === 'model' && (
            <SelectField
              {...form.field('model')}
              label={t('dialog.model')}
              value={form.values.model}
              onChange={(model) => form.set('model', model)}
              options={modelChoices.map((option) => ({
                value: option.value,
                label: option.label,
                held: held.has(targetKey({ kind: 'model', model: option.value })),
              }))}
            />
          )}
          {form.values.kind === 'model' && form.values.quota !== null && (
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

type FormProps = { form: AdminFormApi<GrantValues> };

/** DC-12: a server without tools (always so while it awaits the admin's account) cannot be chosen. */
function ServerField({ form, servers, held }: FormProps & { servers: readonly McpServerSummary[]; held: ReadonlySet<string> }) {
  const t = useTranslations('admin.grants');
  const wholeServer = form.values.kind === 'server';
  return (
    <SelectField
      {...form.field('server')}
      label={t('dialog.server')}
      mono
      value={form.values.server}
      onChange={(server) => {
        form.set('server', server);
        form.set('tool', '');
      }}
      options={servers.map((server) => ({
        value: server.name,
        label: server.name,
        unavailable: server.toolCount === 0,
        held: wholeServer && held.has(targetKey({ kind: 'server', server: server.name })),
      }))}
    />
  );
}

/** AC-28.2: a tool only from the server's record, never typed by hand. */
function ToolField({ form, held }: FormProps & { held: ReadonlySet<string> }) {
  const t = useTranslations('admin.grants');
  const { server } = form.values;
  const record = useResource(() => adminApi.servers.get(server), `server:${server}`);
  return (
    <SelectField
      {...form.field('tool')}
      label={t('dialog.tool')}
      mono
      value={form.values.tool}
      onChange={(tool) => form.set('tool', tool)}
      options={(record.data?.tools ?? []).map((tool) => ({
        value: tool.name,
        label: tool.name,
        note: tool.readOnly ? t('dialog.readOnly') : t('dialog.changes'),
        held: held.has(targetKey({ kind: 'tool', server, tool: tool.name })),
      }))}
    />
  );
}

type SelectOption = {
  value: string;
  label: string;
  /** A muted word after the label, e.g. «читает». */
  note?: string;
  /** Cannot be chosen, without a caption. */
  unavailable?: boolean;
  /** Cannot be chosen: the holder already has it («уже есть»). */
  held?: boolean;
};

type SelectFieldProps = {
  id: string;
  label: string;
  error: string | undefined;
  value: string;
  onChange: (value: string) => void;
  options: readonly SelectOption[];
  /** Mono 13 / 20 for technical names: servers and tools. */
  mono?: boolean;
};

/** A drop-down field of the form (settings-form, shadcn `select`): label, 28 px trigger, field error. */
function SelectField({ id, label, error, value, onChange, options, mono = false }: SelectFieldProps) {
  const t = useTranslations('admin.grants');
  const errorId = `${id}-error`;
  const textClass = mono ? 'font-mono text-mono-compact' : 'text-data';
  return (
    <Field data-invalid={error !== undefined} className="gap-1.5">
      <FieldLabel htmlFor={id} className="text-data font-medium text-foreground">
        {label}
      </FieldLabel>
      <Select
        value={value === '' ? null : value}
        onValueChange={(next) => onChange(next ?? '')}
        items={options.map((option) => ({ value: option.value, label: option.label }))}
      >
        <SelectTrigger
          id={id}
          size="sm"
          className={cn(CONTROL_SIZE, 'w-full', textClass)}
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
              disabled={option.unavailable === true || option.held === true}
              className="pointer-coarse:min-h-11"
            >
              <span className={textClass}>{option.label}</span>
              {option.note !== undefined && <OptionCaption>{option.note}</OptionCaption>}
              {option.held === true && <OptionCaption>{t('dialog.held')}</OptionCaption>}
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

function OptionCaption({ children }: { children: ReactNode }) {
  return <span className={cn(CAPTION, 'text-muted-foreground')}>{children}</span>;
}
