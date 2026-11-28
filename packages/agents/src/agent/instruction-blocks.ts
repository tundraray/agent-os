import { parseSettingsValue } from '@agent-os/contracts';
import type { IdentityUsersRepository, SettingsRepository } from '@agent-os/db';
import type { StepContext } from '@agent-os/runtime';

import { agentOwner } from './agent-owner';

/** The line before the administrator's text (agent-guidance design-server.md, KD-3): no envelope, it is instructions. */
const ORGANISATION_HEADING =
  "Instructions from your organisation's administrator, for every agent:";
/** The line before the text of the employee the task runs for. */
const PERSONAL_HEADING = 'Instructions from the employee you work for:';

/** The two instruction blocks of a model step, each `null` when its text is empty (AC-03.2, AC-04.7). */
export interface InstructionBlocks {
  readonly organisation: string | null;
  readonly personal: string | null;
}

function block(heading: string, text: string): string | null {
  return text === '' ? null : `${heading}\n${text}`;
}

/**
 * The organisation's and the task owner's instructions (KD-4), read before every model call and never kept
 * (ADR-0023): the key `organisation_instructions` and the owner's `instructions` — the employee the run is for,
 * not the version's author (AC-04.2). The log carries lengths only.
 */
export async function instructionBlocks(
  deps: {
    readonly settingsRows: Pick<SettingsRepository, 'read'>;
    readonly userRows: Pick<IdentityUsersRepository, 'instructions'>;
  },
  ctx: StepContext,
): Promise<InstructionBlocks> {
  const ownerId = agentOwner(ctx);
  const row = await deps.settingsRows.read('organisation_instructions');
  const organisation = parseSettingsValue(
    'organisation_instructions',
    row.value,
  ).text;
  const personal = await deps.userRows.instructions(ownerId);
  if (personal === undefined)
    throw new Error(`Agent task ${ctx.taskId} has an unknown owner ${ownerId}`);
  ctx.logger.info('instruction blocks read', {
    agentId: ctx.taskId,
    rootId: ctx.rootId,
    ownerId,
    stepNo: ctx.stepNo,
    organisationChars: organisation.length,
    personalChars: personal.length,
  });
  return {
    organisation: block(ORGANISATION_HEADING, organisation),
    personal: block(PERSONAL_HEADING, personal),
  };
}
