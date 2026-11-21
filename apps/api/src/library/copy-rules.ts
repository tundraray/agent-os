import {
  ALL_SERVERS,
  RECORD_NAME_MAX_LENGTH,
  type CopyResult,
  type RecordBody,
} from '@agent-os/contracts';
import { isNameTaken, type ContentPart } from './record-content';

const COPY_SUFFIX = ' — копия';
const FIRST_NUMBERED_COPY = 2;

export interface CopyInput {
  readonly name: string;
  readonly body: RecordBody;
  /** Names the copy may not take: the copier's records and the system records. */
  readonly takenNames: readonly string[];
  /** Servers usable to the copier. */
  readonly usableServers: readonly string[];
  /** Models allowed to the copier, in «Мой доступ» order. */
  readonly allowedModels: readonly string[];
  /** The default chat model; `null` while none is chosen. */
  readonly defaultModel: string | null;
  /** Agent records the copier sees. */
  readonly visibleAgentIds: readonly string[];
}

export type CopyPlan = Omit<CopyResult, 'record'> & {
  readonly name: string;
  readonly body: RecordBody;
};

/**
 * The copier's copy of a record (Flow 3; DC-5–DC-7, AC-05.4, AC-05.5): a free name, the servers usable
 * to the copier (all of them for «все серверы»), each model replaced by the four steps of Flow 3, and
 * only the agents the copier sees; what fell out or was replaced is listed.
 */
export function planCopy(input: CopyInput): CopyPlan {
  const removedServers: CopyPlan['removedServers'] = [];
  const replacedModels: CopyPlan['replacedModels'] = [];
  const copyPart = (part: ContentPart): Omit<ContentPart, 'executor'> => {
    const servers = copyServers(part.servers, input.usableServers);
    const removed = part.servers.filter(
      (server) => server !== ALL_SERVERS && !servers.includes(server),
    );
    if (removed.length > 0)
      removedServers.push({ executor: part.executor, servers: removed });
    // `null` runs on the default chat model at the start, so it is copied as is.
    if (part.model === null) return { servers, model: null };
    const model = replaceModel(part.model, input);
    if (model !== part.model)
      replacedModels.push({
        executor: part.executor,
        from: part.model,
        to: model,
      });
    return { servers, model };
  };

  const visible = new Set(input.visibleAgentIds);
  const { body } = input;
  let copy: RecordBody;
  let removedAgents: string[] = [];
  if (body.kind === 'agent') {
    const { content } = body;
    const { servers, model } = copyPart({
      executor: null,
      servers: content.servers,
      model: content.model,
    });
    removedAgents = content.agents.filter((id) => !visible.has(id));
    const agents = content.agents.filter((id) => visible.has(id));
    copy = {
      kind: 'agent',
      content: { ...content, servers: [...servers], model, agents },
    };
  } else {
    const { content } = body;
    const { model } = copyPart({
      executor: null,
      servers: [],
      model: content.coordinator.model,
    });
    const executors = content.executors.map((executor) => {
      const part = copyPart({
        executor: executor.name,
        servers: executor.servers,
        model: executor.model,
      });
      return { ...executor, servers: [...part.servers], model: part.model };
    });
    copy = {
      kind: 'workflow',
      content: {
        ...content,
        coordinator: { ...content.coordinator, model },
        executors,
      },
    };
  }

  return {
    name: copyName(input.name, input.takenNames),
    body: copy,
    removedServers,
    replacedModels,
    removedAgents,
  };
}

function copyServers(
  servers: readonly string[],
  usable: readonly string[],
): string[] {
  if (servers.includes(ALL_SERVERS)) return [...usable];
  const usableSet = new Set(usable);
  return servers.filter((server) => usableSet.has(server));
}

/**
 * Flow 3: kept when allowed, else the default chat model when chosen and allowed, else the first
 * allowed, else kept.
 */
export function replaceModel(
  model: string,
  {
    allowedModels,
    defaultModel,
  }: Pick<CopyInput, 'allowedModels' | 'defaultModel'>,
): string {
  if (allowedModels.includes(model)) return model;
  if (defaultModel !== null && allowedModels.includes(defaultModel))
    return defaultModel;
  return allowedModels[0] ?? model;
}

/** «{имя} — копия», then «{имя} — копия {N}» with the least free N; the name is cut so the suffix fits. */
function copyName(name: string, takenNames: readonly string[]): string {
  const withSuffix = (suffix: string) =>
    `${name.slice(0, RECORD_NAME_MAX_LENGTH - suffix.length).trimEnd()}${suffix}`;
  const first = withSuffix(COPY_SUFFIX);
  if (!isNameTaken(first, takenNames)) return first;
  for (let n = FIRST_NUMBERED_COPY; ; n += 1) {
    const candidate = withSuffix(`${COPY_SUFFIX} ${n}`);
    if (!isNameTaken(candidate, takenNames)) return candidate;
  }
}
