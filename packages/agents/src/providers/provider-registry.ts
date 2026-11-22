import { type LogFields, type Logger, rememberSecret } from '@agent-os/common';
import {
  type CreateModelProviderBody,
  type ModelProviderCheck,
  type ModelProviderKind,
  ModelProviderKindSchema,
  type ModelProviderView,
  type UpdateModelProviderBody,
} from '@agent-os/contracts';
import { AgentModelProvidersRepository, DATABASE, type Database, type ModelProviderRow } from '@agent-os/db';
import { Inject, Injectable } from '@nestjs/common';

import { AGENTS_LOGGER } from '../agents.tokens';
import {
  ModelProviderError,
  providerHasModels,
  providerNameTaken,
  providerNotFound,
} from './model-provider-errors';
import { checkProvider } from './provider-check';
import { PROVIDER_KINDS } from './provider-kinds';
import { type ProviderReadiness, providerReadiness, providerState } from './provider-readiness';

/** Stands in for the key in «было/стало»: `AuditLog` writes `secret_changed` for its field name. */
const SECRET_MARK = 'changed';

/** A provider as the registry shows it; the controller adds `catalogModels` from `AccessService`. */
export type ProviderRegistryView = Omit<ModelProviderView, 'catalogModels'>;

/** The provider as an audit entry keeps it: no key value, only the mark of a key set, replaced or removed. */
export interface ModelProviderAuditState {
  readonly name: string;
  readonly kind: ModelProviderKind;
  readonly baseUrl: string | null;
  readonly enabled: boolean;
  readonly apiKey?: typeof SECRET_MARK;
}

/** A registry write: the provider as the admin now sees it, and «было/стало» for `admin_change`. */
export interface ModelProviderWrite {
  readonly view: ProviderRegistryView;
  readonly before: ModelProviderAuditState | null;
  readonly after: ModelProviderAuditState;
}

export interface ModelProviderRemoval {
  readonly before: ModelProviderAuditState;
  readonly after: null;
}

/** Removal of a provider with the number of its catalogue models, read by the controller (AC-01.3). */
export interface ModelProviderRemove {
  readonly name: string;
  readonly catalogModels: number;
}

/** What one request to the provider needs, read from its row on every call (KD-1). */
export interface ProviderConnection {
  readonly name: string;
  readonly kind: ModelProviderKind;
  /** The set address or the kind's default. */
  readonly baseUrl: string;
  readonly apiKey: string | null;
  readonly enabled: boolean;
}

function kindOf(row: ModelProviderRow): ModelProviderKind {
  return ModelProviderKindSchema.parse(row.kind);
}

/** Every key the process reads is in the secret memory from that moment (Invariant 2). */
function remembered<T extends ModelProviderRow | undefined>(row: T): T {
  const key = row?.apiKey;
  if (typeof key === 'string') rememberSecret(key);
  return row;
}

function connectionOf(row: ModelProviderRow): ProviderConnection {
  const kind = kindOf(row);
  return {
    name: row.name,
    kind,
    baseUrl: row.baseUrl ?? PROVIDER_KINDS[kind].defaultBaseUrl,
    apiKey: row.apiKey,
    enabled: row.enabled,
  };
}

/** The provider for the admin: whether a key is set and its last four characters, never its value (DC-2). */
function viewOf(row: ModelProviderRow): ProviderRegistryView {
  const connection = connectionOf(row);
  return {
    name: row.name,
    kind: connection.kind,
    baseUrl: row.baseUrl,
    effectiveBaseUrl: connection.baseUrl,
    enabled: row.enabled,
    apiKeySet: row.apiKey !== null,
    apiKeyLast4: row.apiKey === null ? null : row.apiKey.slice(-4),
    keyRequired: PROVIDER_KINDS[connection.kind].keyRequired,
    servesEmbeddings: PROVIDER_KINDS[connection.kind].embeddings,
    state: providerState(connection),
  };
}

function auditStateOf(row: ModelProviderRow, keyChanged: boolean): ModelProviderAuditState {
  return {
    name: row.name,
    kind: kindOf(row),
    baseUrl: row.baseUrl,
    enabled: row.enabled,
    ...(keyChanged ? { apiKey: SECRET_MARK } : {}),
  };
}

/**
 * The model provider registry for the controllers of `apps/api` and the package's own calls (ADR-0019,
 * design-core.md, Contract «Внутри платформы»). The key is write-only: no result carries its value, and a
 * key read or accepted goes to the secret memory before any log (KD-7). The registry writes no audit.
 */
@Injectable()
export class AgentsProviders {
  private readonly logger: Logger;

  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(AgentModelProvidersRepository) private readonly providerRows: AgentModelProvidersRepository,
    @Inject(AGENTS_LOGGER) logger: Logger,
  ) {
    this.logger = logger.child({ service: 'agents.providers' });
  }

  async list(): Promise<ProviderRegistryView[]> {
    const rows = await this.providerRows.list(this.database);
    return rows.map((row) => viewOf(remembered(row)));
  }

  async get(name: string): Promise<ProviderRegistryView> {
    return viewOf(await this.rowOf(name));
  }

  /** The provider is created enabled. */
  create(input: CreateModelProviderBody): Promise<ModelProviderWrite> {
    if (input.apiKey !== undefined) rememberSecret(input.apiKey);
    const fields = { provider: input.name, kind: input.kind, changed: Object.keys(input) };
    return this.logged('model provider creation', fields, async () => {
      const row = remembered(
        await this.providerRows.insert(this.database, {
          name: input.name,
          kind: input.kind,
          baseUrl: input.baseUrl ?? null,
          apiKey: input.apiKey ?? null,
        }),
      );
      if (row === undefined) throw providerNameTaken(input.name);
      return { view: viewOf(row), before: null, after: auditStateOf(row, row.apiKey !== null) };
    });
  }

  /** `baseUrl: null` — the kind's default address; `apiKey: null` — remove the key. */
  update(name: string, patch: UpdateModelProviderBody): Promise<ModelProviderWrite> {
    if (typeof patch.apiKey === 'string') rememberSecret(patch.apiKey);
    const fields = { provider: name, changed: Object.keys(patch) };
    return this.logged(
      'model provider update',
      fields,
      async () => {
        const change = await this.database.transaction((tx) => this.providerRows.update(tx, name, patch));
        if (change === undefined) throw providerNotFound(name);
        const keyChanged = patch.apiKey !== undefined;
        return {
          view: viewOf(remembered(change.after)),
          before: auditStateOf(remembered(change.before), keyChanged),
          after: auditStateOf(change.after, keyChanged),
        };
      },
      (write) => ({ kind: write.after.kind }),
    );
  }

  /** Refused with `MODEL_PROVIDER_HAS_MODELS` while the catalogue has models of the provider (Invariant 5). */
  remove({ name, catalogModels }: ModelProviderRemove): Promise<ModelProviderRemoval> {
    return this.logged(
      'model provider removal',
      { provider: name, catalogModels },
      async () => {
        if (catalogModels > 0) throw providerHasModels(name, catalogModels);
        const row = remembered(await this.providerRows.delete(this.database, name));
        if (row === undefined) throw providerNotFound(name);
        return { before: auditStateOf(row, false), after: null };
      },
      (removal) => ({ kind: removal.before.kind }),
    );
  }

  /** The provider's kind, or `null` when it is not registered. */
  async kindOf(name: string): Promise<ModelProviderKind | null> {
    const row = remembered(await this.providerRows.find(this.database, name));
    return row === undefined ? null : kindOf(row);
  }

  /** Readiness of each named provider, in one query. */
  async readiness(names: readonly string[]): Promise<ReadonlyMap<string, ProviderReadiness>> {
    const rows = await this.providerRows.findMany(this.database, names);
    const byName = new Map(rows.map((row) => [row.name, connectionOf(remembered(row))]));
    return new Map(names.map((name) => [name, providerReadiness(byName.get(name) ?? null)]));
  }

  /** The provider's connection with its key, or `null` when it is not registered. */
  async connection(name: string): Promise<ProviderConnection | null> {
    const row = remembered(await this.providerRows.find(this.database, name));
    return row === undefined ? null : connectionOf(row);
  }

  /** One request with the stored address and key; no ledger row, no audit (FR-15). */
  check(name: string): Promise<ModelProviderCheck> {
    return this.logged(
      'model provider check',
      { provider: name },
      async () => checkProvider(connectionOf(await this.rowOf(name))),
      (check) => ({ result: check.result, message: check.message }),
    );
  }

  private async rowOf(name: string): Promise<ModelProviderRow> {
    const row = remembered(await this.providerRows.find(this.database, name));
    if (row === undefined) throw providerNotFound(name);
    return row;
  }

  /** Runs a write or a check with one log record of its outcome and duration; values of the input stay out. */
  private async logged<T>(
    operation: string,
    fields: LogFields,
    work: () => Promise<T>,
    describe: (result: T) => LogFields = () => ({}),
  ): Promise<T> {
    const startedAt = performance.now();
    const durationMs = () => Math.round(performance.now() - startedAt);
    try {
      const result = await work();
      this.logger.info(`${operation} done`, {
        ...fields,
        ...describe(result),
        outcome: 'done',
        durationMs: durationMs(),
      });
      return result;
    } catch (error) {
      if (error instanceof ModelProviderError) {
        this.logger.warn(`${operation} refused`, {
          ...fields,
          outcome: error.code,
          count: error.count,
          durationMs: durationMs(),
        });
      } else {
        this.logger.error(`${operation} failed`, { ...fields, durationMs: durationMs(), error });
      }
      throw error;
    }
  }
}
