import { parseArgs } from 'node:util';
import { rememberSecret } from '@agent-os/common';
import {
  AccessErrorCode,
  MODEL_PROVIDER_API_KEY_MIN_LENGTH,
  ModelDefaultsSchema,
  ModelProviderErrorCode,
  RoleListSchema,
  type CreateCatalogModelBody,
  type ModelProviderKind,
  type UpdateModelDefaultsBody,
} from '@agent-os/contracts';
import {
  DEFAULT_API,
  readLines,
  signIn,
  stepFailed,
  type AdminSession,
} from '../common/admin-cli-client';
import { createAppLogger } from '../logging/app-logger';

const logger = createAppLogger(process.env);

/** A provider of the developer's registry with the key from standard input; `''` — no key. */
interface SeedProvider {
  readonly name: string;
  readonly kind: ModelProviderKind;
  readonly apiKey: string;
}

const DEFAULT_CHAT_MODEL = 'anthropic/claude-haiku-5-5';
const DEFAULT_EMBEDDING_MODEL = 'google/gemini-embedding-001';

/** Google's list price of `gemini-embedding-001`; the owner confirms it against Google's price list. */
const GEMINI_EMBEDDING_INPUT_USD_PER_MTOK = 0.15;

/** The developer's chat models and prices of local runs; the built-in role is allowed each of them. */
const CHAT_MODELS: CreateCatalogModelBody[] = [
  {
    id: DEFAULT_CHAT_MODEL,
    name: 'Haiku',
    purpose: 'chat',
    prices: {
      inputUsdPerMTok: 0.1,
      outputUsdPerMTok: 0.5,
      cacheWriteUsdPerMTok: 0.125,
      cacheReadUsdPerMTok: 0.01,
    },
    longContext: {
      aboveInputTokens: 100_000,
      prices: {
        inputUsdPerMTok: 0.5,
        outputUsdPerMTok: 2.5,
        cacheWriteUsdPerMTok: 0.625,
        cacheReadUsdPerMTok: 0.05,
      },
    },
  },
  {
    id: 'anthropic/claude-sonnet-5-5',
    name: 'Sonnet',
    purpose: 'chat',
    prices: {
      inputUsdPerMTok: 2,
      outputUsdPerMTok: 10,
      cacheWriteUsdPerMTok: 2.5,
      cacheReadUsdPerMTok: 0.1,
    },
    longContext: null,
  },
];

/** The catalogue: the chat models and the embedding model; an embedding model takes no grant. */
const MODELS: CreateCatalogModelBody[] = [
  ...CHAT_MODELS,
  {
    id: DEFAULT_EMBEDDING_MODEL,
    name: 'Gemini Embedding',
    purpose: 'embedding',
    inputUsdPerMTok: GEMINI_EMBEDDING_INPUT_USD_PER_MTOK,
    dimensions: 768,
  },
];

/**
 * Standard input, three lines: the administrator's password, the Anthropic key, the Google key; an
 * empty key line — the provider without a key. Each key goes to the secret memory before any log.
 */
async function readInput(): Promise<{
  password: string;
  providers: SeedProvider[];
}> {
  const [password = '', anthropicKey = '', googleKey = ''] = await readLines(3);
  const providers: SeedProvider[] = [
    { name: 'anthropic', kind: 'anthropic', apiKey: anthropicKey },
    { name: 'google', kind: 'gemini', apiKey: googleKey },
  ];
  for (const { apiKey } of providers) rememberSecret(apiKey);
  for (const { name, apiKey } of providers) {
    // The message names the provider and the rule only: never the key or a part of it.
    if (apiKey !== '' && apiKey.length < MODEL_PROVIDER_API_KEY_MIN_LENGTH)
      throw new Error(
        `The ${name} key is shorter than ${MODEL_PROVIDER_API_KEY_MIN_LENGTH} characters`,
      );
  }
  return { password, providers };
}

/** `--login`, `--api`; the password and the keys never come from the arguments, only from stdin. */
function readArguments(): { login: string; api: string } {
  const { values, positionals } = parseArgs({
    options: {
      login: { type: 'string' },
      api: { type: 'string', default: DEFAULT_API },
    },
    // Collected rather than rejected by parseArgs: its error message would echo a password typed here.
    allowPositionals: true,
  });
  if (positionals.length > 0) {
    throw new Error(
      'Positional arguments are not accepted; the password and the keys are read from standard input',
    );
  }
  const { login, api } = values;
  if (!login) throw new Error('--login is required');
  return { login, api };
}

/**
 * Adds the provider with its key; a taken name (409) keeps the provider, and a given key replaces its
 * key — an empty line never removes one. The log says whether a key was set, never the key.
 */
async function seedProvider(
  session: AdminSession,
  { name, kind, apiKey }: SeedProvider,
): Promise<void> {
  const keySet = apiKey !== '';
  const created = await session.request('POST', '/api/admin/model-providers', {
    name,
    kind,
    ...(keySet ? { apiKey } : {}),
  });
  if (created.status === 201) {
    logger.info('model provider seeded', {
      provider: name,
      kind,
      keySet,
      outcome: 'created',
    });
    return;
  }
  if (
    created.error?.errorCode !==
    ModelProviderErrorCode.MODEL_PROVIDER_NAME_TAKEN
  )
    throw stepFailed(`Adding provider ${name}`, created);
  if (keySet) {
    const updated = await session.request(
      'PATCH',
      `/api/admin/model-providers/${name}`,
      { apiKey },
    );
    if (updated.status !== 200)
      throw stepFailed(`Setting the key of provider ${name}`, updated);
  }
  logger.info('model provider seeded', {
    provider: name,
    kind,
    keySet,
    outcome: keySet ? 'exists: key replaced' : 'skipped: name taken',
  });
}

/**
 * Chooses Haiku and the Gemini embedding model as the defaults where none is chosen yet, so a repeated
 * run keeps the administrator's choice.
 */
async function seedModelDefaults(session: AdminSession): Promise<void> {
  const read = await session.request('GET', '/api/admin/model-defaults');
  if (read.status !== 200) throw stepFailed('Reading model defaults', read);
  const current = ModelDefaultsSchema.parse(read.body);
  const wanted: UpdateModelDefaultsBody = {
    chatModel: current.chatModel ?? DEFAULT_CHAT_MODEL,
    embeddingModel: current.embeddingModel ?? DEFAULT_EMBEDDING_MODEL,
  };
  const unchanged =
    wanted.chatModel === current.chatModel &&
    wanted.embeddingModel === current.embeddingModel;
  if (!unchanged) {
    const written = await session.request(
      'PUT',
      '/api/admin/model-defaults',
      wanted,
    );
    if (written.status !== 200)
      throw stepFailed('Setting model defaults', written);
  }
  logger.info('model defaults seeded', {
    ...wanted,
    outcome: unchanged ? 'skipped: chosen' : 'set',
  });
}

/** Adds the model; a taken id (409) is skipped, so a repeated run changes nothing. */
async function seedModel(
  session: AdminSession,
  model: CreateCatalogModelBody,
): Promise<void> {
  const answer = await session.request('POST', '/api/admin/models', model);
  if (
    answer.status !== 201 &&
    answer.error?.errorCode !== AccessErrorCode.MODEL_ID_TAKEN
  )
    throw stepFailed(`Adding model ${model.id}`, answer);
  logger.info('access model seeded', {
    model: model.id,
    outcome: answer.status === 201 ? 'created' : 'skipped: id taken',
  });
}

async function builtinRoleId(session: AdminSession): Promise<string> {
  const answer = await session.request('GET', '/api/admin/roles');
  if (answer.status !== 200) throw stepFailed('Reading roles', answer);
  const builtin = RoleListSchema.parse(answer.body).find(
    (role) => role.builtinKind === 'super_admin',
  );
  if (builtin === undefined) throw new Error('The built-in role is missing');
  return builtin.id;
}

/**
 * Allows the chat model to the role without a quota; an existing grant (409) is skipped. Servers need
 * no grant: the super-administrator gets every tool (access-levels FR-34).
 */
async function seedGrant(
  session: AdminSession,
  roleId: string,
  model: string,
): Promise<void> {
  const answer = await session.request('POST', '/api/admin/grants', {
    roleId,
    effect: 'allow',
    target: { kind: 'model', model },
  });
  if (
    answer.status !== 201 &&
    answer.error?.errorCode !== AccessErrorCode.GRANT_EXISTS
  )
    throw stepFailed(`Granting ${model}`, answer);
  logger.info('access grant seeded', {
    roleId,
    model,
    outcome: answer.status === 201 ? 'created' : 'skipped: exists',
  });
}

/**
 * Entry of `pnpm --filter api seed:access` (model-providers design-core.md, FR-17; development only,
 * run from `dist`): a client of the running API that registers the providers `anthropic` and `google`
 * with the keys from standard input, fills the catalogue with Haiku, Sonnet and the Gemini embedding
 * model, chooses the default models and allows the built-in role the chat models without a quota.
 */
async function main(): Promise<void> {
  const startedAt = Date.now();
  const { login, api } = readArguments();
  const { password, providers } = await readInput();
  const session = await signIn(api, login, password);
  for (const provider of providers) await seedProvider(session, provider);
  for (const model of MODELS) await seedModel(session, model);
  await seedModelDefaults(session);
  const roleId = await builtinRoleId(session);
  for (const model of CHAT_MODELS) await seedGrant(session, roleId, model.id);
  logger.info('seed:access finished', {
    login,
    providers: providers.map(({ name, apiKey }) => ({
      provider: name,
      keySet: apiKey !== '',
    })),
    outcome: 'ok',
    durationMs: Date.now() - startedAt,
  });
}

try {
  await main();
} catch (error) {
  // Error messages carry steps, statuses and error codes only: no password, key or cookie.
  logger.error('seed:access failed', { error });
  process.exitCode = 1;
}
