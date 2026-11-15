import { z } from 'zod';

/** Audit event persisted by the API audit interceptor. */
export const AuditEventSchema = z.object({
  type: z.string(),
  userId: z.string(),
  agentId: z.string().optional(),
  threadId: z.string().optional(),
  at: z.string(),
  payload: z.record(z.string(), z.unknown()).optional(),
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;
export * from './threads.js';
export * from './runtime.js';
export * from './agents.js';
export * from './chat.js';
