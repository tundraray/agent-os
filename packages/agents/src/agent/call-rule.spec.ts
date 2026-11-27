import {
  AGENTS_BRIEF_CONFIRMATION,
  AGENTS_TOOL_CONFIRMATION,
} from '@agent-os/contracts';

import { type CallRuleFacts, callRule, type CallRuling } from './call-rule';

// improvements design-server.md KD-1, KD-2, KD-4 («How the call rule works»). Catches: a permission matched by its
// server alone, so another changing tool of the same server is sent without a card; a schedule's run that sends a
// call outside its pairs; a conversation's grant without the root and the pair the intent adds.
const ROOT = 'root-1';
const SCHEDULE = 'schedule-1';
const CREATE_ISSUE = { server: 'tracker', tool: 'create_issue' };
const DELETE_ISSUE = { server: 'tracker', tool: 'delete_issue' };

function facts(overrides: Partial<CallRuleFacts>): CallRuleFacts {
  return {
    rootId: ROOT,
    pair: CREATE_ISSUE,
    cardKind: AGENTS_TOOL_CONFIRMATION,
    scheduleId: null,
    schedulePairs: [],
    conversationPairs: [],
    ...overrides,
  };
}

const unattended = expect.objectContaining({
  kind: 'refuse',
  reason: 'unattended',
}) as CallRuling;

describe('the call rule of a call that needs a card', () => {
  it.each<[string, CallRuleFacts, CallRuling]>([
    [
      'a schedule run sends a pair of the schedule under its grant',
      facts({ scheduleId: SCHEDULE, schedulePairs: [CREATE_ISSUE] }),
      { kind: 'send', grant: { kind: 'schedule', scheduleId: SCHEDULE } },
    ],
    [
      'a schedule run refuses another tool of an allowed server',
      facts({
        scheduleId: SCHEDULE,
        schedulePairs: [CREATE_ISSUE],
        pair: DELETE_ISSUE,
      }),
      unattended,
    ],
    [
      "a schedule run sends a deep agent's brief",
      facts({
        scheduleId: SCHEDULE,
        pair: null,
        cardKind: AGENTS_BRIEF_CONFIRMATION,
      }),
      { kind: 'send', grant: { kind: 'schedule', scheduleId: SCHEDULE } },
    ],
    [
      'a schedule run refuses a changing call that is not MCP',
      facts({ scheduleId: SCHEDULE, pair: null, cardKind: 'agents.run_code' }),
      unattended,
    ],
    [
      'a human turn sends a pair granted in the conversation under its grant',
      facts({ conversationPairs: [CREATE_ISSUE] }),
      {
        kind: 'send',
        grant: { kind: 'conversation', rootId: ROOT, pair: CREATE_ISSUE },
      },
    ],
    [
      'a human turn shows the card for another tool of a granted server',
      facts({ conversationPairs: [CREATE_ISSUE], pair: DELETE_ISSUE }),
      { kind: 'card' },
    ],
    [
      'a human turn shows the card when nothing is granted',
      facts({}),
      { kind: 'card' },
    ],
  ])('%s', (_, given, expected) => {
    expect(callRule(given)).toEqual(expected);
  });
});
