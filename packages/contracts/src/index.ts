import { z } from 'zod';

/**
 * Body of POST /api/chat/:agentId (AI SDK UI messages are passed through as-is).
 * The AI SDK chat transport sends the chat id as `id`; `threadId` takes precedence when set.
 */
export const ChatRequestSchema = z.object({
  id: z.string().min(1).optional(),
  threadId: z.string().min(1).optional(),
  messages: z.array(z.unknown()),
});
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

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
export * from './research.js';
export * from './research-chat.js';
