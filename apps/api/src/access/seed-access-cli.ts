import { parseArgs } from 'node:util';
import {
  AccessErrorCode,
  RoleListSchema,
  type CreateCatalogModelBody,
  type GrantTargetBody,
} from '@agent-os/contracts';
import {
  DEFAULT_API,
  readPassword,
  SEED_MCP_SERVERS,
  signIn,
  stepFailed,
  type AdminSession,
} from '../common/admin-cli-client.js';
import { createAppLogger } from '../logging/app-logger.js';

const logger = createAppLogger(process.env);

/** The developer's catalogue: the models and prices of local runs. */
const MODELS: CreateCatalogModelBody[] = [
  {
    id: 'anthropic/claude-haiku-5-5',
    name: 'Haiku',
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
    prices: {
      inputUsdPerMTok: 2,
      outputUsdPerMTok: 10,
      cacheWriteUsdPerMTok: 2.5,
      cacheReadUsdPerMTok: 0.1,
    },
    longContext: null,
  },
];

/** What the built-in role is allowed: the `seed:mcp` servers and both models, without a quota. */
const TARGETS: GrantTargetBody[] = [
  ...[...SEED_MCP_SERVERS.shared, SEED_MCP_SERVERS.oauth].map((server) => ({
    kind: 'server' as const,
    server,
  })),
  ...MODELS.map((model) => ({ kind: 'model' as const, model: model.id })),
];

/** `--login`, `--api`; the password never comes from the arguments, only from stdin. */
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
      'Positional arguments are not accepted; the password is read from standard input',
    );
  }
  const { login, api } = values;
  if (!login) throw new Error('--login is required');
  return { login, api };
}

function targetName(target: GrantTargetBody): string {
  if (target.kind === 'model') return target.model;
  if (target.kind === 'tool') return `${target.server}/${target.tool}`;
  return target.server;
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
    (role) => role.builtin,
  );
  if (builtin === undefined) throw new Error('The built-in role is missing');
  return builtin.id;
}

/**
 * Allows the target to the role; an existing grant (409) is skipped. Returns false for a server the
 * registry does not know yet, so the run goes on and ends with exit code 1.
 */
async function seedGrant(
  session: AdminSession,
  roleId: string,
  target: GrantTargetBody,
): Promise<boolean> {
  const answer = await session.request('POST', '/api/admin/grants', {
    roleId,
    effect: 'allow',
    target,
  });
  const fields = { roleId, target: targetName(target) };
  if (
    answer.status === 201 ||
    answer.error?.errorCode === AccessErrorCode.GRANT_EXISTS
  ) {
    logger.info('access grant seeded', {
      ...fields,
      outcome: answer.status === 201 ? 'created' : 'skipped: exists',
    });
    return true;
  }
  if (
    target.kind === 'server' &&
    answer.error?.errorCode === AccessErrorCode.GRANT_TARGET_UNKNOWN
  ) {
    logger.warn('access grant skipped: run seed:mcp first', {
      ...fields,
      outcome: 'server_unknown',
    });
    return false;
  }
  throw stepFailed(`Granting ${targetName(target)}`, answer);
}

/**
 * Entry of `pnpm --filter api seed:access` (design-access.md, Runtime settings; development only, run
 * from `dist`): a client of the running API that fills the developer's catalogue with Haiku and Sonnet
 * and allows the built-in role the `seed:mcp` servers and both models without a quota.
 */
async function main(): Promise<void> {
  const startedAt = Date.now();
  const { login, api } = readArguments();
  const session = await signIn(api, login, await readPassword());
  for (const model of MODELS) await seedModel(session, model);
  const roleId = await builtinRoleId(session);
  let complete = true;
  for (const target of TARGETS) {
    complete = (await seedGrant(session, roleId, target)) && complete;
  }
  if (!complete) process.exitCode = 1;
  logger.info('seed:access finished', {
    login,
    outcome: complete ? 'ok' : 'servers missing',
    durationMs: Date.now() - startedAt,
  });
}

try {
  await main();
} catch (error) {
  // Error messages carry steps, statuses and error codes only: no password or cookie.
  logger.error('seed:access failed', { error });
  process.exitCode = 1;
}
