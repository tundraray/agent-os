'use client';

import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ChevronDown, Info } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useStore } from 'zustand';
import {
  ALL_SERVERS,
  type AgentContent,
  type ConnectedSkill,
  type DeepAgentContent,
  type MissingRight,
  type RecordBody,
  type RecordKind,
  type SkillContent,
  type StartableBody,
  type Subagent,
} from '@agent-os/contracts';
import { Button } from '@/components/ui/button';
import { StateBadge } from '@/components/state-badge';
import { useShellServices } from '@/components/shell/shell-actions';
import { RecordLabel } from '@/components/library/record-label';
import { formatRecordModel, type ModelNames } from '@/lib/agents/format';
import { builtinRoleName } from '@/i18n/builtin-name';
import type {
  ChangedField,
  RecordField,
  SubagentField,
} from '@/lib/library/record-rules';
import { cn } from 'cn';

/**
 * «В карточке» — a decision card that creates a record; «Правка» — one that edits it, with the changes marked;
 * «На странице» — a record's page in the library or the panel; «Схема» — the diagram panel beside the conversation.
 */
export type DefinitionViewVariant = 'card' | 'edit' | 'page' | 'schema';

/**
 * «Пояснение получателю» (AC-29.1, MC-6): the author and the viewer's roles the record is shared with; `offered` —
 * the viewer's chat takes the record (a skill's note says so, agent-guidance MC-13).
 */
export type DefinitionRecipient = {
  author: string;
  roles: readonly string[];
  offered: boolean;
};

export type DefinitionViewProps = {
  definition: { readonly description: string } & RecordBody;
  /** What the viewer lacks to run the record: its servers are marked «у вас недоступна». */
  missingRights: readonly MissingRight[];
  variant: DefinitionViewVariant;
  /** Only on a colleague's record page. */
  recipient?: DefinitionRecipient | null;
  /** The record page of an agent this agent may start; its label has no link without it. */
  recordHref?: (recordId: string) => string;
  /** The viewer's models and default chat model: models read by title, a record without its own model by the default. */
  modelNames?: ModelNames;
  /** «Правка»: what the edit changes against the saved version (`changedFields`). */
  changes?: readonly ChangedField[];
  /** The record's skills as its read names them (`connectedSkills`); the row «Скиллы» stands only with them. */
  connectedSkills?: readonly ConnectedSkill[];
  /** The owner's «Изменить» under the row «Скиллы» (agent-guidance SP-02); with it the row stands even empty. */
  skillsAction?: ReactNode;
};

const CAPTION = 'text-muted-foreground text-xs leading-4 font-medium';

/**
 * A record's definition, read-only (design-system definition-view.md; custom-agents UXRD MC-9, MC-12;
 * deep-agents UXRD MC-26, MC-27). Instructions, subagent names and descriptions are other people's text:
 * rendered as plain text with the author's line breaks, never as markdown or HTML. A server is named as the
 * MCP registry names it, without a description (design-web.md, KD-8).
 */
export function DefinitionView({
  definition,
  missingRights,
  variant,
  recipient,
  recordHref,
  modelNames,
  changes = [],
  connectedSkills = [],
  skillsAction,
}: DefinitionViewProps) {
  const marks = marksOf(changes);
  if (definition.kind !== 'skill' && variant === 'schema')
    return <SchemaRows definition={definition} missingRights={missingRights} />;
  const skills =
    connectedSkills.length > 0 || skillsAction !== undefined ? (
      <SkillsRow
        skills={connectedSkills}
        recordHref={recordHref}
        action={skillsAction}
      />
    ) : null;
  return (
    <div className="@container flex flex-col gap-2">
      {recipient != null && (
        <RecipientNote kind={definition.kind} recipient={recipient} />
      )}
      {definition.kind === 'skill' ? (
        <SkillRows
          description={definition.description}
          content={definition.content}
          marks={marks}
        />
      ) : definition.kind === 'agent' ? (
        <dl className="flex flex-col gap-2">
          <DescriptionRow description={definition.description} marks={marks} />
          <AgentRows
            content={definition.content}
            missing={missingServers(missingRights, null)}
            variant={variant}
            marks={marks}
            recordHref={recordHref}
            modelNames={modelNames}
            skills={skills}
          />
        </dl>
      ) : (
        <DeepAgentRows
          description={definition.description}
          content={definition.content}
          missingRights={missingRights}
          variant={variant}
          marks={marks}
          modelNames={modelNames}
          skills={skills}
        />
      )}
    </div>
  );
}

function RecipientNote({
  kind,
  recipient,
}: {
  kind: RecordKind;
  recipient: DefinitionRecipient;
}) {
  const t = useTranslations('library');
  const locale = useLocale();
  const roles = recipient.roles.map((name) => builtinRoleName(name, locale));
  return (
    <div
      role="note"
      className="bg-info-subtle border-info-border flex gap-2 rounded-md border p-3"
    >
      <Info aria-hidden className="text-info mt-px size-4 shrink-0" />
      <p className="text-foreground text-xs leading-4 font-medium">
        {kind === 'skill'
          ? t('definition.recipientSkill', {
              author: recipient.author,
              roleCount: roles.length,
              roles: roles.join(', '),
              offered: recipient.offered ? 'yes' : 'no',
            })
          : t('definition.recipient', {
              author: recipient.author,
              roleCount: roles.length,
              roles: roles.join(', '),
              kind,
            })}
      </p>
    </div>
  );
}

/**
 * The marks of «Правка» (MC-24): «изменено» on a changed row or subagent, «новый» on an added subagent, and
 * «Убрано: …» under the part that lost entries. Other variants get no changes, so nothing is marked.
 */
type Marks = {
  changed: (field: RecordField) => boolean;
  /** The entries a list field lost. */
  removed: (field: RecordField) => readonly string[];
  subagent: (name: string) => SubagentMark | null;
  removedSubagents: readonly string[];
};

type SubagentMark = {
  change: 'changed' | 'new';
  fields: readonly SubagentField[];
};

function marksOf(changes: readonly ChangedField[]): Marks {
  const fieldChange = (field: RecordField) =>
    changes.find(
      (item): item is Extract<ChangedField, { field: RecordField }> =>
        item.field === field,
    );
  return {
    changed: (field) => fieldChange(field) !== undefined,
    removed: (field) => fieldChange(field)?.removed ?? [],
    subagent: (name) => {
      for (const item of changes) {
        if (item.field !== 'subagent' || item.subagent !== name) continue;
        if (item.change === 'changed')
          return { change: 'changed', fields: item.fields };
        if (item.change === 'new') return { change: 'new', fields: [] };
      }
      return null;
    },
    removedSubagents: changes.flatMap((item) =>
      item.field === 'subagent' && item.change === 'removed'
        ? [item.subagent]
        : [],
    ),
  };
}

/** «изменено» or «новый»: a word in the «Источник» badge, not a colour (definition-view.md, Accessibility). */
function ChangeBadge({ change }: { change: SubagentMark['change'] }) {
  const t = useTranslations('agents.recordCard');
  return <StateBadge variant="source">{t(change)}</StateBadge>;
}

/** «Убрано: …» under its part; nothing when the part lost nothing. */
function RemovedLine({ names }: { names: readonly string[] }) {
  const t = useTranslations('agents.recordCard');
  if (names.length === 0) return null;
  return (
    <span className={cn(CAPTION, 'block break-words')}>
      {t('removed', { what: names.join(', ') })}
    </span>
  );
}

type RowProps = {
  label: string;
  changed?: boolean;
  stacked?: boolean;
  children: ReactNode;
};

/**
 * «подпись — значение»: the label left in a 140 px column from 560 px of width, above the value below it;
 * `stacked` — always above (variant «Схема»).
 */
function Row({ label, changed = false, stacked = false, children }: RowProps) {
  return (
    <div
      className={cn(
        'grid gap-0.5',
        !stacked &&
          '@[35rem]:grid-cols-[8.75rem_minmax(0,1fr)] @[35rem]:gap-x-4',
      )}
    >
      <dt
        className={cn(
          CAPTION,
          'flex flex-wrap items-center gap-1.5',
          !stacked && '@[35rem]:pt-0.5',
        )}
      >
        {label}
        {changed && <ChangeBadge change="changed" />}
      </dt>
      <dd className="text-foreground min-w-0 text-sm leading-5">{children}</dd>
    </div>
  );
}

function DescriptionRow({
  description,
  marks,
}: {
  description: string;
  marks: Marks;
}) {
  const tLibrary = useTranslations('library');
  return (
    <Row
      label={tLibrary('fields.description')}
      changed={marks.changed('description')}
    >
      <span className="break-words whitespace-pre-wrap">
        {description === '' ? '—' : description}
      </span>
    </Row>
  );
}

/**
 * A skill (skill-record.md, «Страница для читателя»): «Когда применять» as a line and «Шаги» as long text, whole
 * behind «Показать целиком» in every variant.
 */
function SkillRows({
  description,
  content,
  marks,
}: {
  description: string;
  content: SkillContent;
  marks: Marks;
}) {
  const tLibrary = useTranslations('library');
  return (
    <dl className="flex flex-col gap-2">
      <Row
        label={tLibrary('fields.whenToUse')}
        changed={marks.changed('description')}
      >
        <span className="break-words whitespace-pre-wrap">{description}</span>
      </Row>
      <Row label={tLibrary('fields.steps')} changed={marks.changed('steps')}>
        <LongText text={content.text} collapsible />
      </Row>
    </dl>
  );
}

/**
 * «Скиллы» (skill-picker.md, «Строка «Скиллы» в просмотре»; agent-guidance KD-7): a skill in the viewer's library
 * list is a label linking to its page; any other is its name, its description and «текст вам не виден».
 */
function SkillsRow({
  skills,
  recordHref,
  action,
}: {
  skills: readonly ConnectedSkill[];
  recordHref?: (recordId: string) => string;
  action?: ReactNode;
}) {
  const { libraryIndex } = useShellServices();
  const records = useStore(libraryIndex, (state) => state.records);
  const t = useTranslations('library');
  return (
    <Row label={t('fields.skills')}>
      {skills.length === 0 && '—'}
      <ul className="flex flex-col gap-1 empty:hidden">
        {skills.map((skill) => {
          const summary = records?.get(skill.id);
          return (
            <li key={skill.id} className="min-w-0">
              {summary === undefined ? (
                <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                  <span className="min-w-0 break-words">
                    <span className="font-medium">{skill.name}</span>
                    <span className="text-muted-foreground">
                      {' '}
                      — {skill.description}
                    </span>
                  </span>
                  <StateBadge state="off">{t('skillFields.hidden')}</StateBadge>
                </span>
              ) : (
                <RecordLabel
                  variant="row"
                  summary={summary}
                  href={recordHref?.(skill.id)}
                />
              )}
            </li>
          );
        })}
      </ul>
      {action !== undefined && <div className="pt-1">{action}</div>}
    </Row>
  );
}

type AgentRowsProps = {
  content: AgentContent;
  missing: readonly string[];
  variant: DefinitionViewVariant;
  marks: Marks;
  recordHref?: (recordId: string) => string;
  modelNames?: ModelNames;
  /** The row «Скиллы», right after «Системы». */
  skills: ReactNode;
};

function AgentRows({
  content,
  missing,
  variant,
  marks,
  recordHref,
  modelNames,
  skills,
}: AgentRowsProps) {
  const t = useTranslations('formats');
  const tLibrary = useTranslations('library');
  const removedAgents = marks.removed('agents');
  return (
    <>
      <Row label={tLibrary('fields.prompt')} changed={marks.changed('prompt')}>
        <LongText text={content.prompt} collapsible={variant !== 'page'} />
      </Row>
      <Row label={tLibrary('fields.model')} changed={marks.changed('model')}>
        {formatRecordModel(t, content.model, modelNames)}
      </Row>
      <Row
        label={tLibrary('fields.maxTurns')}
        changed={marks.changed('maxTurns')}
      >
        <span className="tabular-nums">{content.maxTurns}</span>
      </Row>
      <Row
        label={tLibrary('fields.servers')}
        changed={marks.changed('servers')}
      >
        <Servers servers={content.servers} missing={missing} />
        <RemovedLine names={marks.removed('servers')} />
      </Row>
      {skills}
      <CapabilitiesRow taskList={content.taskList} />
      {(content.agents.length > 0 || removedAgents.length > 0) && (
        <Row
          label={tLibrary('fields.agents')}
          changed={marks.changed('agents')}
        >
          {content.agents.length > 0 && (
            <StartableAgents ids={content.agents} recordHref={recordHref} />
          )}
          <RemovedAgents ids={removedAgents} />
        </Row>
      )}
    </>
  );
}

/** «Убрано: …» of startable agents, named from the live library list. */
function RemovedAgents({ ids }: { ids: readonly string[] }) {
  const { libraryIndex } = useShellServices();
  const records = useStore(libraryIndex, (state) => state.records);
  const t = useTranslations('library');
  const names = ids.map(
    (id) => records?.get(id)?.name ?? t('label.unavailable', { kind: 'agent' }),
  );
  return <RemovedLine names={names} />;
}

/** The agents this agent may start, labelled from the live library list; an agent not in it is unavailable. */
function StartableAgents({
  ids,
  recordHref,
}: {
  ids: readonly string[];
  recordHref?: (recordId: string) => string;
}) {
  const { libraryIndex } = useShellServices();
  const records = useStore(libraryIndex, (state) => state.records);
  const t = useTranslations('library');
  return (
    <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
      {ids.map((id, index) => {
        const summary = records?.get(id);
        const comma =
          index < ids.length - 1 ? <span aria-hidden>,</span> : null;
        return (
          <span key={id} className="inline-flex min-w-0 items-center gap-0.5">
            {summary === undefined ? (
              <StateBadge state="off">
                {t('label.unavailable', { kind: 'agent' })}
              </StateBadge>
            ) : (
              <RecordLabel
                variant="row"
                summary={summary}
                href={recordHref?.(id)}
              />
            )}
            {comma}
          </span>
        );
      })}
    </span>
  );
}

/** «Sentry · Jira ⊖ у вас недоступна», «без систем» or «все системы» (definition-view.md, part 4). */
function Servers({
  servers,
  missing,
}: {
  servers: readonly string[];
  missing: readonly string[];
}) {
  const t = useTranslations('library');
  if (servers.includes(ALL_SERVERS)) return <>{t('team.allServers')}</>;
  if (servers.length === 0) return <>{t('team.noServers')}</>;
  return (
    <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
      {servers.map((server, index) => (
        <span key={server} className="inline-flex items-center gap-1.5">
          {index > 0 && (
            <span aria-hidden className="text-muted-foreground">
              ·
            </span>
          )}
          {server}
          {missing.includes(server) && (
            <StateBadge state="off">{t('agentFields.unavailable')}</StateBadge>
          )}
        </span>
      ))}
    </span>
  );
}

/**
 * «Способности» (definition-view.md, part 13; deep-agents UXRD MC-27): the record's switched-on capabilities in words
 * through « · », «нет» when none is on. List delegation is a deep agent's only, so others pass no `listDelegation`.
 */
function CapabilitiesRow({
  taskList,
  listDelegation = false,
}: {
  taskList: boolean;
  listDelegation?: boolean;
}) {
  const t = useTranslations('library.definition');
  const names = [
    ...(taskList ? [t('capability.taskList')] : []),
    ...(listDelegation ? [t('capability.listDelegation')] : []),
  ];
  return (
    <Row label={t('capabilities')}>
      {names.length === 0 ? t('capability.none') : names.join(' · ')}
    </Row>
  );
}

type DeepAgentRowsProps = {
  description: string;
  content: DeepAgentContent;
  missingRights: readonly MissingRight[];
  variant: DefinitionViewVariant;
  marks: Marks;
  modelNames?: ModelNames;
  /** The row «Скиллы», right after «Системы». */
  skills: ReactNode;
};

/** Parts 1–4 and 6–11 of a deep agent: the brief phrase stands before the team, the deep agent's own model last. */
function DeepAgentRows({
  description,
  content,
  missingRights,
  variant,
  marks,
  modelNames,
  skills,
}: DeepAgentRowsProps) {
  const t = useTranslations('formats');
  const tLibrary = useTranslations('library');
  return (
    <>
      <dl className="flex flex-col gap-2">
        <DescriptionRow description={description} marks={marks} />
      </dl>
      <p className={CAPTION}>{tLibrary('definition.brief')}</p>
      <dl className="flex flex-col gap-2">
        <Row
          label={tLibrary('fields.prompt')}
          changed={marks.changed('prompt')}
        >
          <LongText text={content.prompt} collapsible={variant !== 'page'} />
        </Row>
        <Row
          label={tLibrary('fields.servers')}
          changed={marks.changed('servers')}
        >
          <Servers
            servers={content.servers}
            missing={missingServers(missingRights, null)}
          />
          <RemovedLine names={marks.removed('servers')} />
        </Row>
        {skills}
        <CapabilitiesRow
          taskList={content.taskList}
          listDelegation={content.listDelegation}
        />
        <Row
          label={tLibrary('team.title', { count: content.subagents.length })}
        >
          <Team
            content={content}
            missingRights={missingRights}
            variant={variant}
            marks={marks}
            modelNames={modelNames}
          />
        </Row>
        <Row
          label={tLibrary('definition.finalSubagent')}
          changed={marks.changed('finalSubagent')}
        >
          {content.finalSubagent ?? tLibrary('definition.agentItself')}
        </Row>
        <Row
          label={tLibrary('definition.deepAgent')}
          changed={marks.changed('model') || marks.changed('maxTurns')}
        >
          <span className="tabular-nums">
            {tLibrary('definition.deepAgentSummary', {
              model: formatRecordModel(t, content.model, modelNames),
              maxTurns: content.maxTurns,
            })}
          </span>
        </Row>
      </dl>
    </>
  );
}

type TeamProps = {
  content: DeepAgentContent;
  missingRights: readonly MissingRight[];
  variant: DefinitionViewVariant;
  marks: Marks;
  modelNames?: ModelNames;
};

/** The team as a set, not a queue: subagents in alphabetical order, without numbers or arrows. */
function Team({
  content,
  missingRights,
  variant,
  marks,
  modelNames,
}: TeamProps) {
  const listId = useId();
  const t = useTranslations('library.team');
  const locale = useLocale();
  const [details, setDetails] = useState(variant === 'page');
  const subagents = [...content.subagents].sort((a, b) =>
    a.name.localeCompare(b.name, locale),
  );

  return (
    <div className="flex flex-col gap-1">
      <span className={CAPTION}>{t('hint')}</span>
      <ul
        id={listId}
        aria-label={t('listLabel')}
        className="flex flex-col gap-1"
      >
        {subagents.map((subagent) => (
          <SubagentItem
            key={subagent.name}
            subagent={subagent}
            final={subagent.name === content.finalSubagent}
            missing={missingServers(missingRights, subagent.name)}
            details={details}
            mark={marks.subagent(subagent.name)}
            modelNames={modelNames}
          />
        ))}
      </ul>
      <RemovedLine names={marks.removedSubagents} />
      <Disclosure
        expanded={details}
        controls={listId}
        onToggle={() => setDetails((open) => !open)}
      >
        {t('details')}
      </Disclosure>
    </div>
  );
}

type SubagentItemProps = {
  subagent: Subagent;
  final: boolean;
  missing: readonly string[];
  details: boolean;
  mark: SubagentMark | null;
  modelNames?: ModelNames;
};

function SubagentItem({
  subagent,
  final,
  missing,
  details,
  mark,
  modelNames,
}: SubagentItemProps) {
  const t = useTranslations('formats');
  const tLibrary = useTranslations('library');
  const changedIn = (field: SubagentField): boolean =>
    mark?.fields.includes(field) === true;
  return (
    <li className="flex flex-col gap-1">
      <span className="flex min-w-0 items-center gap-1.5">
        <span
          className="min-w-0 truncate"
          title={`${subagent.name} — ${subagent.description}`}
        >
          <span className="font-medium">{subagent.name}</span>
          <span className="text-muted-foreground">
            {' '}
            — {subagent.description}
          </span>
        </span>
        {final && (
          <StateBadge variant="source">{tLibrary('team.final')}</StateBadge>
        )}
        {mark !== null && <ChangeBadge change={mark.change} />}
      </span>
      {details && (
        <dl className="border-border ml-1 flex flex-col gap-2 border-l pl-3">
          <Row label={tLibrary('fields.model')} changed={changedIn('model')}>
            {formatRecordModel(t, subagent.model, modelNames)}
          </Row>
          <Row
            label={tLibrary('fields.servers')}
            changed={changedIn('servers')}
          >
            <Servers servers={subagent.servers} missing={missing} />
          </Row>
          <CapabilitiesRow taskList={subagent.taskList} />
          <Row label={tLibrary('team.maxRuns')} changed={changedIn('maxRuns')}>
            <span className="tabular-nums">
              {tLibrary('team.upTo', { count: subagent.maxRuns })}
            </span>
          </Row>
          <Row label={tLibrary('fields.prompt')} changed={changedIn('prompt')}>
            <LongText text={subagent.prompt} collapsible />
          </Row>
        </dl>
      )}
    </li>
  );
}

/**
 * Variant «Схема» (definition-view.md, parts 1, 4, 7, 8, 14): the description without a label, the servers and,
 * for a deep agent, the team with each subagent's servers under it; labels above values, nothing truncated. No
 * instructions, models or details: those are on the record's card the panel links to.
 */
function SchemaRows({
  definition,
  missingRights,
}: Pick<DefinitionViewProps, 'missingRights'> & {
  definition: { readonly description: string } & StartableBody;
}) {
  const tLibrary = useTranslations('library');
  const locale = useLocale();
  const subagents =
    definition.kind === 'deep_agent'
      ? [...definition.content.subagents].sort((a, b) =>
          a.name.localeCompare(b.name, locale),
        )
      : [];
  return (
    <div className="flex flex-col gap-2">
      <p className="text-foreground text-sm leading-5 break-words whitespace-pre-wrap">
        {definition.description === '' ? '—' : definition.description}
      </p>
      <dl className="flex flex-col gap-2">
        <Row label={tLibrary('fields.servers')} stacked>
          <Servers
            servers={definition.content.servers}
            missing={missingServers(missingRights, null)}
          />
        </Row>
        {definition.kind === 'deep_agent' && (
          <Row
            label={tLibrary('team.title', { count: subagents.length })}
            stacked
          >
            <ul
              aria-label={tLibrary('team.listLabel')}
              className="flex flex-col gap-1"
            >
              {subagents.map((subagent) => (
                <li key={subagent.name} className="flex flex-col">
                  <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                    <span className="min-w-0 break-words">
                      <span className="font-medium">{subagent.name}</span>
                      <span className="text-muted-foreground">
                        {' '}
                        — {subagent.description}
                      </span>
                    </span>
                    {subagent.name === definition.content.finalSubagent && (
                      <StateBadge variant="source">
                        {tLibrary('team.final')}
                      </StateBadge>
                    )}
                  </span>
                  <span className={cn(CAPTION, 'pl-3')}>
                    <Servers
                      servers={subagent.servers}
                      missing={missingServers(missingRights, subagent.name)}
                    />
                  </span>
                </li>
              ))}
            </ul>
          </Row>
        )}
      </dl>
    </div>
  );
}

/**
 * The author's long text with their paragraphs and line breaks, as text. Collapsible — six lines
 * and «Показать целиком», and no button when the text is shorter.
 */
function LongText({
  text,
  collapsible,
}: {
  text: string;
  collapsible: boolean;
}) {
  const textId = useId();
  const t = useTranslations('library.definition');
  const ref = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!collapsible || element === null) return;
    setOverflows(element.scrollHeight > element.clientHeight);
  }, [collapsible, text]);

  const clamped = collapsible && !expanded;
  return (
    <div className="flex flex-col items-start gap-1">
      <p
        ref={ref}
        id={textId}
        className={cn(
          'text-foreground text-base leading-6.5 break-words whitespace-pre-wrap',
          clamped && 'line-clamp-6',
        )}
      >
        {text === '' ? '—' : text}
      </p>
      {collapsible && (overflows || expanded) && (
        <Disclosure
          expanded={expanded}
          controls={textId}
          onToggle={() => setExpanded((open) => !open)}
        >
          {t(expanded ? 'collapse' : 'expand')}
        </Disclosure>
      )}
    </div>
  );
}

type DisclosureProps = {
  expanded: boolean;
  controls: string;
  onToggle: () => void;
  children: ReactNode;
};

function Disclosure({
  expanded,
  controls,
  onToggle,
  children,
}: DisclosureProps) {
  return (
    <Button
      variant="ghost"
      size="sm"
      aria-expanded={expanded}
      aria-controls={controls}
      onClick={onToggle}
    >
      <ChevronDown
        aria-hidden
        className={cn(
          'transition-transform duration-150 motion-reduce:transition-none',
          expanded && 'rotate-180',
        )}
      />
      {children}
    </Button>
  );
}

/** Servers of the agent or the deep agent itself (`subagent` `null`), or of one subagent, the viewer has no right to. */
function missingServers(
  missingRights: readonly MissingRight[],
  subagent: string | null,
): string[] {
  return missingRights
    .filter((right) => right.subagent === subagent)
    .flatMap((right) => right.servers);
}
