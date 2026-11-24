import { z } from 'zod';

export const NOTEPAD_CREATE_TOOL = 'notepad_create';
export const NOTEPAD_APPEND_TOOL = 'notepad_append';
export const NOTEPAD_REPLACE_TOOL = 'notepad_replace';
export const NOTEPAD_READ_TOOL = 'notepad_read';
export const NOTEPAD_LIST_TOOL = 'notepad_list';
/** The notepad tool of past documents: the deep agent's only, never a subagent's (KD-3). */
export const NOTEPAD_PAST_TOOL = 'notepad_past';

/** Model tools of a deep agent run's notepad (self-learning design-notepad.md KD-2). */
export const NOTEPAD_TOOLS = [
  NOTEPAD_CREATE_TOOL,
  NOTEPAD_APPEND_TOOL,
  NOTEPAD_REPLACE_TOOL,
  NOTEPAD_READ_TOOL,
  NOTEPAD_LIST_TOOL,
  NOTEPAD_PAST_TOOL,
] as const;

/** The longest document, in characters (KD-5). */
export const DOCUMENT_MAX_CHARS = 200_000;

const DocumentIdSchema = z.int32().positive();

/** The report document named in a finished deep agent's result and in its `child_report`. */
export const DocumentRefSchema = z.object({
  id: DocumentIdSchema,
  title: z.string(),
});

/** A document in the lists of a conversation (GET /api/threads/:threadId/documents). */
export const DocumentSummarySchema = z.object({
  id: DocumentIdSchema,
  /** The run: the deep agent whose notepad holds the document. */
  agentId: z.string().min(1),
  title: z.string(),
  description: z.string(),
  report: z.boolean(),
  /** Name of the run's member who wrote last: the deep agent or a subagent. */
  writer: z.string(),
  chars: z.number().int().nonnegative(),
  /** The run is still working. */
  writing: z.boolean(),
  updatedAt: z.iso.datetime(),
});
export type DocumentSummary = z.infer<typeof DocumentSummarySchema>;

/** Response of GET /api/threads/:threadId/documents/:documentId: the whole document. */
export const DocumentSchema = DocumentSummarySchema.extend({
  text: z.string(),
});
export type Document = z.infer<typeof DocumentSchema>;

/** Response of GET /api/threads/:threadId/documents: documents of every run, most recently changed first. */
export const ThreadDocumentsViewSchema = z.object({
  documents: z.array(DocumentSummarySchema),
});
export type ThreadDocumentsView = z.infer<typeof ThreadDocumentsViewSchema>;
