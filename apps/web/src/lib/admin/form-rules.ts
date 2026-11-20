import {
  ABSOLUTE_MINUTES_MAX,
  ABSOLUTE_MINUTES_MIN,
  IDLE_MINUTES_MAX,
  IDLE_MINUTES_MIN,
  isHttpsOrLocalhost,
  McpServerNameSchema,
  ModelIdSchema,
  PROVIDER_NAME_MAX_LENGTH,
  RECORD_MAX_TURNS_MAX,
  RECORD_MAX_TURNS_MIN,
  type McpServerMode,
  type PriceRates,
} from '@agent-os/contracts';
import { ADMIN_TEXT } from './admin-texts';

/**
 * Field rules of the panel's forms (design-admin.md, KD-5): one pure function per form, checked on submit.
 * Each returns the errors of its fields as texts of `admin-texts.ts`; an empty object lets the form send.
 */

export type FieldErrors<Field extends string> = Partial<Record<Field, string>>;

const PASSWORD_MIN_LENGTH = 12;
const PASSWORD_MAX_LENGTH = 256;
const MODEL_NAME_MAX_LENGTH = 80;
const SHARED_TOKEN_MAX_LENGTH = 4096;
const QUOTA_MIN_USD = 0.01;
const QUOTA_MAX_USD = 1_000_000;
const QUOTA_MAX_DECIMALS = 2;
const MINUTES_PER_HOUR = 60;
/** MC-33: idle hours go in steps of 0,25 hour. */
const IDLE_STEP_MINUTES = 15;

type Decimal = { value: number; decimals: number };

/** A number as typed: digits with an optional comma or dot fraction; spaces between digit groups are dropped. */
function readDecimal(text: string): Decimal | null {
  const compact = text.replace(/[\s ]/g, '');
  const match = /^(-?\d+)(?:[.,](\d+))?$/.exec(compact);
  if (match === null) return null;
  const [, whole, fraction = ''] = match;
  // Built from the typed digits, so «0,29» is exactly the literal 0.29.
  return { value: Number(fraction === '' ? whole : `${whole}.${fraction}`), decimals: fraction.length };
}

/** «0,29» and «0.29» → 0.29; anything that is not a number → `null`. */
export function parseDecimal(text: string): number | null {
  return readDecimal(text)?.value ?? null;
}

const isBlank = (text: string): boolean => text.trim() === '';

/** Length in characters as a person counts them (code points), the way the server checks a password. */
const lengthOf = (text: string): number => Array.from(text).length;

/** A full address with a scheme and a host. */
function parseUrl(text: string): URL | null {
  try {
    const url = new URL(text.trim());
    return url.host === '' ? null : url;
  } catch {
    return null; // not an address: the field shows its error
  }
}

/** `https`, or `http` on `localhost` only (plan Notes 5): the rule of a server address and an issuer. */
function isSecureUrl(text: string): boolean {
  const url = parseUrl(text);
  return url !== null && isHttpsOrLocalhost(url);
}

const isPasswordLength = (password: string): boolean =>
  lengthOf(password) >= PASSWORD_MIN_LENGTH && lengthOf(password) <= PASSWORD_MAX_LENGTH;

// ---------- Accounts (AD-16, MC-22, MC-23) ----------

export type AccountValues = { login: string; name: string; email: string; password: string };

export function accountRules({ login, name, email, password }: AccountValues): FieldErrors<keyof AccountValues> {
  const errors: FieldErrors<keyof AccountValues> = {};
  if (isBlank(login)) errors.login = ADMIN_TEXT.loginRequired;
  if (isBlank(name)) errors.name = ADMIN_TEXT.nameRequired;
  if (isBlank(email)) errors.email = ADMIN_TEXT.emailRequired;
  if (!isPasswordLength(password)) errors.password = ADMIN_TEXT.passwordLength;
  return errors;
}

export function passwordResetRules({ password }: { password: string }): FieldErrors<'password'> {
  return isPasswordLength(password) ? {} : { password: ADMIN_TEXT.passwordLength };
}

// ---------- Roles and providers (MC-26, MC-27) ----------

/**
 * MC-26 has a text only for an empty name; the field's `maxLength` (`ROLE_NAME_MAX_LENGTH`) keeps the
 * name within the server's bound.
 */
export function roleNameRules({ name }: { name: string }): FieldErrors<'name'> {
  return isBlank(name) ? { name: ADMIN_TEXT.roleNameRequired } : {};
}

/** `issuer` is the field of an `oidc` provider; `google` has none. */
export function providerRules({ name, issuer }: { name: string; issuer?: string }): FieldErrors<'name' | 'issuer'> {
  const errors: FieldErrors<'name' | 'issuer'> = {};
  const length = lengthOf(name.trim());
  if (length < 1 || length > PROVIDER_NAME_MAX_LENGTH) errors.name = ADMIN_TEXT.providerNameLength;
  if (issuer !== undefined && !isSecureUrl(issuer)) errors.issuer = ADMIN_TEXT.fullUrl;
  return errors;
}

// ---------- Sign-in settings (AD-14, MC-33, DC-7) ----------

/** Hours as typed → minutes the server stores (×60): «0,25» → 15; not a number → `null`. */
export function hoursToMinutes(text: string): number | null {
  const hours = parseDecimal(text);
  return hours === null ? null : hours * MINUTES_PER_HOUR;
}

/** Minutes the server stores → hours the field shows, comma for the fraction: 480 → «8», 15 → «0,25». */
export function minutesToHours(minutes: number): string {
  return String(Number((minutes / MINUTES_PER_HOUR).toFixed(2))).replace('.', ',');
}

export type SignInSettingsValues = { publicUrl: string; idleHours: string; absoluteHours: string };

export function signInSettingsRules({
  publicUrl,
  idleHours,
  absoluteHours,
}: SignInSettingsValues): FieldErrors<keyof SignInSettingsValues> {
  const errors: FieldErrors<keyof SignInSettingsValues> = {};
  // AD-14: the field checks only a full address with a scheme; the server checks the scheme.
  if (parseUrl(publicUrl) === null) errors.publicUrl = ADMIN_TEXT.fullUrl;

  const idleMinutes = hoursToMinutes(idleHours);
  const idleValid =
    idleMinutes !== null &&
    idleMinutes % IDLE_STEP_MINUTES === 0 &&
    idleMinutes >= IDLE_MINUTES_MIN &&
    idleMinutes <= IDLE_MINUTES_MAX;
  if (!idleValid) errors.idleHours = ADMIN_TEXT.idleHours;

  const absolute = parseDecimal(absoluteHours);
  const absoluteMinutes = absolute === null ? Number.NaN : absolute * MINUTES_PER_HOUR;
  if (
    absolute === null ||
    !Number.isInteger(absolute) ||
    absoluteMinutes < ABSOLUTE_MINUTES_MIN ||
    absoluteMinutes > ABSOLUTE_MINUTES_MAX
  ) {
    errors.absoluteHours = ADMIN_TEXT.absoluteHours;
  } else if (idleValid && absoluteMinutes < idleMinutes) {
    errors.absoluteHours = ADMIN_TEXT.absoluteBelowIdle;
  }
  return errors;
}

// ---------- Library settings ----------

/** «Лимит ходов для новой записи»: a whole number within the contract's bounds of a record's «Максимум шагов». */
export function librarySettingsRules({ defaultMaxTurns }: { defaultMaxTurns: string }): FieldErrors<'defaultMaxTurns'> {
  const turns = parseDecimal(defaultMaxTurns);
  const valid =
    turns !== null && Number.isInteger(turns) && turns >= RECORD_MAX_TURNS_MIN && turns <= RECORD_MAX_TURNS_MAX;
  return valid ? {} : { defaultMaxTurns: ADMIN_TEXT.defaultMaxTurns };
}

// ---------- Grants (GR-01, MC-25, DC-14) ----------

/** The quota field's dollars: empty → `null` (no quota). Call after `quotaRules` passed. */
export function quotaUsdOf(text: string): number | null {
  return isBlank(text) ? null : parseDecimal(text);
}

export function quotaRules({ quota }: { quota: string }): FieldErrors<'quota'> {
  if (isBlank(quota)) return {};
  const typed = readDecimal(quota);
  const valid =
    typed !== null &&
    typed.decimals <= QUOTA_MAX_DECIMALS &&
    typed.value >= QUOTA_MIN_USD &&
    typed.value <= QUOTA_MAX_USD;
  return valid ? {} : { quota: ADMIN_TEXT.quotaRange };
}

export type GrantValues = {
  kind: 'server' | 'tool' | 'model';
  server: string;
  tool: string;
  model: string;
  /** Only a model allow has the quota field. */
  quota: string | null;
};

export function grantRules({ kind, server, tool, model, quota }: GrantValues): FieldErrors<'server' | 'tool' | 'model' | 'quota'> {
  const errors: FieldErrors<'server' | 'tool' | 'model' | 'quota'> = {};
  if (kind !== 'model' && server === '') errors.server = ADMIN_TEXT.serverRequired;
  if (kind === 'tool' && tool === '') errors.tool = ADMIN_TEXT.toolRequired;
  if (kind === 'model' && model === '') errors.model = ADMIN_TEXT.modelRequired;
  if (kind === 'model' && quota !== null) Object.assign(errors, quotaRules({ quota }));
  return errors;
}

// ---------- MCP servers (AD-09, MC-29) ----------

export type ServerValues = { name: string; url: string; mode: McpServerMode; sharedToken: string };

export function serverRules({ name, url, mode, sharedToken }: ServerValues): FieldErrors<'name' | 'url' | 'sharedToken'> {
  const errors: FieldErrors<'name' | 'url' | 'sharedToken'> = {};
  if (name === '' || !McpServerNameSchema.safeParse(name).success) errors.name = ADMIN_TEXT.serverNameRule;
  if (!isSecureUrl(url)) errors.url = ADMIN_TEXT.serverUrl;
  if (mode === 'shared') Object.assign(errors, sharedTokenRules({ sharedToken }));
  return errors;
}

/** The shared token, at registration and when it is replaced (DC-10): 1–4096 characters. */
export function sharedTokenRules({ sharedToken }: { sharedToken: string }): FieldErrors<'sharedToken'> {
  return sharedToken.length >= 1 && sharedToken.length <= SHARED_TOKEN_MAX_LENGTH
    ? {}
    : { sharedToken: ADMIN_TEXT.sharedToken };
}

// ---------- Model catalogue (AD-11, MC-30) ----------

type PriceField = keyof PriceRates;
type PriceTexts = Record<PriceField, string>;

export type ModelValues = {
  /** Only when adding: the id never changes. */
  id?: string;
  name: string;
  prices: PriceTexts;
  /** `null` while «Другие цены для длинных запросов» is off. */
  longContext: { aboveInputTokens: string; prices: PriceTexts } | null;
};

type ModelField = 'id' | 'name' | PriceField | 'aboveInputTokens' | `long.${PriceField}`;

const PRICE_FIELDS: readonly PriceField[] = [
  'inputUsdPerMTok',
  'outputUsdPerMTok',
  'cacheWriteUsdPerMTok',
  'cacheReadUsdPerMTok',
];

const isPrice = (text: string): boolean => {
  const price = parseDecimal(text);
  return price !== null && price >= 0;
};

export function modelRules({ id, name, prices, longContext }: ModelValues): FieldErrors<ModelField> {
  const errors: FieldErrors<ModelField> = {};
  if (id !== undefined && !ModelIdSchema.safeParse(id.trim()).success) errors.id = ADMIN_TEXT.modelIdFormat;
  const nameLength = lengthOf(name.trim());
  if (nameLength < 1 || nameLength > MODEL_NAME_MAX_LENGTH) errors.name = ADMIN_TEXT.modelNameLength;
  for (const field of PRICE_FIELDS) {
    if (!isPrice(prices[field])) errors[field] = ADMIN_TEXT.priceRule;
  }
  if (longContext !== null) {
    const threshold = parseDecimal(longContext.aboveInputTokens);
    if (threshold === null || !Number.isInteger(threshold) || threshold <= 0) {
      errors.aboveInputTokens = ADMIN_TEXT.thresholdRule;
    }
    for (const field of PRICE_FIELDS) {
      if (!isPrice(longContext.prices[field])) errors[`long.${field}`] = ADMIN_TEXT.priceRule;
    }
  }
  return errors;
}
