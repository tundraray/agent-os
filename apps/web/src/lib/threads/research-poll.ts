/**
 * At most one GET /api/threads/:id/research per interval while the open thread has a launch in progress
 * (design-chat-entry.md, KD-6). Reading the state costs no model call, unlike a polling chat turn.
 */
export const RESEARCH_POLL_INTERVAL_MS = 2_000;
