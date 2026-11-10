import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { deepResearchProcessV3 } from '../processes/shipped-processes.js';
import { agentsConfigIdentity } from './agents-config-identity.js';
import { claimAssessmentAgent } from './forms/claim-assessment.js';

// DD Contract `RunResult` (per definition, the model and the fingerprint); the fingerprint must be the one a run has.

const AgentsDataSchema = z.looseObject({ agents: z.record(z.string(), z.looseObject({ tools: z.array(z.string()) })) });

describe('agentsConfigIdentity', () => {
  it('gives the checker the fingerprint its group table is looked up by', () => {
    const identity = agentsConfigIdentity(deepResearchProcessV3);

    expect(identity?.definitions.verifier?.fingerprint).toBe(claimAssessmentAgent(deepResearchProcessV3)?.agentFingerprint);
  });

  it('counts a tool of the research process in the fingerprint', () => {
    const data = AgentsDataSchema.parse(deepResearchProcessV3);
    const worker = data.agents.worker;
    if (worker === undefined) throw new Error('the shipped configuration has no worker');
    const withoutGather = {
      ...data,
      agents: { ...data.agents, worker: { ...worker, tools: worker.tools.filter((tool) => tool !== 'gather') } },
    };

    expect(agentsConfigIdentity(withoutGather)?.definitions.worker?.fingerprint).not.toBe(
      agentsConfigIdentity(data)?.definitions.worker?.fingerprint,
    );
  });

  it('names no identity for data without agents', () => {
    const withoutAgents = { processId: 'deep-research', version: 3, goal: 'g', sources: [] };
    expect(agentsConfigIdentity(withoutAgents)).toBeNull();
  });
});
