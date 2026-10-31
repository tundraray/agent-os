/**
 * A failure of `connect()` or `start()` of the source process. Client 2.4.0 rejects a failed spawn
 * with a plain `Error`, which would otherwise read as a defect (K-14); the tag makes it K-9.
 */
export class McpStartupError extends Error {
  override readonly name = 'McpStartupError';

  constructor(cause: unknown) {
    super('MCP source process failed to start', { cause });
  }
}
