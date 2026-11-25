import type { ModelVerdict } from '@agent-os/agents';
import type { ScheduleSkipReason } from '@agent-os/contracts';
import {
  decideRun,
  type ScheduleDecision,
  type ScheduleDecisionInput,
} from './schedule-decision';

// Run or skip at a term (design-schedules.md, KD-4): when several reasons hold at once, the first in the PRD's
// order wins — previous run unfinished, conversation busy, then the rights: account disabled, agent
// unavailable, quota exhausted. A wrong order would show the employee the wrong reason, or a rights check
// would run a busy conversation's term.

const ALLOWED: ModelVerdict = {
  kind: 'allowed',
  price: {
    inputUsdPerMTok: 1,
    outputUsdPerMTok: 5,
    cacheWriteUsdPerMTok: 1.25,
    cacheReadUsdPerMTok: 0.1,
  },
};
const DISABLED: ModelVerdict = { kind: 'refused', reason: 'owner_disabled' };
const QUOTA: ModelVerdict = { kind: 'refused', reason: 'quota_exhausted' };

const CLEAR: ScheduleDecisionInput = {
  previousRun: 'completed',
  conversationBusy: false,
  agentAvailable: true,
  models: [ALLOWED],
};

const skip = (reason: ScheduleSkipReason): ScheduleDecision => ({
  kind: 'skip',
  reason,
});

describe('decideRun', () => {
  it.each<[string, Partial<ScheduleDecisionInput>, ScheduleDecision]>([
    ['nothing holds → run', {}, { kind: 'run' }],
    [
      'previous run unfinished before a busy conversation and every right',
      {
        previousRun: 'working',
        conversationBusy: true,
        agentAvailable: false,
        models: [DISABLED, QUOTA],
      },
      skip('previous_run_unfinished'),
    ],
    [
      'busy conversation before every right',
      {
        conversationBusy: true,
        agentAvailable: false,
        models: [DISABLED, QUOTA],
      },
      skip('conversation_busy'),
    ],
    [
      'account disabled before an unavailable agent and an exhausted quota',
      { agentAvailable: false, models: [QUOTA, DISABLED] },
      skip('owner_disabled'),
    ],
    [
      'unavailable agent before an exhausted quota',
      { agentAvailable: false, models: [QUOTA] },
      skip('agent_unavailable'),
    ],
    [
      'no model for a new conversation is an unavailable agent, before the quota',
      { models: [null, QUOTA] },
      skip('agent_unavailable'),
    ],
    [
      'exhausted quota of the chip agent model alone',
      { models: [ALLOWED, QUOTA] },
      skip('quota_exhausted'),
    ],
  ])('%s', (_, change, expected) => {
    expect(decideRun({ ...CLEAR, ...change })).toEqual(expected);
  });
});
