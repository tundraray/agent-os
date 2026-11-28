import type { RuntimeTreeSignal } from '@agent-os/contracts';

import {
  deltaTargets,
  noteTargets,
  parseWatch,
  runtimeChanges,
  type DeltaAddress,
  type LiveChangeEvent,
  type LiveStream,
  type Watch,
} from './live-filter';

const ROOT = '22222222-2222-4222-8222-222222222222';
/** A conversation's id is its root's. */
const THREAD = ROOT;
const CHILD = '33333333-3333-4333-8333-333333333333';

type NamedStream = LiveStream & { readonly name: string };

const stream = (
  name: string,
  ownerId: string,
  watch: Watch | null,
): NamedStream => ({
  name,
  ownerId,
  watch,
});

const ownerThread = stream('owner thread', 'owner', {
  kind: 'thread',
  threadId: THREAD,
});
const ownerAgent = stream('owner agent', 'owner', {
  kind: 'agent',
  agentId: CHILD,
});
const ownerRootAgent = stream('owner root agent', 'owner', {
  kind: 'agent',
  agentId: ROOT,
});
const ownerPlain = stream('owner no watch', 'owner', null);
const strangerAgent = stream('stranger agent', 'stranger', {
  kind: 'agent',
  agentId: CHILD,
});
const strangerThread = stream('stranger thread', 'stranger', {
  kind: 'thread',
  threadId: THREAD,
});
const streams = [
  ownerThread,
  ownerAgent,
  ownerRootAgent,
  ownerPlain,
  strangerAgent,
  strangerThread,
];

const rootPart: DeltaAddress = {
  ownerId: 'owner',
  rootId: ROOT,
  agentId: ROOT,
};
const childPart: DeltaAddress = {
  ownerId: 'owner',
  rootId: ROOT,
  agentId: CHILD,
};

const names = (targets: NamedStream[]): string[] =>
  targets.map((target) => target.name).sort();

type Row =
  | {
      name: string;
      rule: 'watch';
      value: string | undefined;
      expected: Watch | null;
    }
  | { name: string; rule: 'note'; expected: string[] }
  | {
      name: string;
      rule: 'delta';
      delta: DeltaAddress;
      expected: string[];
    };

const childEntries: LiveChangeEvent = {
  type: 'change',
  data: { threadId: THREAD, kind: 'entries', agentId: CHILD },
};
const state: LiveChangeEvent = {
  type: 'change',
  data: { threadId: THREAD, kind: 'state' },
};

// live-feed design-server.md, «How the change kinds are derived»; AC-01.1, AC-01.2 (`state`), AC-01.4 (`running`
// gives nothing). Catches: a claim that makes every tab reread, a step commit that rereads the conversation's state,
// a message or a new task that does not, or `entries` naming another agent than the task of the signal.
describe('a runtime signal becomes the change events of its task by the status it wrote', () => {
  it.each<{
    name: string;
    signal: Omit<RuntimeTreeSignal, 'rootId' | 'taskId'>;
    expected: LiveChangeEvent[];
  }>([
    {
      name: 'running gives nothing',
      signal: { status: 'running' },
      expected: [],
    },
    {
      name: "queued gives the agent's entries only",
      signal: { status: 'queued' },
      expected: [childEntries],
    },
    {
      name: 'waiting gives entries and state',
      signal: { status: 'waiting' },
      expected: [childEntries, state],
    },
    {
      name: 'completed gives entries and state',
      signal: { status: 'completed' },
      expected: [childEntries, state],
    },
    {
      name: 'a signal without a status (a new task, a message, a delivery) gives entries and state',
      signal: {},
      expected: [childEntries, state],
    },
  ])('$name', ({ signal, expected }) => {
    expect(
      runtimeChanges({ rootId: ROOT, taskId: CHILD, ...signal }),
    ).toStrictEqual(expected);
  });
});

// DC-4, Invariant 3 (design-chat.md, Contract «Поток»; INT-1 A): the rule; its wiring is INT-4.
describe("live events go to the owner's streams and text parts only to the owner's stream that watches the agent", () => {
  it.each<Row>([
    {
      name: 'thread:<uuid> watches the conversation',
      rule: 'watch',
      value: `thread:${THREAD}`,
      expected: { kind: 'thread', threadId: THREAD },
    },
    {
      name: 'agent:<uuid> watches the agent',
      rule: 'watch',
      value: `agent:${CHILD}`,
      expected: { kind: 'agent', agentId: CHILD },
    },
    {
      name: 'thread: without an id watches nothing',
      rule: 'watch',
      value: 'thread:',
      expected: null,
    },
    {
      name: 'an unknown value watches nothing',
      rule: 'watch',
      value: 'foo',
      expected: null,
    },
    {
      name: 'an empty value watches nothing',
      rule: 'watch',
      value: '',
      expected: null,
    },
    {
      name: 'no value watches nothing',
      rule: 'watch',
      value: undefined,
      expected: null,
    },
    {
      name: "a conversation's event reaches every stream of the owner and none of a stranger",
      rule: 'note',
      expected: [
        'owner agent',
        'owner no watch',
        'owner root agent',
        'owner thread',
      ],
    },
    {
      name: "a child's part reaches only the owner's stream watching that agent",
      rule: 'delta',
      delta: childPart,
      expected: ['owner agent'],
    },
    {
      name: "a root's part reaches the owner's thread stream and the owner's stream watching the root",
      rule: 'delta',
      delta: rootPart,
      expected: ['owner root agent', 'owner thread'],
    },
    {
      name: "a part of another owner's tree reaches none of the owner's streams",
      rule: 'delta',
      delta: { ownerId: 'third', rootId: ROOT, agentId: CHILD },
      expected: [],
    },
  ])('$name', (row) => {
    if (row.rule === 'watch') {
      expect(parseWatch(row.value)).toStrictEqual(row.expected);
    } else if (row.rule === 'note') {
      expect(names(noteTargets('owner', streams))).toStrictEqual(row.expected);
    } else {
      expect(names(deltaTargets(row.delta, streams))).toStrictEqual(
        row.expected,
      );
    }
  });
});
