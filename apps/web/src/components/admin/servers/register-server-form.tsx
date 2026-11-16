'use client';

import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  MCP_SERVER_NAME_MAX_LENGTH,
  McpServerModeSchema,
  type McpServerMode,
  type RegisterMcpServerBody,
} from '@agent-os/contracts';
import { useShellServices } from '@/components/shell/shell-actions';
import { FieldDescription, FieldLegend, FieldSet } from '@/components/ui/field';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { adminApi } from '@/lib/admin/admin-api';
import { registerFailed } from '@/lib/admin/admin-texts';
import { serverRules } from '@/lib/admin/form-rules';
import { logger } from '@/lib/logger';
import { adminPath, adminRecordPath } from '@/lib/shell-route';
import { cn } from '@/lib/utils';
import { AdminForm, AdminTextField, CAPTION, type AdminFormApi } from '../admin-form';
import { AdminPageHeader } from '../admin-header';
import { SecretField } from '../secret-field';
import { SERVER_MODE_LABEL, SERVER_TEXT } from './server-list';

/** UXRD MC-29; the title is the UXRD's name of the screen (AD-09). */
const TEXT = {
  title: 'Регистрация',
  name: 'Имя',
  nameHint: 'По этому имени сервер указывают в определениях агентов. После регистрации имя не меняется.',
  url: 'Адрес',
  sharedToken: 'Токен доступа',
  register: 'Зарегистрировать',
  checking: 'Проверяем сервер…',
} as const;

/** MC-29: what each credentials mode means, under its radio. */
const MODE_HINT: Readonly<Record<McpServerMode, string>> = {
  shared: 'Один токен на всех: все вызовы идут с ним.',
  oauth: 'Каждый сотрудник подключает свой аккаунт. Чтобы получить список инструментов, подключите свой.',
};

const MODES: readonly McpServerMode[] = ['shared', 'oauth'];

type RegisterValues = {
  name: string;
  url: string;
  mode: McpServerMode;
  /** Only the shared mode sends it; emptied after the registration (Invariant 3). */
  sharedToken: string | undefined;
};

const INITIAL: RegisterValues = { name: '', url: '', mode: 'shared', sharedToken: '' };

/** The `POST` body: the token goes only with the shared mode, as the contract's two shapes require. */
function registerBodyOf({ name, url, mode, sharedToken }: RegisterValues): RegisterMcpServerBody {
  return mode === 'shared'
    ? { name, url: url.trim(), mode, sharedToken: sharedToken ?? '' }
    : { name, url: url.trim(), mode };
}

/**
 * UXRD AD-09: registers a server. A shared-account server opens its page; a personal-OAuth server is saved
 * waiting for the administrator's account, so the tab goes straight to the connection (Flow 2) — a page
 * navigation, because the connect route answers with a redirect to the authorization server.
 */
export function RegisterServerForm() {
  const router = useRouter();
  const { navigate } = useShellServices();
  // Mirrors the form's mode: the submit label is a prop of the form, chosen before its fields render.
  const [mode, setMode] = useState<McpServerMode>(INITIAL.mode);

  const register = async (values: RegisterValues): Promise<void> => {
    const server = await adminApi.servers.register(registerBodyOf(values));
    if (server.status === 'awaiting_admin_account') {
      logger.info('admin: server register: connecting the admin account', { server: server.name });
      navigate(adminApi.servers.connectUrl(server.name));
      return;
    }
    router.push(adminRecordPath('servers', server.name));
  };

  return (
    <>
      <AdminPageHeader title={TEXT.title} parent="servers" />
      <AdminForm
        variant="page"
        initialValues={INITIAL}
        validate={({ sharedToken, ...values }) => serverRules({ ...values, sharedToken: sharedToken ?? '' })}
        onSubmit={register}
        submitLabel={TEXT.register}
        savingLabel={mode === 'shared' ? TEXT.checking : undefined}
        savedText={null}
        onCancel={() => router.push(adminPath('servers'))}
        secretFields={['sharedToken']}
        errorContext={{ checkFailed: registerFailed }}
        logEvent="admin: server register"
      >
        {(form) => (
          <>
            <AdminTextField
              {...form.field('name')}
              label={TEXT.name}
              hint={TEXT.nameHint}
              mono
              maxLength={MCP_SERVER_NAME_MAX_LENGTH}
              value={form.values.name}
              onChange={(value) => form.set('name', value)}
            />
            <AdminTextField
              {...form.field('url')}
              label={TEXT.url}
              mono
              type="url"
              inputMode="url"
              value={form.values.url}
              onChange={(value) => form.set('url', value)}
            />
            <ModeField form={form} onModeChange={setMode} />
            {form.values.mode === 'shared' && (
              <SecretField
                {...form.field('sharedToken')}
                label={TEXT.sharedToken}
                isSet={false}
                value={form.values.sharedToken}
                onChange={(value) => form.set('sharedToken', value ?? '')}
              />
            )}
          </>
        )}
      </AdminForm>
    </>
  );
}

function ModeField({
  form,
  onModeChange,
}: {
  form: AdminFormApi<RegisterValues>;
  onModeChange: (mode: McpServerMode) => void;
}) {
  const legendId = useId();
  const hintId = useId();

  const choose = (value: unknown): void => {
    const mode = McpServerModeSchema.safeParse(value);
    if (!mode.success) return;
    form.set('mode', mode.data);
    onModeChange(mode.data);
  };

  return (
    <FieldSet className="gap-1.5">
      <FieldLegend id={legendId} variant="label" className="mb-0 text-data font-medium text-foreground">
        {SERVER_TEXT.credentials}
      </FieldLegend>
      <RadioGroup aria-labelledby={legendId} value={form.values.mode} onValueChange={choose} className="gap-2">
        {MODES.map((mode) => (
          <div key={mode} className="flex flex-col gap-0.5">
            <Label className="flex w-fit items-center gap-2 text-data font-normal text-foreground pointer-coarse:min-h-11">
              <RadioGroupItem value={mode} aria-describedby={`${hintId}-${mode}`} />
              {SERVER_MODE_LABEL[mode]}
            </Label>
            <FieldDescription id={`${hintId}-${mode}`} className={cn(CAPTION, 'pl-6 text-muted-foreground')}>
              {MODE_HINT[mode]}
            </FieldDescription>
          </div>
        ))}
      </RadioGroup>
    </FieldSet>
  );
}
