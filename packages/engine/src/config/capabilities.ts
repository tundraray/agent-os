/** The engine's closed capability registry (ADR-0005): a configuration names capabilities only from this list. */
export const CAPABILITIES = ['plan', 'gather', 'analyze', 'verify', 'synthesize'] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** The controller's closed decision set (design-engine.md, Terms). */
export const DECISION_KINDS = [
  'requestEvidence',
  'requestAnalysis',
  'requestVerification',
  'replan',
  'wait',
  'proposeAnswer',
  'concludeInconclusive',
] as const;
export type DecisionKind = (typeof DECISION_KINDS)[number];

/**
 * The capabilities each decision requires (design-engine.md, ProcessConfig). `wait` and `concludeInconclusive`
 * require none, so they are open in every configuration. A new capability lands here with the decisions it opens.
 */
const REQUIRED_CAPABILITIES: Readonly<Record<DecisionKind, readonly Capability[]>> = {
  requestEvidence: ['gather'],
  requestAnalysis: ['gather', 'analyze'],
  requestVerification: ['verify'],
  replan: ['plan'],
  wait: [],
  proposeAnswer: ['synthesize'],
  concludeInconclusive: [],
};

/** The decisions a configuration with these capabilities opens to the controller (DC-1). */
export function decisionsOpenedBy(capabilities: readonly Capability[]): ReadonlySet<DecisionKind> {
  const enabled = new Set(capabilities);
  return new Set(
    DECISION_KINDS.filter((kind) => REQUIRED_CAPABILITIES[kind].every((capability) => enabled.has(capability))),
  );
}
