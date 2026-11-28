import {
  AGENTS_BRIEF_CONFIRMATION,
  AGENTS_QUESTION_CONFIRMATION,
  AGENTS_TOOL_CONFIRMATION,
  IDENTITY_INSTRUCTIONS_CONFIRMATION,
  LIBRARY_RECORD_CONFIRMATION,
} from '@agent-os/contracts';

import { type CallRuleFacts, callRule, type CallRuling } from './call-rule';

// chat-scheduling design-server.md KD-3, «How the call rule works» (FR-03). Catches: a `read` run that sends a
// changing call; a `full` run that sends a card that is not a changing kind; a brief refused in a run; a
// conversation's grant matched by its server alone or lost in an ordinary turn.
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
    scheduleAccess: 'read',
    conversationPairs: [],
    ...overrides,
  };
}

const bySchedule: CallRuling = {
  kind: 'send',
  grant: { kind: 'schedule', scheduleId: SCHEDULE },
};

const unattended = expect.objectContaining({
  kind: 'refuse',
  reason: 'unattended',
}) as CallRuling;

describe('the call rule of a call that needs a card', () => {
  it.each<[string, CallRuleFacts, CallRuling]>([
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
      'a human turn shows the card of a full schedule’s changing call',
      facts({ scheduleAccess: 'full' }),
      { kind: 'card' },
    ],
    [
      "a read schedule's run sends a deep agent's brief",
      facts({
        scheduleId: SCHEDULE,
        pair: null,
        cardKind: AGENTS_BRIEF_CONFIRMATION,
      }),
      bySchedule,
    ],
    [
      "a read schedule's run sends a question nobody can answer",
      facts({
        scheduleId: SCHEDULE,
        pair: null,
        cardKind: AGENTS_QUESTION_CONFIRMATION,
      }),
      bySchedule,
    ],
    [
      "a full schedule's run sends a changing MCP call",
      facts({ scheduleId: SCHEDULE, scheduleAccess: 'full' }),
      bySchedule,
    ],
    [
      "a full schedule's run sends a library write",
      facts({
        scheduleId: SCHEDULE,
        scheduleAccess: 'full',
        pair: null,
        cardKind: LIBRARY_RECORD_CONFIRMATION,
      }),
      bySchedule,
    ],
    [
      "a read schedule's run refuses a changing MCP call even when the conversation granted it",
      facts({ scheduleId: SCHEDULE, conversationPairs: [CREATE_ISSUE] }),
      unattended,
    ],
    [
      "a read schedule's run refuses a library write",
      facts({
        scheduleId: SCHEDULE,
        pair: null,
        cardKind: LIBRARY_RECORD_CONFIRMATION,
      }),
      unattended,
    ],
    [
      "a full schedule's run refuses a card that is not a changing kind",
      facts({
        scheduleId: SCHEDULE,
        scheduleAccess: 'full',
        pair: null,
        cardKind: IDENTITY_INSTRUCTIONS_CONFIRMATION,
      }),
      unattended,
    ],
  ])('%s', (_, given, expected) => {
    expect(callRule(given)).toEqual(expected);
  });
});
