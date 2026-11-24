import { z } from 'zod';

const BRIEF_FIELD_MAX = 4000;

/**
 * The three fields of a brief (deep-agents design-agent-types.md, «`start_deep_agent`»). The tool writes
 * them as the deep agent's task (JSON); the run view and `task` read them back with this schema; `boundaries`
 * and `result` may be empty but are always present.
 */
export const DeepAgentBriefSchema = z.object({
  question: z
    .string()
    .min(1)
    .max(BRIEF_FIELD_MAX)
    .describe(
      'The question the deep agent must answer, in the employee’s words',
    ),
  boundaries: z
    .string()
    .max(BRIEF_FIELD_MAX)
    .describe(
      'Boundaries of the work: systems, period, what to leave out; empty string if none',
    ),
  result: z
    .string()
    .max(BRIEF_FIELD_MAX)
    .describe(
      'What counts as the result: its form and contents; empty string if not stated',
    ),
});
export type DeepAgentBrief = z.infer<typeof DeepAgentBriefSchema>;

/** The brief a task text holds; `null` for a task written as plain text. */
export function briefOfTask(text: string): DeepAgentBrief | null {
  try {
    const parsed = DeepAgentBriefSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** A task text as shown in a list: the question of a brief, a plain text as it is. */
export function taskQuestion(text: string): string {
  return briefOfTask(text)?.question ?? text;
}
