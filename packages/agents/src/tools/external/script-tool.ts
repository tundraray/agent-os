import {
  AGENTS_TOOL_CONFIRMATION,
  type Script,
  ScriptToolArgsSchema,
  scriptToolName,
} from '@agent-os/contracts';
import type { z } from 'zod';

import type { OutsideAgentTool } from '../tool';
import { canCallOf } from './can-call';
import type { CodeRun } from './run-code';

/**
 * A saved script as its owner's tool (self-learning scripts KD-4, KD-5): `script__<name>`, run by the one code
 * run with the script's code and class and the call's `input`; a `write` script asks the employee as `run_code`
 * does, with the list `canCallOf` reads from its code, and its arguments are not editable.
 */
export function createScriptTool(
  script: Script,
  codeRun: CodeRun,
): OutsideAgentTool<z.infer<typeof ScriptToolArgsSchema>> {
  return {
    name: scriptToolName(script.name),
    mode: 'outside',
    description: `${script.description}\nInput: ${script.input === '' ? 'none' : script.input}`,
    argsSchema: ScriptToolArgsSchema,
    confirmation: {
      kind: AGENTS_TOOL_CONFIRMATION,
      required: () => script.class === 'write',
      editableArgs: false,
      content: (_args, tools) => ({ canCall: canCallOf(script.code, tools) }),
    },
    // `input` may carry the employee's data: it is never logged.
    loggedArgs: () => ({}),
    execute(input) {
      return codeRun(
        {
          code: script.code,
          runClass: script.class,
          input: input.args.input ?? null,
          description: script.description,
          scriptName: script.name,
        },
        input,
      );
    },
  };
}
