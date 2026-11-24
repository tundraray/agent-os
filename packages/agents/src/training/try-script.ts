import {
  AGENTS_TOOL_CONFIRMATION,
  TRY_SCRIPT_TOOL,
  TryScriptArgsSchema,
  type TryScriptArgs,
} from '@agent-os/contracts';

import { canCallOf } from '../tools/external/can-call';
import type { RunCodeTool } from '../tools/external/run-code';
import type { OutsideAgentTool, ToolCaller } from '../tools/tool';
import type { ToolRegistry } from '../tools/tool-registry';
import type { TrainerToolsDeps } from './trainer-tools';
import { trainingBase } from './training-reads';

const DESCRIPTION = [
  'Run a draft script once, as the member that would own it — the trained agent itself (owner null) or one of its',
  "subagents by name — with that member's servers in the base version and the same limits as a saved script.",
  'Reads are sent; a changing call is recorded and not sent, and the result names the recorded tools.',
].join(' ');

/**
 * `try_script`, the trainer's trial run of a draft script (design-training.md, «Инструменты тренера»): the one code
 * run of `run_code` and the saved scripts, as the trainer with the servers of the script's owner in the base
 * version — the trainer's own session does not have them. In a training tree nobody is asked: a `write` run's
 * list comes from `review` over those servers, and its changing calls end `recorded`.
 */
export function createTryScriptTool(
  deps: Pick<TrainerToolsDeps, 'trainingRows' | 'agentRows'> & {
    readonly runCode: Pick<RunCodeTool, 'run'>;
    readonly registry: Pick<ToolRegistry, 'declaredMcpTools'>;
  },
): OutsideAgentTool<TryScriptArgs> {
  /** The servers of the script's owner in the base version; `undefined` — no such subagent. */
  async function ownerServers(
    caller: ToolCaller,
    owner: string | null,
  ): Promise<readonly string[] | undefined> {
    const { content } = await trainingBase(deps, caller);
    if (owner === null) return content.servers;
    return content.subagents.find((subagent) => subagent.name === owner)
      ?.servers;
  }

  const noOwner = (owner: string | null) =>
    ({
      kind: 'refused',
      reason: 'invalid_arguments',
      text: `The base version has no subagent ${owner}.`,
    }) as const;

  return {
    name: TRY_SCRIPT_TOOL,
    mode: 'outside',
    description: DESCRIPTION,
    argsSchema: TryScriptArgsSchema,
    confirmation: {
      kind: AGENTS_TOOL_CONFIRMATION,
      required: (args) => args.class === 'write',
      editableArgs: false,
      // Never shown: a training tree asks nobody. `review` gives the list over the owner's servers instead.
      content: () => ({ canCall: [] }),
      async review(args, caller) {
        const servers = await ownerServers(caller, args.owner);
        if (servers === undefined) return noOwner(args.owner);
        const tools = await deps.registry.declaredMcpTools(servers);
        return {
          kind: 'card',
          content: { canCall: canCallOf(args.code, tools) },
        };
      },
    },
    // The code and `input` may carry the employees' data: only what names the run is logged.
    loggedArgs: (args) => ({
      name: args.name,
      class: args.class,
      owner: args.owner,
      codeChars: typeof args.code === 'string' ? args.code.length : null,
    }),
    async execute(input) {
      const { args, caller } = input;
      const servers = await ownerServers(caller, args.owner);
      if (servers === undefined) return noOwner(args.owner);
      return deps.runCode.run(
        {
          code: args.code,
          runClass: args.class,
          input: args.input ?? null,
          description: `Trial run of draft script ${args.name}`,
          scriptName: args.name,
        },
        { ...input, caller: { ...caller, servers } },
      );
    },
  };
}
