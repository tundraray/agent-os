import {
  ALL_SERVERS,
  builtinNameIn,
  RECORD_NAME_MAX_LENGTH,
  type CopyResult,
  type Language,
  type RecordBody,
} from '@agent-os/contracts';
import { contentParts, isNameTaken, type ContentPart } from './record-content';

/** The copy mark of UXRD MC-8 in each interface language. */
const COPY_SUFFIX: Readonly<Record<Language, string>> = {
  ru: ' — копия',
  en: ' — copy',
};
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
  /** Skills the copier sees; a deleted one is not among them. */
  readonly visibleSkillIds: readonly string[];
  /** The language of the copier's page: the copy mark and an unrenamed built-in name are in it. */
  readonly language: Language;
  /** The source's built-in key; `null` — not a built-in record. */
  readonly builtinKey: string | null;
}

export type CopyPlan = Omit<CopyResult, 'record'> & {
  readonly name: string;
  readonly body: RecordBody;
};

/**
 * The copier's copy of a record (Flow 3; DC-5–DC-7, AC-05.4, AC-05.5): a free name, the servers usable
 * to the copier (all of them for «все серверы»), each model replaced by the four steps of Flow 3, and
 * only the agents and the skills the copier sees (agent-guidance AC-06.8); what fell out or was replaced is
 * listed. A skill is copied as it is.
 */
export function planCopy(input: CopyInput): CopyPlan {
  const name = copyName(
    sourceName(input),
    COPY_SUFFIX[input.language],
    input.takenNames,
  );
  const { body } = input;
  if (body.kind === 'skill')
    return {
      name,
      body,
      removedServers: [],
      replacedModels: [],
      removedAgents: [],
      removedSkills: [],
    };
  const removedServers: CopyPlan['removedServers'] = [];
  const replacedModels: CopyPlan['replacedModels'] = [];
  const copyPart = (part: ContentPart): CopiedPart => {
    const servers = copyServers(part.servers, input.usableServers);
    const removed = part.servers.filter(
      (server) => server !== ALL_SERVERS && !servers.includes(server),
    );
    if (removed.length > 0)
      removedServers.push({ subagent: part.subagent, servers: removed });
    // `null` runs on the default chat model at the start, so it is copied as is.
    if (part.model === null) return { servers, model: null };
    const model = replaceModel(part.model, input);
    if (model !== part.model)
      replacedModels.push({
        subagent: part.subagent,
        from: part.model,
        to: model,
      });
    return { servers, model };
  };

  const [own, ...subagentParts] = contentParts(body).map(copyPart);
  if (own === undefined)
    throw new Error('a record content without its own part');
  const visibleSkills = new Set(input.visibleSkillIds);
  const removedSkills = body.content.skills.filter(
    (id) => !visibleSkills.has(id),
  );
  const skills = body.content.skills.filter((id) => visibleSkills.has(id));
  let copy: RecordBody;
  let removedAgents: string[] = [];
  if (body.kind === 'agent') {
    const visible = new Set(input.visibleAgentIds);
    const { content } = body;
    removedAgents = content.agents.filter((id) => !visible.has(id));
    const agents = content.agents.filter((id) => visible.has(id));
    copy = { kind: 'agent', content: { ...content, ...own, agents, skills } };
  } else {
    const { content } = body;
    const subagents = content.subagents.map((subagent, index) => {
      const part = subagentParts[index];
      if (part === undefined)
        throw new Error(`subagent ${subagent.name} without its content part`);
      return { ...subagent, ...part };
    });
    copy = {
      kind: 'deep_agent',
      content: { ...content, ...own, subagents, skills },
    };
  }

  return {
    name,
    body: copy,
    removedServers,
    replacedModels,
    removedAgents,
    removedSkills,
  };
}

/** The servers and the model of one part of the copy. */
interface CopiedPart {
  servers: string[];
  model: string | null;
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

/**
 * The name the copy starts from (KD-6): a built-in record still under its seeded name is named in the
 * copier's language; any other name, an administrator's among them, stays as it is.
 */
function sourceName({ name, builtinKey, language }: CopyInput): string {
  return builtinNameIn({ builtinKey, name }, language);
}

/** «{имя}{mark}», then «{имя}{mark} {N}» with the least free N; the name is cut so the suffix fits. */
function copyName(
  name: string,
  copySuffix: string,
  takenNames: readonly string[],
): string {
  const withSuffix = (suffix: string) =>
    `${name.slice(0, RECORD_NAME_MAX_LENGTH - suffix.length).trimEnd()}${suffix}`;
  const first = withSuffix(copySuffix);
  if (!isNameTaken(first, takenNames)) return first;
  for (let n = FIRST_NUMBERED_COPY; ; n += 1) {
    const candidate = withSuffix(`${copySuffix} ${n}`);
    if (!isNameTaken(candidate, takenNames)) return candidate;
  }
}
