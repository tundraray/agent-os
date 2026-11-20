'use client';

import { useRouter } from 'next/navigation';
import { MCP_SERVER_NAME_MAX_LENGTH, type McpServerMode, type RegisterMcpServerBody } from '@agent-os/contracts';
import { PageHeader } from '@/components/shell/page-header';
import { useShellServices } from '@/components/shell/shell-actions';
import { adminApi } from '@/lib/admin/admin-api';
import { registerFailed } from '@/lib/admin/admin-texts';
import { serverRules } from '@/lib/admin/form-rules';
import { logger } from '@/lib/logger';
import { adminPath, adminRecordPath } from '@/lib/shell-route';
import { AdminForm, AdminRadioField, AdminTextField, FORM_TEXT, type AdminRadioOption } from '../admin-form';
import { PANEL_TITLE, sectionParent } from '../admin-header';
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

/** MC-29: the credentials modes, each with what it means under its radio. */
const MODES: readonly AdminRadioOption<McpServerMode>[] = [
  { value: 'shared', label: SERVER_MODE_LABEL.shared, hint: 'Один токен на всех: все вызовы идут с ним.' },
  {
    value: 'oauth',
    label: SERVER_MODE_LABEL.oauth,
    hint: 'Каждый сотрудник подключает свой аккаунт. Чтобы получить список инструментов, подключите свой.',
  },
];

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
      <PageHeader area={PANEL_TITLE} title={TEXT.title} parent={sectionParent('servers')} />
      <AdminForm
        variant="page"
        initialValues={INITIAL}
        validate={({ sharedToken, ...values }) => serverRules({ ...values, sharedToken: sharedToken ?? '' })}
        onSubmit={register}
        submitLabel={TEXT.register}
        savingLabel={({ mode }) => (mode === 'shared' ? TEXT.checking : FORM_TEXT.saving)}
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
            <AdminRadioField
              label={SERVER_TEXT.credentials}
              value={form.values.mode}
              options={MODES}
              onChange={(mode) => {
                form.set('mode', mode);
                // A typed token does not outlive its mode: it is not kept in the state of an OAuth registration.
                form.set('sharedToken', '');
              }}
            />
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
