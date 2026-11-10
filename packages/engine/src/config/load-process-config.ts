import type { z } from 'zod';
import {
  type AgentProcessConfig,
  AgentProcessConfigSchema,
  type AgentTimings,
  checkAgentReferences,
  type ProcessConfigRejection,
} from './agent-config.schema.js';

export type { ProcessConfigRejection };

export type LoadProcessConfigResult =
  | { readonly ok: true; readonly config: AgentProcessConfig }
  | { readonly ok: false; readonly rejection: ProcessConfigRejection };

/** An unknown key is reported at its own path, not at the object that holds it. */
function rejectionOf(issue: z.core.$ZodIssue): ProcessConfigRejection {
  const path = issue.path.filter((segment): segment is string | number => typeof segment !== 'symbol');
  if (issue.code === 'unrecognized_keys') {
    return { code: 'process_config_rejected', path: [...path, issue.keys[0] ?? ''], message: issue.message };
  }
  return { code: 'process_config_rejected', path, message: issue.message };
}

function firstRejection(error: z.ZodError): ProcessConfigRejection {
  const [firstIssue] = error.issues;
  if (firstIssue === undefined) {
    throw new Error('zod reported a failure without issues');
  }
  return rejectionOf(firstIssue);
}

/**
 * Checks data with the strict schema of a process configuration and the checks across its definitions (KD-7,
 * ADR-0009); shipped configurations take the same path (AC-12.3). The `timings` bound a definition's `deadlineMs`
 * (DC-1). The first fault is returned with its path.
 */
export function loadProcessConfig(data: unknown, timings: AgentTimings): LoadProcessConfigResult {
  const parsed = AgentProcessConfigSchema.safeParse(data);
  if (!parsed.success) {
    return { ok: false, rejection: firstRejection(parsed.error) };
  }
  const fault = checkAgentReferences(parsed.data, timings);
  return fault === null ? { ok: true, config: parsed.data } : { ok: false, rejection: fault };
}
