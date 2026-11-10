/**
 * The rights port of tool calls (design-agent-core.md, «Порт прав», FR-10): asked on every call after the code's own
 * checks, by the owner of the investigation, the tool and the source the call would reach. A refusal ends the call with
 * the outcome `access_denied`, and neither the tool nor its source is called.
 */
export interface ToolAccessRequest {
  /** The owner of the investigation (`resourceId`). */
  readonly resourceId: string;
  /** The tool called; null asks for the right to the source as a whole (the start asks it for every catalog candidate). */
  readonly toolName: string | null;
  /** The source the call would reach; null for a tool without one. */
  readonly sourceId: string | null;
}

export type ToolAccessDecision = 'allowed' | 'access_denied';

export interface ToolAccessPolicy {
  decide(request: ToolAccessRequest): Promise<ToolAccessDecision> | ToolAccessDecision;
}

