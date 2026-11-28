import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import {
  AgentsMcp,
  inRootLaunchSet,
  signalConversation,
  testRunPoolWrite,
  ToolRegistry,
  type InCommitAgentTool,
  type OutsideAgentTool,
} from '@agent-os/agents';
import { LOGGER, type Logger } from '@agent-os/common';
import {
  type ChipRecord,
  CreateRecordBodySchema,
  DEEP_AGENT_SUBAGENTS_MAX,
  DEEP_AGENT_SUBAGENTS_MIN,
  DeepAgentContentSchema,
  IdSchema,
  isStartable,
  RECORD_MAX_TURNS_MIN,
  SessionTaskStatusSchema,
  TEST_RUN_PLAN_REVISIONS_MAX,
  TEST_RUN_TESTS_MAX,
  TEST_RUN_TOOLS,
  TEST_TEXT_MAX_CHARS,
} from '@agent-os/contracts';
import {
  AgentsRepository,
  ConversationsRepository,
  ConversationTasksRepository,
  MessagesRepository,
  RuntimeTasksRepository,
  type TrainingRow,
  TrainingsRepository,
} from '@agent-os/db';
import { z } from 'zod';
import { IdentityDirectory } from '../identity/identity-directory';
import { SettingsService } from '../settings/settings.service';
import { planAnswered } from '../training/test-run-rules';
import { LibraryChatService } from './library-chat.service';
import { LibraryService } from './library.service';
import type { ChatContext, ChatReview } from './library.types';
import { recordListText } from './record-listing';
import { contextOf, refusalOf } from './record-tools';

const [
  LIBRARY_OVERVIEW_TOOL,
  OFFER_AGENT_TOOL,
  TAKE_AGENT_TOOL,
  PROPOSE_PLAN_TOOL,
  CREATE_AGENT_TOOL,
] = TEST_RUN_TOOLS;

/** Runs of a subagent within one run of the agent: the code's constant, no setting holds it (KD-3). */
const SUBAGENT_MAX_RUNS = 3;
const AGENT_TASK = 1;
/** The longest reason of an offer: one or two sentences (design-trainer-dialog.md, KD-4). */
const OFFER_WHY_MAX = 500;

const [, deepAgentBodySchema] = CreateRecordBodySchema.options;
const content = DeepAgentContentSchema.shape;
const subagent = content.subagents.element.shape;

/** The fields of the deep agent the model gives; everything else is set by code (design-test-run.md, KD-3). */
interface AgentFields {
  readonly name: string;
  readonly description: string;
  readonly prompt: string;
  readonly servers: readonly string[];
  readonly subagents: readonly {
    readonly name: string;
    readonly description: string;
    readonly prompt: string;
    readonly servers: readonly string[];
  }[];
}

/** The deep agent's content from the model's fields, unchecked. */
function contentOf(fields: AgentFields, maxTurns: number) {
  return {
    prompt: fields.prompt,
    servers: [...fields.servers],
    model: null,
    maxTurns,
    subagents: fields.subagents.map((member) => ({
      ...member,
      servers: [...member.servers],
      model: null,
      maxTurns,
      maxRuns: SUBAGENT_MAX_RUNS,
    })),
    finalSubagent: null,
  };
}

const CreateAgentArgsShape = z.object({
  name: deepAgentBodySchema.shape.name.describe('The agent name of the plan'),
  description: deepAgentBodySchema.shape.description.describe(
    'When to use the agent, one or two sentences',
  ),
  prompt: content.prompt,
  servers: content.servers.describe(
    'Names of servers of the plan the agent itself needs',
  ),
  subagents: z
    .array(
      z.object({
        name: subagent.name,
        description: subagent.description.describe('When to call it'),
        prompt: subagent.prompt,
        servers: subagent.servers.describe(
          'Names of servers of the plan this subagent needs',
        ),
      }),
    )
    .min(DEEP_AGENT_SUBAGENTS_MIN)
    .max(DEEP_AGENT_SUBAGENTS_MAX),
});
type CreateAgentArgs = z.infer<typeof CreateAgentArgsShape>;

/** The deep agent's own rules — repeated or reserved subagent names — asked of the contract, with its paths. */
const CreateAgentArgsSchema = CreateAgentArgsShape.superRefine((args, ctx) => {
  const checked = DeepAgentContentSchema.safeParse(
    contentOf(args, RECORD_MAX_TURNS_MIN),
  );
  if (checked.success) return;
  for (const issue of checked.error.issues)
    if (issue.code === 'custom')
      ctx.addIssue({
        code: 'custom',
        path: issue.path,
        message: issue.message,
      });
});

const testText = (what: string) =>
  z.string().trim().min(1).max(TEST_TEXT_MAX_CHARS).describe(what);

const ProposePlanArgsSchema = z.object({
  name: deepAgentBodySchema.shape.name.describe(
    'The name of the new agent, unique among the employee’s records',
  ),
  description: deepAgentBodySchema.shape.description.describe(
    'One sentence: what the agent does',
  ),
  servers: content.servers.describe(
    'Names of servers from library_overview the agent and its subagents will need',
  ),
  tests: z
    .array(
      z.object({
        task: testText('A task the employee could give the agent'),
        expected: testText('The result the employee expects'),
      }),
    )
    .min(1)
    .max(TEST_RUN_TESTS_MAX),
});
type ProposePlanArgs = z.infer<typeof ProposePlanArgsSchema>;

const OfferAgentArgsSchema = z.object({
  agentId: IdSchema.describe(
    'The id of the agent, as library_overview lists it',
  ),
  why: z
    .string()
    .trim()
    .min(1)
    .max(OFFER_WHY_MAX)
    .describe('One or two sentences: how this agent fits the task'),
});
type OfferAgentArgs = z.infer<typeof OfferAgentArgsSchema>;

const NoArgsSchema = z.object({}).strict();

const LIBRARY_OVERVIEW_DESCRIPTION =
  'List the agents the employee can start from the chat — id, kind, name, whose, sharing, description — then the MCP servers he may use with the tools he has the right to call.';

const OFFER_AGENT_DESCRIPTION =
  'Offer the employee one agent from library_overview that already does what he needs, with one or two sentences on how it fits. Once per test run and only before the plan.';

const TAKE_AGENT_DESCRIPTION =
  'Call when the employee answers that he takes the offered agent; nothing else. The test run then ends and the employee continues with that agent.';

const PROPOSE_PLAN_DESCRIPTION = [
  `Send the plan of the new agent: its name, one sentence on what it does, the servers from library_overview it needs and 1 to ${TEST_RUN_TESTS_MAX} tests.`,
  'Each test is a task the employee could give the agent and the result he expects; every example task from the description or the history is a test.',
  `A corrected plan only after the employee answered the last one; at most ${TEST_RUN_PLAN_REVISIONS_MAX} plans. The answer names the plan's revision.`,
].join(' ');

const CREATE_AGENT_DESCRIPTION = [
  'Create the new deep agent exactly by the last plan, once, after the employee answered it (or right after the third plan):',
  `the plan's name, its description, a prompt, servers of the plan, and ${DEEP_AGENT_SUBAGENTS_MIN} to ${DEEP_AGENT_SUBAGENTS_MAX} subagents (name, when to call it,`,
  'prompt, servers of the plan); the platform sets the rest. It becomes the employee’s private record and the platform runs',
  'the plan’s tests. A refusal names the field and the rule: fix it and call again, or wait for the employee.',
].join('\n');

/** Who calls a tool: the trainer's tree and its starter. */
interface Caller {
  readonly rootId: string;
  readonly ownerId: string;
}

interface Prepared {
  readonly context: ChatContext;
  readonly reviewed: ChatReview;
}

type Refusal = {
  readonly kind: 'refused';
  readonly reason: 'invalid_arguments';
  readonly text: string;
};

const refused = (text: string): Refusal => ({
  kind: 'refused',
  reason: 'invalid_arguments',
  text,
});

/**
 * The test run's conversation tools (design-trainer-dialog.md, KD-3, KD-4, Flow 2, Flow 3; design-test-run.md, KD-3),
 * declared only by the trainer in its test-run mode: `library_overview` reads, `offer_agent` and `take_agent` mark the
 * row, `propose_plan` writes the plan and its tests into it, `create_agent` builds exactly the answered plan. The
 * name and the servers are checked by the rules of `create_record` on behalf of the starter outside the transaction;
 * the plan, the answer to it and the row in the step's commit.
 */
function createTestRunTools(deps: {
  readonly chatLibrary: LibraryChatService;
  readonly library: LibraryService;
  readonly identity: IdentityDirectory;
  readonly mcp: AgentsMcp;
  readonly settings: SettingsService;
  readonly trainingRows: TrainingsRepository;
  readonly agentRows: AgentsRepository;
  readonly sessionTaskRows: ConversationTasksRepository;
  readonly conversationRows: ConversationsRepository;
  readonly messageRows: MessagesRepository;
  readonly signals: RuntimeTasksRepository;
  readonly logger: Logger;
}) {
  const logger = deps.logger.child({ service: 'library.test_run_tools' });
  const contextDeps = {
    library: deps.chatLibrary,
    identity: deps.identity,
    mcp: deps.mcp,
  };

  /** The test run's row of the caller's tree. */
  async function rowOf(caller: Caller): Promise<TrainingRow> {
    const row = await deps.trainingRows.find(caller.rootId);
    if (row === undefined)
      throw new Error(`Test run ${caller.rootId} has no training row`);
    return row;
  }

  /** The check of a deep agent by the rules of `create_record` on behalf of the starter, without a write. */
  async function review(
    caller: Caller,
    fields: AgentFields,
  ): Promise<Prepared> {
    const [context, settings] = await Promise.all([
      contextOf(contextDeps, caller.ownerId),
      deps.settings.read('library_settings'),
    ]);
    const reviewed = await deps.chatLibrary.reviewChatChange(context, {
      action: 'create',
      system: false,
      record: {
        name: fields.name,
        description: fields.description,
        body: {
          kind: 'deep_agent',
          content: DeepAgentContentSchema.parse(
            contentOf(fields, settings.value.defaultMaxTurns),
          ),
        },
      },
    });
    return { context, reviewed };
  }

  const libraryOverview: OutsideAgentTool<Record<string, never>> = {
    name: LIBRARY_OVERVIEW_TOOL,
    description: LIBRARY_OVERVIEW_DESCRIPTION,
    argsSchema: NoArgsSchema,
    mode: 'outside',
    async execute({ caller }) {
      const [context, headers, servers] = await Promise.all([
        contextOf(contextDeps, caller.ownerId),
        deps.library.listVisible(caller.ownerId),
        deps.mcp.usableTools(caller.ownerId),
      ]);
      const launchable = new Set(
        headers.filter(inRootLaunchSet).map((header) => header.id),
      );
      const records = (await deps.chatLibrary.chatRecords(context)).filter(
        (record) => launchable.has(record.id),
      );
      return {
        kind: 'done',
        outcome: 'success',
        text: recordListText(records, servers),
      };
    },
  };

  const offerAgent: InCommitAgentTool<OfferAgentArgs, ChipRecord | null> = {
    name: OFFER_AGENT_TOOL,
    description: OFFER_AGENT_DESCRIPTION,
    argsSchema: OfferAgentArgsSchema,
    mode: 'in_commit',
    loggedArgs: ({ agentId }) => ({ agentId }),
    // The chip rule of a message: a record the starter's chat may start (DC-3).
    async prepare({ args, caller }) {
      const resolved = await deps.library.resolve(caller.ownerId, args.agentId);
      return resolved === null ||
        !isStartable(resolved) ||
        !inRootLaunchSet(resolved)
        ? null
        : { id: resolved.id, kind: resolved.kind, name: resolved.name };
    },
    async execute({ args, caller, callId, prepared }) {
      const row = await rowOf(caller);
      const call = { testRunId: row.id, callId, agentId: args.agentId };
      if (prepared == null) {
        logger.info('offer refused', { ...call, reason: 'not_launchable' });
        return refused(
          'agentId: no such agent among those library_overview lists.',
        );
      }
      if (
        row.offeredAgentId !== null ||
        !(await deps.trainingRows.setOffered(row.id, prepared.id))
      ) {
        logger.info('offer refused', { ...call, reason: 'offered_or_planned' });
        return refused(
          'An agent can be offered once per test run and only before the plan.',
        );
      }
      logger.info('agent offered', call);
      return {
        kind: 'done',
        outcome: 'success',
        text: `Offered: ${prepared.name}. Wait for the employee's answer.`,
      };
    },
  };

  const takeAgent: InCommitAgentTool<Record<string, never>> = {
    name: TAKE_AGENT_TOOL,
    description: TAKE_AGENT_DESCRIPTION,
    argsSchema: NoArgsSchema,
    mode: 'in_commit',
    async execute({ caller, callId }) {
      const row = await rowOf(caller);
      if (
        row.offeredAgentId === null ||
        row.plan !== null ||
        !(await deps.trainingRows.take(row.id))
      ) {
        logger.info('take refused', { testRunId: row.id, callId });
        return refused(
          'There is no offered agent to take: nothing was offered, the plan is sent or it is taken already.',
        );
      }
      logger.info('agent taken', {
        testRunId: row.id,
        callId,
        agentId: row.offeredAgentId,
      });
      return {
        kind: 'done',
        outcome: 'success',
        text: 'Taken: the test run ends, and the employee continues with that agent.',
      };
    },
  };

  const proposePlan: InCommitAgentTool<ProposePlanArgs, Prepared> = {
    name: PROPOSE_PLAN_TOOL,
    description: PROPOSE_PLAN_DESCRIPTION,
    argsSchema: ProposePlanArgsSchema,
    mode: 'in_commit',
    // The plan may carry the employee's data: only its size goes to the log.
    loggedArgs: (args) => ({
      servers: Array.isArray(args.servers) ? args.servers.length : null,
      tests: Array.isArray(args.tests) ? args.tests.length : null,
    }),
    // The name and the servers by the rules of `create_record`; the subagent only fills the content's minimum.
    prepare: ({ args, caller }) =>
      review(caller, {
        name: args.name,
        description: args.description,
        prompt: args.description,
        servers: args.servers,
        subagents: [
          {
            name: 'worker',
            description: args.description,
            prompt: args.description,
            servers: [],
          },
        ],
      }),
    async execute({ args, caller, callId, prepared }) {
      if (prepared === undefined)
        throw new Error(
          `${PROPOSE_PLAN_TOOL} of agent ${caller.agentId} runs without its prepare`,
        );
      const row = await rowOf(caller);
      const call = { testRunId: row.id, callId };
      const entries = await deps.messageRows.after(caller.rootId, 0);
      const revision = (row.plan?.revision ?? 0) + 1;
      if (
        row.agentId !== null ||
        revision > TEST_RUN_PLAN_REVISIONS_MAX ||
        (row.plan !== null && !planAnswered(entries, row.plan))
      ) {
        logger.info('plan refused', { ...call, revision });
        return refused(
          row.agentId !== null || revision > TEST_RUN_PLAN_REVISIONS_MAX
            ? 'The plan cannot change any more.'
            : 'Wait for the employee to answer the last plan.',
        );
      }
      if (prepared.reviewed.outcome === 'refused') {
        const refusal = refusalOf(prepared.reviewed);
        logger.info('plan refused', { ...call, reason: refusal.reason });
        return { kind: 'refused', ...refusal };
      }
      await deps.trainingRows.setPlan(
        row.id,
        {
          revision,
          name: args.name,
          description: args.description,
          servers: args.servers,
        },
        args.tests.map((test) => ({ ...test, rounds: [] })),
      );
      logger.info('plan proposed', {
        ...call,
        revision,
        tests: args.tests.length,
      });
      return {
        kind: 'done',
        outcome: 'success',
        text:
          revision === TEST_RUN_PLAN_REVISIONS_MAX
            ? `Plan revision ${revision}, the final one: create the agent by it now.`
            : `Plan revision ${revision}. Wait for the employee's answer before create_agent.`,
      };
    },
  };

  const createAgent: InCommitAgentTool<CreateAgentArgs, Prepared> = {
    name: CREATE_AGENT_TOOL,
    description: CREATE_AGENT_DESCRIPTION,
    argsSchema: CreateAgentArgsSchema,
    mode: 'in_commit',
    // The prompts are the employee's data: only the name goes to the log.
    loggedArgs: ({ name }) => ({ name }),
    prepare: ({ args, caller }) => review(caller, args),
    async execute({ args, caller, callId, prepared }) {
      if (prepared === undefined)
        throw new Error(
          `${CREATE_AGENT_TOOL} of agent ${caller.agentId} runs without its prepare`,
        );
      const call = {
        ownerId: caller.ownerId,
        testRunId: caller.rootId,
        callId,
      };
      const row = await rowOf(caller);
      const refusal = await planRefusal(row, args, caller);
      if (refusal !== null) {
        logger.info('create agent refused', { ...call, reason: 'plan' });
        return refused(refusal);
      }
      const saved =
        prepared.reviewed.outcome === 'refused'
          ? prepared.reviewed
          : await deps.chatLibrary.saveChatChange(
              prepared.context,
              prepared.reviewed.card,
            );
      if (saved.outcome === 'refused') {
        const answer = refusalOf(saved);
        logger.info('create agent refused', { ...call, reason: answer.reason });
        return { kind: 'refused', ...answer };
      }
      const agent = await deps.agentRows.findAny(saved.recordId);
      if (
        agent === undefined ||
        !(await deps.trainingRows.setAgent(row.id, {
          agentId: agent.id,
          baseVersionId: agent.versionId,
        }))
      )
        throw new Error(
          `Test run ${row.id} could not take its new agent ${saved.recordId}`,
        );
      await deps.sessionTaskRows.write(
        caller.agentId,
        testRunPoolWrite([
          [AGENT_TASK, SessionTaskStatusSchema.enum.completed],
        ]),
      );
      // A forked run keeps the fork's title (KD-6); a written title tells the owner's list (live-feed KD-2).
      if (
        (await deps.conversationRows.find(caller.rootId))?.forkedFromId ==
          null &&
        (await deps.conversationRows.renameRoot(
          caller.rootId,
          caller.ownerId,
          `Проверка «${args.name}»`,
        ))
      )
        await signalConversation(deps.signals, {
          ownerId: caller.ownerId,
          event: {
            type: 'change',
            data: { threadId: caller.rootId, kind: 'summary' },
          },
        });
      logger.info('agent created', { ...call, recordId: agent.id });
      return {
        kind: 'done',
        outcome: 'success',
        text: `Created: the deep agent ${agent.id}, version 1. The platform runs the plan's tests now.`,
      };
    },
  };

  /**
   * Why the agent may not be created by these arguments now (KD-3, DC-2), or `null`: once, by the last plan answered
   * by the employee or the third one, with the plan's name and only the plan's servers.
   */
  async function planRefusal(
    row: TrainingRow,
    args: CreateAgentArgs,
    caller: Caller,
  ): Promise<string | null> {
    const { plan } = row;
    if (row.agentId !== null) return 'The agent is created already.';
    if (plan === null) return 'Send the plan with propose_plan first.';
    if (
      plan.revision !== TEST_RUN_PLAN_REVISIONS_MAX &&
      !planAnswered(await deps.messageRows.after(caller.rootId, 0), plan)
    )
      return 'Wait for the employee to answer the plan.';
    if (args.name !== plan.name)
      return `name: the plan names the agent ${plan.name}.`;
    const outside = [
      ...args.servers,
      ...args.subagents.flatMap((member) => member.servers),
    ].filter((server) => !plan.servers.includes(server));
    return outside.length === 0
      ? null
      : `servers: ${[...new Set(outside)].join(', ')} not in the plan.`;
  }

  return [
    libraryOverview,
    offerAgent,
    takeAgent,
    proposePlan,
    createAgent,
  ] as const;
}

/** Registers the test run's conversation tools in the tools library of the agents, in `onModuleInit`. */
@Injectable()
export class TestRunToolsRegistration implements OnModuleInit {
  constructor(
    @Inject(ToolRegistry) private readonly registry: ToolRegistry,
    @Inject(AgentsMcp) private readonly mcp: AgentsMcp,
    private readonly chatLibrary: LibraryChatService,
    private readonly library: LibraryService,
    private readonly identity: IdentityDirectory,
    private readonly settings: SettingsService,
    private readonly trainingRows: TrainingsRepository,
    private readonly agentRows: AgentsRepository,
    private readonly sessionTaskRows: ConversationTasksRepository,
    private readonly conversationRows: ConversationsRepository,
    private readonly messageRows: MessagesRepository,
    private readonly signals: RuntimeTasksRepository,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  onModuleInit(): void {
    const tools = createTestRunTools({
      chatLibrary: this.chatLibrary,
      library: this.library,
      identity: this.identity,
      mcp: this.mcp,
      settings: this.settings,
      trainingRows: this.trainingRows,
      agentRows: this.agentRows,
      sessionTaskRows: this.sessionTaskRows,
      conversationRows: this.conversationRows,
      messageRows: this.messageRows,
      signals: this.signals,
      logger: this.logger,
    });
    for (const tool of tools) this.registry.register(tool);
  }
}
