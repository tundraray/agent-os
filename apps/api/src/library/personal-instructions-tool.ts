import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { type InCommitAgentTool, ToolRegistry } from '@agent-os/agents';
import { LOGGER, type Logger } from '@agent-os/common';
import {
  IDENTITY_INSTRUCTIONS_CONFIRMATION,
  INSTRUCTIONS_MAX_LENGTH,
  SET_PERSONAL_INSTRUCTIONS_TOOL,
  type SetPersonalInstructionsArgs,
  SetPersonalInstructionsArgsSchema,
} from '@agent-os/contracts';
import { UsersService } from '../identity/users.service';

/** What the model reads of the tool (agent-guidance AC-04.7). */
const DESCRIPTION = [
  'Replace the personal instruction of the employee you talk to: the text every agent working for them gets in its system prompt.',
  'Its current text is in your system prompt after the line "Instructions from the employee you work for:"; without that line it is empty.',
  `Pass the whole new text (at most ${INSTRUCTIONS_MAX_LENGTH} characters), the lines to keep included: it replaces the old one. An empty text removes it.`,
  'The employee sees the text on a card, may edit it, and it is saved only when they confirm.',
].join('\n');

/**
 * `set_personal_instructions` (agent-guidance design-server.md, KD-8, Flow 5): the main chat's only, `rootOnly`;
 * the card `identity.instructions` shows `{text}`, which the employee may edit. On his approval the step sends the
 * call with the arguments of the decision, and the tool writes that text into the caller's own row — no argument
 * names an employee (AC-04.8). Neither the result nor the log carries the text, only its length (AC-04.3); in a
 * schedule's run the call rule refuses it `unattended` before the card.
 */
export function createPersonalInstructionsTool(deps: {
  readonly users: Pick<UsersService, 'setOwnInstructions'>;
  readonly logger: Logger;
}): InCommitAgentTool<SetPersonalInstructionsArgs> {
  const logger = deps.logger.child({ service: 'identity.instructions' });
  return {
    name: SET_PERSONAL_INSTRUCTIONS_TOOL,
    description: DESCRIPTION,
    argsSchema: SetPersonalInstructionsArgsSchema,
    mode: 'in_commit',
    rootOnly: true,
    loggedArgs: ({ text }) => ({ textChars: text.length }),
    confirmation: {
      kind: IDENTITY_INSTRUCTIONS_CONFIRMATION,
      content: ({ text }) => ({ text }),
      editableArgs: true,
    },
    async execute({ args, caller, callId }) {
      await deps.users.setOwnInstructions(caller.ownerId, args.text);
      logger.info('personal instructions set by the chat', {
        ownerId: caller.ownerId,
        agentId: caller.agentId,
        callId,
        textChars: args.text.length,
      });
      return {
        kind: 'done',
        outcome: 'success',
        text: `Saved: the personal instruction is now ${args.text.length} characters long.`,
      };
    },
  };
}

/** Registers `set_personal_instructions` in the tools library of the agents in `onModuleInit`. */
@Injectable()
export class PersonalInstructionsToolRegistration implements OnModuleInit {
  constructor(
    @Inject(ToolRegistry) private readonly registry: ToolRegistry,
    private readonly users: UsersService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  onModuleInit(): void {
    this.registry.register(
      createPersonalInstructionsTool({
        users: this.users,
        logger: this.logger,
      }),
    );
  }
}
