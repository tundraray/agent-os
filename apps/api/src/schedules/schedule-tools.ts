import { HttpException } from '@nestjs/common';
import type { InCommitAgentTool } from '@agent-os/agents';
import type { Logger } from '@agent-os/common';
import type { Clock } from '@agent-os/runtime';
import {
  ApiErrorSchema,
  LIST_SCHEDULES_TOOL,
  MANAGE_SCHEDULE_TOOL,
  SCHEDULE_ACCESS_DROPPED_LINE,
  ScheduleAccessSchema,
  type ScheduleBody,
  SchedulesErrorCodeSchema,
  type ScheduleToolArgs,
  ScheduleToolArgsSchema,
  type ScheduleView,
  type ToolRefusalReason,
} from '@agent-os/contracts';
import { z } from 'zod';
import type { SchedulesService } from './schedules.service';

// ---------- Descriptions ----------

const LIST_DESCRIPTION = [
  "List the employee's schedules and the current local date, day of the week and time.",
  'For each schedule: id, name, state, rule with its time zone, next run, agent, where it replies, access level and instruction.',
  'Call it before manage_schedule: to find the schedule the employee means, to count dates like "tomorrow" from the local time, and to see whether such a schedule already exists.',
].join('\n');

const MANAGE_DESCRIPTION = [
  "Create, change, pause, resume or delete one of the employee's schedules. It is done at once, without a confirmation.",
  'Before create, call list_schedules and do not create a schedule the list already has.',
  'A rule is in local time of the schedule\'s time zone: {kind:"once",date:"YYYY-MM-DD",time:"HH:MM"}, {kind:"daily",time}, {kind:"weekdays",days:[1..7, 1 is Monday],time}, {kind:"every_hours",hours}.',
  'A new schedule takes the time zone list_schedules shows unless the employee named another; a change keeps the zone unless you pass timeZone.',
  'change: pass scheduleId and only the fields that change. pause, resume, delete: pass only scheduleId.',
  'A schedule made or changed here only reads when it runs: a change it would make is described in its answer. Full access, where a run makes changes without a person, is given only by the employee in the schedule form; a change here sets a schedule back to read.',
  'The result starts with "Schedule <id>: <name>"; tell the employee the name and the next run.',
].join('\n');

/** KD-4: what the model reads for a call in a schedule's run. */
const UNATTENDED_TEXT =
  'Only the employee can change schedules: in words in the conversation or in the schedule form. This run was started by a schedule, so nothing was changed.';

/** One text for a malformed, missing, another's and deleted id: the chat learns nothing of other schedules. */
const NOT_FOUND_TEXT =
  'scheduleId: there is no schedule with this id among your schedules';

// ---------- Text ----------

const WEEKDAYS = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
] as const;

/** `YYYY-MM-DD HH:MM, <weekday>` of an instant in a time zone. */
function localTime(instant: Date, timeZone: string): string {
  const local = Temporal.Instant.fromEpochMilliseconds(
    instant.getTime(),
  ).toZonedDateTimeISO(timeZone);
  const time = local.toPlainTime().toString({ smallestUnit: 'minute' });
  return `${local.toPlainDate().toString()} ${time}, ${WEEKDAYS[local.dayOfWeek - 1]}`;
}

function nextRunLine(view: ScheduleView): string {
  if (view.nextRunAt === null)
    return `No next run: the schedule is ${view.state}.`;
  return `Next run: ${localTime(new Date(view.nextRunAt), view.timeZone)} (${view.timeZone}).`;
}

function scheduleText(view: ScheduleView): string {
  return [
    `- id: ${view.id}`,
    `  name: ${view.name}`,
    `  state: ${view.state}${view.pausedBecause === null ? '' : ` (${view.pausedBecause})`}`,
    `  rule: ${JSON.stringify(view.rule)} in ${view.timeZone}`,
    `  next run: ${view.nextRunAt === null ? 'none' : localTime(new Date(view.nextRunAt), view.timeZone)}`,
    `  agent: ${view.agent === null ? 'the chat agent' : `${view.agent.id} ${view.agent.name}${view.agent.available ? '' : ' (unavailable)'}`}`,
    `  replies: ${view.target === 'this_conversation' && view.conversation !== null ? `this_conversation ${view.conversation.id}${view.conversation.deleted ? ' (deleted)' : ''}` : view.target}`,
    `  access: ${view.access}`,
    `  instruction: ${view.instruction}`,
  ].join('\n');
}

// ---------- Refusals ----------

type Refused = {
  readonly kind: 'refused';
  readonly reason: ToolRefusalReason;
  readonly text: string;
};

/**
 * The refusal of a service error (Contract Definitions «Отказы инструмента»): the model reads the field and the rule.
 * Anything else than the service's own answer is thrown on.
 */
function refusalOf(error: unknown): Refused {
  if (!(error instanceof HttpException)) throw error;
  const answer = ApiErrorSchema.parse(error.getResponse());
  const code = SchedulesErrorCodeSchema.parse(answer.errorCode);
  const refused = (reason: ToolRefusalReason, text: string): Refused => ({
    kind: 'refused',
    reason,
    text,
  });
  switch (code) {
    case 'SCHEDULE_NOT_FOUND':
      return refused('invalid_arguments', NOT_FOUND_TEXT);
    case 'RECORD_NOT_FOUND':
      return refused(
        'agent_not_visible',
        'agentId: there is no agent with this id among the agents the employee can choose in «+»',
      );
    case 'THREAD_NOT_FOUND':
      return refused(
        'invalid_arguments',
        'target: this conversation cannot take the runs of a schedule; use new_conversation',
      );
    case 'SCHEDULE_NOT_RUNNABLE':
      return refused(
        'invalid_arguments',
        'scheduleId: this schedule cannot be resumed: it is completed, or its conversation is deleted and it needs a change first',
      );
    case 'VALIDATION_FAILED':
    case 'INVALID_CURSOR':
      return refused('invalid_arguments', [answer.message].flat().join('; '));
  }
}

// ---------- Tools ----------

export interface ScheduleToolsOptions {
  readonly schedules: Pick<
    SchedulesService,
    | 'list'
    | 'get'
    | 'create'
    | 'update'
    | 'pause'
    | 'resume'
    | 'delete'
    | 'savedBody'
    | 'chatDefaults'
  >;
  readonly clock: Clock;
  readonly logger: Logger;
}

/** The ids of a call and its caller, for the log. */
interface CallIds {
  readonly ownerId: string;
  readonly agentId: string;
  readonly rootId: string;
  readonly callId: string;
}

function callIds(
  caller: { ownerId: string; agentId: string; rootId: string },
  callId: string,
): CallIds {
  return {
    ownerId: caller.ownerId,
    agentId: caller.agentId,
    rootId: caller.rootId,
    callId,
  };
}

const ListSchedulesArgsSchema = z.object({});

/**
 * `list_schedules` and `manage_schedule` of the main chat (chat-scheduling design-server.md, KD-1, KD-2, KD-4 –
 * KD-6): built-in, `rootOnly` and `in_commit`, so the schedule row and the call's result commit together with the
 * step. Each is a thin adapter over `SchedulesService`, the methods the form's routes call: the rule, the agent, the
 * conversation, the zone and the access level are checked there. Both act for `caller.ownerId` only. The log names
 * the employee, the agent, the call, the action, the schedule, the outcome and the reason, never the instruction.
 */
export function createScheduleTools(options: ScheduleToolsOptions) {
  const { schedules } = options;
  const logger = options.logger.child({ service: 'schedules.chat_tools' });

  function logOutcome(
    call: CallIds,
    tool: string,
    fields: {
      readonly action?: string;
      readonly scheduleId?: string | null;
      readonly outcome: string;
      readonly reason?: string;
      readonly accessDropped?: boolean;
    },
  ): void {
    logger.info('schedule tool call', {
      ...call,
      tool,
      action: fields.action ?? null,
      scheduleId: fields.scheduleId ?? null,
      outcome: fields.outcome,
      reason: fields.reason ?? null,
      accessDropped: fields.accessDropped ?? false,
    });
  }

  const listSchedules: InCommitAgentTool<
    z.infer<typeof ListSchedulesArgsSchema>,
    string
  > = {
    name: LIST_SCHEDULES_TOOL,
    description: LIST_DESCRIPTION,
    argsSchema: ListSchedulesArgsSchema,
    mode: 'in_commit',
    rootOnly: true,
    async prepare({ caller }) {
      const { timeZone } = await schedules.chatDefaults(caller.ownerId);
      const list = (await schedules.list(caller.ownerId)).schedules;
      return [
        `Now: ${localTime(options.clock.now(), timeZone)} (${timeZone})`,
        list.length === 0
          ? 'Schedules: none'
          : `Schedules (${list.length}):\n${list.map(scheduleText).join('\n')}`,
      ].join('\n');
    },
    async execute({ caller, callId, prepared }) {
      if (prepared === undefined)
        throw new Error(
          `${LIST_SCHEDULES_TOOL} of agent ${caller.agentId} runs without its prepare`,
        );
      logOutcome(callIds(caller, callId), LIST_SCHEDULES_TOOL, {
        outcome: 'success',
      });
      return { kind: 'done', outcome: 'success', text: prepared };
    },
  };

  /** The body of a change: the saved one with the named fields over it (KD-1), always `read` (KD-2). */
  async function changeBody(
    args: ScheduleToolArgs & { readonly scheduleId: string },
    caller: CallIds,
  ): Promise<{ body: ScheduleBody; was: ScheduleBody }> {
    const saved = await schedules.savedBody(args.scheduleId, caller.ownerId);
    const was = saved.body;
    // KD-6: a target names the conversation of the call; without one a deleted conversation moves to it (AC-05.5).
    const target =
      args.target ??
      (was.target === 'this_conversation' && saved.conversationDeleted
        ? 'this_conversation'
        : undefined);
    const place =
      target === undefined
        ? { target: was.target, conversationId: was.conversationId }
        : {
            target,
            conversationId:
              target === 'this_conversation' ? caller.rootId : null,
          };
    return {
      was,
      body: {
        name: args.name ?? was.name,
        instruction: args.instruction ?? was.instruction,
        agentId: args.agentId === undefined ? was.agentId : args.agentId,
        rule: args.rule ?? was.rule,
        timeZone: args.timeZone ?? was.timeZone,
        ...place,
        language: was.language,
        access: ScheduleAccessSchema.enum.read,
      },
    };
  }

  /** Runs the action through the service; the result's first line names the schedule. */
  async function act(
    args: ScheduleToolArgs,
    caller: CallIds,
  ): Promise<{ text: string; scheduleId: string; accessDropped: boolean }> {
    const head = (view: { id: string; name: string }) =>
      `Schedule ${view.id}: ${view.name}`;
    if (args.action === 'create') {
      const { instruction, rule, target } = args;
      if (
        instruction === undefined ||
        rule === undefined ||
        target === undefined
      )
        throw new Error(
          'create arguments passed the schema without their required fields',
        );
      const defaults = await schedules.chatDefaults(caller.ownerId);
      const view = await schedules.create(caller.ownerId, {
        ...(args.name === undefined ? {} : { name: args.name }),
        instruction,
        agentId: args.agentId ?? null,
        rule,
        timeZone: args.timeZone ?? defaults.timeZone,
        target,
        conversationId: target === 'this_conversation' ? caller.rootId : null,
        language: defaults.language,
        access: ScheduleAccessSchema.enum.read,
      });
      return {
        text: [head(view), `Created. ${nextRunLine(view)}`].join('\n'),
        scheduleId: view.id,
        accessDropped: false,
      };
    }
    const { scheduleId } = args;
    if (scheduleId === undefined)
      throw new Error(
        `${args.action} arguments passed the schema without scheduleId`,
      );
    switch (args.action) {
      case 'change': {
        const { body, was } = await changeBody({ ...args, scheduleId }, caller);
        const view = await schedules.update(scheduleId, caller.ownerId, body);
        const accessDropped = was.access === ScheduleAccessSchema.enum.full;
        return {
          text: [
            head(view),
            ...(accessDropped ? [SCHEDULE_ACCESS_DROPPED_LINE] : []),
            `Changed. ${nextRunLine(view)}`,
          ].join('\n'),
          scheduleId,
          accessDropped,
        };
      }
      case 'pause': {
        const view = await schedules.pause(scheduleId, caller.ownerId);
        return {
          text: [head(view), 'Paused.'].join('\n'),
          scheduleId,
          accessDropped: false,
        };
      }
      case 'resume': {
        const view = await schedules.resume(scheduleId, caller.ownerId);
        return {
          text: [head(view), `Resumed. ${nextRunLine(view)}`].join('\n'),
          scheduleId,
          accessDropped: false,
        };
      }
      case 'delete': {
        const view = await schedules.get(scheduleId, caller.ownerId);
        await schedules.delete(scheduleId, caller.ownerId);
        return {
          text: [head(view), 'Deleted.'].join('\n'),
          scheduleId,
          accessDropped: false,
        };
      }
    }
  }

  const manageSchedule: InCommitAgentTool<ScheduleToolArgs> = {
    name: MANAGE_SCHEDULE_TOOL,
    description: MANAGE_DESCRIPTION,
    argsSchema: ScheduleToolArgsSchema,
    mode: 'in_commit',
    rootOnly: true,
    // The instruction is the employee's text: only what names the call goes to the log.
    loggedArgs: ({ action, scheduleId, rule, target }) => ({
      action,
      scheduleId,
      ruleKind: rule?.kind,
      target,
    }),
    async execute({ args, caller, callId }) {
      const call = callIds(caller, callId);
      const fields = {
        action: args.action,
        scheduleId: args.scheduleId ?? null,
      };
      // KD-4: a schedule's run changes no schedule, at any access level.
      if (caller.scheduleId !== null) {
        logOutcome(call, MANAGE_SCHEDULE_TOOL, {
          ...fields,
          outcome: 'refused',
          reason: 'unattended',
        });
        return { kind: 'refused', reason: 'unattended', text: UNATTENDED_TEXT };
      }
      try {
        const done = await act(args, call);
        logOutcome(call, MANAGE_SCHEDULE_TOOL, {
          ...fields,
          scheduleId: done.scheduleId,
          outcome: 'success',
          accessDropped: done.accessDropped,
        });
        return { kind: 'done', outcome: 'success', text: done.text };
      } catch (error) {
        const refused = refusalOf(error);
        logOutcome(call, MANAGE_SCHEDULE_TOOL, {
          ...fields,
          outcome: 'refused',
          reason: refused.reason,
        });
        return refused;
      }
    },
  };

  return [listSchedules, manageSchedule] as const;
}
