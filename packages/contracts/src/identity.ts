import { z } from 'zod';

/** Page size of GET /api/admin/users (design-identity, Runtime settings). */
export const ADMIN_USER_PAGE_SIZE = 50;
/** Max length of a role name after trimming. */
export const ROLE_NAME_MAX_LENGTH = 80;
/** Max length of a sign-in provider name (the button label). */
export const PROVIDER_NAME_MAX_LENGTH = 60;

/** Error codes of the identity part (`errorCode` of ApiErrorSchema). */
export const IdentityErrorCode = {
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  ACCOUNT_DISABLED: 'ACCOUNT_DISABLED',
  ADMIN_REQUIRED: 'ADMIN_REQUIRED',
  ORIGIN_REJECTED: 'ORIGIN_REJECTED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  LOGIN_TAKEN: 'LOGIN_TAKEN',
  EMAIL_TAKEN: 'EMAIL_TAKEN',
  USER_NOT_FOUND: 'USER_NOT_FOUND',
  NOT_LOCAL_ACCOUNT: 'NOT_LOCAL_ACCOUNT',
  ROLE_NOT_FOUND: 'ROLE_NOT_FOUND',
  ROLE_NAME_TAKEN: 'ROLE_NAME_TAKEN',
  BUILTIN_ROLE: 'BUILTIN_ROLE',
  PROVIDER_NOT_FOUND: 'PROVIDER_NOT_FOUND',
  PROVIDER_INCOMPLETE: 'PROVIDER_INCOMPLETE',
  PROVIDER_CHECK_FAILED: 'PROVIDER_CHECK_FAILED',
  PUBLIC_URL_REQUIRED: 'PUBLIC_URL_REQUIRED',
} as const;
export type IdentityErrorCode =
  (typeof IdentityErrorCode)[keyof typeof IdentityErrorCode];

/** `reason` of a 400 VALIDATION_FAILED answered by the identity service. */
export const IdentityValidationReason = {
  WRONG_CURRENT_PASSWORD: 'wrong_current_password',
  WEAK_PASSWORD: 'weak_password',
  NOT_LOCAL_ACCOUNT: 'not_local_account',
  UNKNOWN_TYPE: 'unknown_type',
  INVALID_CURSOR: 'invalid_cursor',
} as const;
export type IdentityValidationReason =
  (typeof IdentityValidationReason)[keyof typeof IdentityValidationReason];

/** `reason` of a 422 PROVIDER_CHECK_FAILED. */
export const ProviderCheckFailure = {
  INSECURE_URL: 'insecure_url',
  UNREACHABLE: 'unreachable',
  INVALID_DOCUMENT: 'invalid_document',
} as const;
export type ProviderCheckFailure =
  (typeof ProviderCheckFailure)[keyof typeof ProviderCheckFailure];

/** `error` query parameter of the /login redirect after a failed provider sign-in (uxrd MC-3). */
export const SignInErrorSchema = z.enum([
  'cancelled',
  'failed',
  'no_email',
  'account_disabled',
  'provider_unavailable',
]);
export type SignInError = z.infer<typeof SignInErrorSchema>;

const IdSchema = z.uuid();
/** Any non-empty password: length rules are the service's `weak_password`, so the reason reaches the client. */
const PasswordSchema = z.string().min(1);
const RoleNameSchema = z.string().trim().min(1).max(ROLE_NAME_MAX_LENGTH);
const ProviderNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(PROVIDER_NAME_MAX_LENGTH);
const CursorSchema = z.string().min(1).max(512);

// ---------- Sign-in and session (web) ----------

/** The interface languages an employee can choose (i18n design-web.md, KD-4). */
export const LanguageSchema = z.enum(['en', 'ru']);
export type Language = z.infer<typeof LanguageSchema>;

/** The cookie the API writes with the employee's language and the Next server reads (i18n design-web.md, KD-2). */
export const LOCALE_COOKIE = 'aos_locale';

/**
 * Response of GET /api/auth/me. `name` is an empty string when there is no name; `language` is null
 * while the employee has not chosen one.
 */
export const CurrentUserSchema = z.object({
  id: IdSchema,
  email: z.string(),
  name: z.string(),
  isAdmin: z.boolean(),
  hasPassword: z.boolean(),
  language: LanguageSchema.nullable(),
});
export type CurrentUser = z.infer<typeof CurrentUserSchema>;

/** Body of PUT /api/auth/me/language. */
export const LanguageBodySchema = z.object({ language: LanguageSchema });
export type LanguageBody = z.infer<typeof LanguageBodySchema>;

/** Body of POST /api/auth/password. */
export const PasswordSignInBodySchema = z.object({
  login: z.string().min(1),
  password: PasswordSchema,
});
export type PasswordSignInBody = z.infer<typeof PasswordSignInBodySchema>;

/** Body of POST /api/auth/password/change. */
export const PasswordChangeBodySchema = z.object({
  currentPassword: PasswordSchema,
  newPassword: PasswordSchema,
});
export type PasswordChangeBody = z.infer<typeof PasswordChangeBodySchema>;

export const ProviderTypeSchema = z.enum(['google', 'oidc']);
export type ProviderType = z.infer<typeof ProviderTypeSchema>;

/** One enabled provider on the sign-in page (GET /api/auth/providers, creation order). */
export const ProviderButtonSchema = z.object({
  id: IdSchema,
  name: z.string(),
  type: ProviderTypeSchema,
});
export type ProviderButton = z.infer<typeof ProviderButtonSchema>;

export const ProviderButtonListSchema = z.array(ProviderButtonSchema);
export type ProviderButtonList = z.infer<typeof ProviderButtonListSchema>;

// ---------- Admin: users ----------

export const UserStatusSchema = z.enum(['active', 'disabled']);
export type UserStatus = z.infer<typeof UserStatusSchema>;

const RoleRefSchema = z.object({ id: IdSchema, name: z.string() });

export const AdminUserSummarySchema = z.object({
  id: IdSchema,
  email: z.string(),
  name: z.string(),
  /** Login of a local account, `null` for provider-only accounts. */
  login: z.string().nullable(),
  status: UserStatusSchema,
  lastSignInAt: z.iso.datetime().nullable(),
  roles: z.array(RoleRefSchema),
});
export type AdminUserSummary = z.infer<typeof AdminUserSummarySchema>;

/** Query of GET /api/admin/users. `cursor` is opaque: pass `nextCursor` of the previous page as is. */
export const AdminUserListQuerySchema = z.object({
  query: z.string().optional(),
  cursor: CursorSchema.optional(),
});
export type AdminUserListQuery = z.infer<typeof AdminUserListQuerySchema>;

export const AdminUserPageSchema = z.object({
  users: z.array(AdminUserSummarySchema).max(ADMIN_USER_PAGE_SIZE),
  nextCursor: z.string().min(1).nullable(),
});
export type AdminUserPage = z.infer<typeof AdminUserPageSchema>;

/** Response of GET /api/admin/users/:id: where the admin right comes from. */
export const AdminUserDetailSchema = AdminUserSummarySchema.extend({
  adminRight: z.object({
    personal: z.boolean(),
    roles: z.array(RoleRefSchema),
  }),
});
export type AdminUserDetail = z.infer<typeof AdminUserDetailSchema>;

/** Body of POST /api/admin/users: a local account without roles (FR-33). */
export const CreateLocalUserBodySchema = z.object({
  login: z.string().trim().min(1),
  name: z.string().trim(),
  email: z.email(),
  password: PasswordSchema,
});
export type CreateLocalUserBody = z.infer<typeof CreateLocalUserBodySchema>;

/** Body of PUT /api/admin/users/:id/password. */
export const ResetPasswordBodySchema = z.object({ password: PasswordSchema });
export type ResetPasswordBody = z.infer<typeof ResetPasswordBodySchema>;

/** Body of PUT /api/admin/users/:id/admin. */
export const SetPersonalAdminBodySchema = z.object({ enabled: z.boolean() });
export type SetPersonalAdminBody = z.infer<typeof SetPersonalAdminBodySchema>;

// ---------- Admin: roles ----------

export const RoleSummarySchema = z.object({
  id: IdSchema,
  name: z.string(),
  memberCount: z.number().int().nonnegative(),
  isAdmin: z.boolean(),
  builtin: z.boolean(),
});
export type RoleSummary = z.infer<typeof RoleSummarySchema>;

/** Response of GET /api/admin/roles: roles ordered by name. */
export const RoleListSchema = z.array(RoleSummarySchema);
export type RoleList = z.infer<typeof RoleListSchema>;

/** Response of GET /api/admin/roles/:id. */
export const RoleDetailSchema = RoleSummarySchema.extend({
  members: z.array(
    z.object({ id: IdSchema, name: z.string(), email: z.string() }),
  ),
});
export type RoleDetail = z.infer<typeof RoleDetailSchema>;

/** Body of POST /api/admin/roles. */
export const CreateRoleBodySchema = z.object({ name: RoleNameSchema });
export type CreateRoleBody = z.infer<typeof CreateRoleBodySchema>;

/** Body of PATCH /api/admin/roles/:id: `name` and/or `isAdmin`. */
export const UpdateRoleBodySchema = z
  .object({ name: RoleNameSchema.optional(), isAdmin: z.boolean().optional() })
  .refine((body) => body.name !== undefined || body.isAdmin !== undefined, {
    message: 'name or isAdmin is required',
  });
export type UpdateRoleBody = z.infer<typeof UpdateRoleBodySchema>;

// ---------- Admin: providers ----------

/** Settings as an admin sends them; `clientSecret` is replaced only when present. */
const ProviderOptionsInputSchema = z.object({
  issuer: z.string().min(1).optional(),
  clientId: z.string().min(1).optional(),
  clientSecret: z.string().min(1).optional(),
});

/** Provider settings as the server shows them: no secret value, only whether it is set. */
export const ProviderOptionsViewSchema = z.object({
  clientId: z.string().nullable(),
  /** Only `oidc` has an issuer; `google` uses the one fixed in code. */
  issuer: z.string().nullable().optional(),
  clientSecretSet: z.boolean(),
});
export type ProviderOptionsView = z.infer<typeof ProviderOptionsViewSchema>;

/** Values the admin copies into the app registration at the provider. */
export const ProviderDataSchema = z.object({
  redirectUri: z.string(),
  scopes: z.string(),
});
export type ProviderData = z.infer<typeof ProviderDataSchema>;

/** Row of GET /api/admin/providers (creation order). */
export const ProviderSummarySchema = z.object({
  id: IdSchema,
  type: ProviderTypeSchema,
  name: z.string(),
  enabled: z.boolean(),
});
export type ProviderSummary = z.infer<typeof ProviderSummarySchema>;

export const ProviderListSchema = z.array(ProviderSummarySchema);
export type ProviderList = z.infer<typeof ProviderListSchema>;

export const ProviderViewSchema = ProviderSummarySchema.extend({
  /** All settings of the type are set. */
  complete: z.boolean(),
  options: ProviderOptionsViewSchema,
  providerData: ProviderDataSchema,
});
export type ProviderView = z.infer<typeof ProviderViewSchema>;

/**
 * Body of POST /api/admin/providers. `type` is any non-empty string: a type outside
 * ProviderTypeSchema gets VALIDATION_FAILED with reason `unknown_type` from the service.
 */
export const CreateProviderBodySchema = z.object({
  type: z.string().min(1),
  name: ProviderNameSchema,
  options: ProviderOptionsInputSchema.optional(),
});
export type CreateProviderBody = z.infer<typeof CreateProviderBodySchema>;

/** Body of PATCH /api/admin/providers/:id. The type never changes. */
export const UpdateProviderBodySchema = z.object({
  name: ProviderNameSchema.optional(),
  enabled: z.boolean().optional(),
  options: ProviderOptionsInputSchema.optional(),
});
export type UpdateProviderBody = z.infer<typeof UpdateProviderBodySchema>;

// ---------- Admin: sign-in settings ----------

export const IDLE_MINUTES_MIN = 15;
export const IDLE_MINUTES_MAX = 1440;
export const IDLE_MINUTES_DEFAULT = 480;
export const ABSOLUTE_MINUTES_MIN = 60;
export const ABSOLUTE_MINUTES_MAX = 43200;
export const ABSOLUTE_MINUTES_DEFAULT = 1440;

/** Public address without `/api`: `https://…` or `http://localhost…`, no path. */
export const PublicUrlSchema = z.string().refine(isPublicUrl, {
  message: 'publicUrl must be https:// or http://localhost, without a path',
});

/** `https`, or `http` only on `localhost` (development): the rule for the public address and an issuer. */
export function isHttpsOrLocalhost(url: URL): boolean {
  return (
    url.protocol === 'https:' ||
    (url.protocol === 'http:' && url.hostname === 'localhost')
  );
}

function isPublicUrl(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  const noPath =
    url.pathname === '/' && !value.endsWith('/') && !url.search && !url.hash;
  return isHttpsOrLocalhost(url) && noPath && !url.username && !url.password;
}

const sessionLimitsFields = {
  publicUrl: PublicUrlSchema.nullable(),
  idleMinutes: z.number().int().min(IDLE_MINUTES_MIN).max(IDLE_MINUTES_MAX),
  absoluteMinutes: z
    .number()
    .int()
    .min(ABSOLUTE_MINUTES_MIN)
    .max(ABSOLUTE_MINUTES_MAX),
};

const idleNotAboveAbsolute = {
  check: (settings: { idleMinutes: number; absoluteMinutes: number }) =>
    settings.idleMinutes <= settings.absoluteMinutes,
  params: {
    message: 'idleMinutes must not exceed absoluteMinutes',
    path: ['idleMinutes'],
  },
};

/** Response of GET/PUT /api/admin/settings/sign-in. `updatedAt: null` while the defaults stand. */
export const SignInSettingsSchema = z
  .object({ ...sessionLimitsFields, updatedAt: z.iso.datetime().nullable() })
  .refine(idleNotAboveAbsolute.check, idleNotAboveAbsolute.params);
export type SignInSettings = z.infer<typeof SignInSettingsSchema>;

/** Body of PUT /api/admin/settings/sign-in. `publicUrl: null` = the address is not saved yet. */
export const UpdateSignInSettingsBodySchema = z
  .object(sessionLimitsFields)
  .refine(idleNotAboveAbsolute.check, idleNotAboveAbsolute.params);
export type UpdateSignInSettingsBody = z.infer<
  typeof UpdateSignInSettingsBodySchema
>;
