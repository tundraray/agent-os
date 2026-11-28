'use client';

import { useId, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import {
  MCP_SERVER_NAME_MAX_LENGTH,
  McpServerNameSchema,
  type McpServerMode,
  type RegisterMcpServerBody,
} from '@agent-os/contracts';
import { PageHeader } from '@/components/shell/page-header';
import { useShellServices } from '@/components/shell/shell-actions';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { useResource } from '@/hooks/use-resource';
import { adminApi } from '@/lib/admin/admin-api';
import { serverRules } from '@/lib/admin/form-rules';
import { logger } from '@/lib/logger';
import { adminPath, adminRecordPath } from '@/lib/shell-route';
import { cn } from '@/lib/utils';
import {
  AdminForm,
  AdminRadioField,
  CAPTION,
  AdminTextField,
  type AdminRadioOption,
} from '../admin-form';
import { useAdminTitles } from '../admin-header';
import { CopyValue } from '../copy-value';
import { SecretField } from '../secret-field';
import { serverModeLabel } from './server-list';
import type { ServersTranslator } from '@/i18n/catalog';

/** MC-29: the credentials modes, each with what it means under its radio. */
const modes = (
  t: ServersTranslator,
): readonly AdminRadioOption<McpServerMode>[] =>
  (['shared', 'oauth'] as const).map((mode) => ({
    value: mode,
    label: serverModeLabel(t, mode),
    hint: t(`modeHint.${mode}`),
  }));

type RegisterValues = {
  name: string;
  url: string;
  mode: McpServerMode;
  /** Only the shared mode sends it; emptied after the registration (Invariant 3). */
  sharedToken: string | undefined;
  /** A ready OAuth client for a server that does not register clients itself; only the OAuth mode sends it. */
  oauthClientId: string;
  oauthClientSecret: string | undefined;
};

const INITIAL: RegisterValues = {
  name: '',
  url: '',
  mode: 'shared',
  sharedToken: '',
  oauthClientId: '',
  oauthClientSecret: '',
};

/** The return address is read this long after the last change of the name, not on every key. */
const REDIRECT_URI_DELAY_MS = 300;

/**
 * The `POST` body: the token goes only with the shared mode, a ready OAuth client only with the OAuth mode and
 * only when its id is typed, as the contract's two shapes require.
 */
function registerBodyOf({
  name,
  url,
  mode,
  sharedToken,
  oauthClientId,
  oauthClientSecret,
}: RegisterValues): RegisterMcpServerBody {
  if (mode === 'shared')
    return { name, url: url.trim(), mode, sharedToken: sharedToken ?? '' };
  const clientId = oauthClientId.trim();
  if (clientId === '') return { name, url: url.trim(), mode };
  return {
    name,
    url: url.trim(),
    mode,
    oauthClientId: clientId,
    ...(oauthClientSecret ? { oauthClientSecret } : {}),
  };
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
      logger.info('admin: server register: connecting the admin account', {
        server: server.name,
      });
      navigate(adminApi.servers.connectUrl(server.name));
      return;
    }
    router.push(adminRecordPath('servers', server.name));
  };

  return (
    <>
      <PageHeader
        area={titles.panel}
        title={t('registration.title')}
        parent={titles.parent('servers')}
      />
      <AdminForm
        variant="page"
        initialValues={INITIAL}
        validate={({ sharedToken, oauthClientSecret, ...values }) =>
          serverRules({
            ...values,
            sharedToken: sharedToken ?? '',
            oauthClientSecret: oauthClientSecret ?? '',
          })
        }
        onSubmit={register}
        submitLabel={t('registration.submit')}
        savingLabel={({ mode }) =>
          mode === 'shared' ? t('checking') : undefined
        }
        savedText={null}
        onCancel={() => router.push(adminPath('servers'))}
        secretFields={['sharedToken', 'oauthClientSecret']}
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
                // Typed credentials do not outlive their mode: they are not kept in the state of the other one.
                form.set('sharedToken', '');
                form.set('oauthClientId', '');
                form.set('oauthClientSecret', '');
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
            {form.values.mode === 'oauth' && (
              <>
                <OAuthClientFields
                  clientId={
                    <AdminTextField
                      {...form.field('oauthClientId')}
                      label={`${t('oauthClientId')} ${t('optional')}`}
                      mono
                      value={form.values.oauthClientId}
                      onChange={(value) => form.set('oauthClientId', value)}
                    />
                  }
                  clientSecret={
                    <SecretField
                      {...form.field('oauthClientSecret')}
                      label={`${t('oauthClientSecret')} ${t('optional')}`}
                      isSet={false}
                      value={form.values.oauthClientSecret}
                      onChange={(value) =>
                        form.set('oauthClientSecret', value ?? '')
                      }
                    />
                  }
                />
                <RedirectUri name={form.values.name} />
              </>
            )}
          </>
        )}
      </AdminForm>
    </>
  );
}

/**
 * MC-29: the two optional fields of a ready OAuth app under one hint, which says when both are needed — it
 * describes the group, so a screen reader hears it with either field.
 */
function OAuthClientFields({
  clientId,
  clientSecret,
}: {
  clientId: ReactNode;
  clientSecret: ReactNode;
}) {
  const t = useTranslations('admin.servers');
  const hintId = useId();
  return (
    <div role="group" aria-describedby={hintId} className="flex flex-col gap-3">
      <p id={hintId} className={cn(CAPTION, 'text-muted-foreground')}>
        {t('oauthClientHint')}
      </p>
      {clientId}
      {clientSecret}
    </div>
  );
}

/**
 * «Redirect URI — укажите его в приложении» (AC-27.2, AC-35.1): the address the API answers for the typed name,
 * read once the name is valid and has stayed unchanged for a moment; nothing is shown while it is read.
 */
function RedirectUri({ name }: { name: string }) {
  const settled = useDebouncedValue(name, REDIRECT_URI_DELAY_MS);
  if (settled !== name || !McpServerNameSchema.safeParse(name).success)
    return null;
  return <RedirectUriValue name={name} />;
}

function RedirectUriValue({ name }: { name: string }) {
  const t = useTranslations('admin.servers');
  const url = useResource(
    () => adminApi.servers.callbackUrl(name),
    `mcp-callback-url:${name}`,
  );
  if (url.data === undefined) return null;
  return <CopyValue label={t('oauthRedirectUri')} value={url.data.url} />;
}
