import type { z } from 'zod';
import { ProcessConfigSchema, type ProcessConfig, type ProcessConfigRejection } from './process-config.schema.js';

export type { ProcessConfig, ProcessConfigRejection };

export type LoadProcessConfigResult =
  | { readonly ok: true; readonly config: ProcessConfig }
  | { readonly ok: false; readonly rejection: ProcessConfigRejection };

/** An unknown key is reported at its own path, not at the object that holds it. */
function rejectionOf(issue: z.core.$ZodIssue): ProcessConfigRejection {
  const path = issue.path.filter((segment): segment is string | number => typeof segment !== 'symbol');
  if (issue.code === 'unrecognized_keys') {
    return { code: 'process_config_rejected', path: [...path, issue.keys[0] ?? ''], message: issue.message };
  }
  return { code: 'process_config_rejected', path, message: issue.message };
}

/**
 * Checks data with the schema `createEngine` uses (AC-12.2); shipped configurations take the same path (AC-12.3).
 * The first fault is returned with its path.
 */
export function loadProcessConfig(data: unknown): LoadProcessConfigResult {
  const parsed = ProcessConfigSchema.safeParse(data);
  if (parsed.success) {
    return { ok: true, config: parsed.data };
  }
  const [firstIssue] = parsed.error.issues;
  if (firstIssue === undefined) {
    throw new Error('zod reported a failure without issues');
  }
  return { ok: false, rejection: rejectionOf(firstIssue) };
}
