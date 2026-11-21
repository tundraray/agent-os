'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { MCP_SERVER_NAME_MAX_LENGTH, type McpServerMode, type RegisterMcpServerBody } from '@agent-os/contracts';
import { PageHeader } from '@/components/shell/page-header';
import { useShellServices } from '@/components/shell/shell-actions';
import { adminApi } from '@/lib/admin/admin-api';
import { serverRules } from '@/lib/admin/form-rules';
import { logger } from '@/lib/logger';
import { adminPath, adminRecordPath } from '@/lib/shell-route';
import { AdminForm, AdminRadioField, AdminTextField, type AdminRadioOption } from '../admin-form';
import { useAdminTitles } from '../admin-header';
import { SecretField } from '../secret-field';
import { serverModeLabel, type ServersTranslator } from './server-list';

/** MC-29: the credentials modes, each with what it means under its radio. */
const modes = (t: ServersTranslator): readonly AdminRadioOption<McpServerMode>[] =>
  (['shared', 'oauth'] as const).map((mode) => ({ value: mode, label: serverModeLabel(t, mode), hint: t(`modeHint.${mode}`) }));

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
  const titles = useAdminTitles();
  const t = useTranslations('admin.servers');
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
      <PageHeader area={titles.panel} title={t('registration.title')} parent={titles.parent('servers')} />
      <AdminForm
        variant="page"
        initialValues={INITIAL}
        validate={({ sharedToken, ...values }) => serverRules({ ...values, sharedToken: sharedToken ?? '' })}
        onSubmit={register}
        submitLabel={t('registration.submit')}
        savingLabel={({ mode }) => (mode === 'shared' ? t('checking') : undefined)}
        savedText={null}
        onCancel={() => router.push(adminPath('servers'))}
        secretFields={['sharedToken']}
        errorContext={{ checkFailed: 'register' }}
        logEvent="admin: server register"
      >
        {(form) => (
          <>
            <AdminTextField
              {...form.field('name')}
              label={t('registration.name')}
              hint={t('registration.nameHint')}
              mono
              maxLength={MCP_SERVER_NAME_MAX_LENGTH}
              value={form.values.name}
              onChange={(value) => form.set('name', value)}
            />
            <AdminTextField
              {...form.field('url')}
              label={t('registration.url')}
              mono
              type="url"
              inputMode="url"
              value={form.values.url}
              onChange={(value) => form.set('url', value)}
            />
            <AdminRadioField
              label={t('credentials')}
              value={form.values.mode}
              options={modes(t)}
              onChange={(mode) => {
                form.set('mode', mode);
                // A typed token does not outlive its mode: it is not kept in the state of an OAuth registration.
                form.set('sharedToken', '');
              }}
            />
            {form.values.mode === 'shared' && (
              <SecretField
                {...form.field('sharedToken')}
                label={t('sharedToken')}
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
