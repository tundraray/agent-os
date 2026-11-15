import {
  deltaTargets,
  noteTargets,
  parseWatch,
  type DeltaAddress,
  type LiveStream,
  type RootConversation,
  type Watch,
} from './live-filter.js';

const THREAD = '11111111-1111-4111-8111-111111111111';
const ROOT = '22222222-2222-4222-8222-222222222222';
const CHILD = '33333333-3333-4333-8333-333333333333';

type NamedStream = LiveStream & { readonly name: string };

const stream = (name: string, ownerId: string, watch: Watch | null): NamedStream => ({
  name,
  ownerId,
  watch,
});

const ownerThread = stream('owner thread', 'owner', { kind: 'thread', threadId: THREAD });
const ownerAgent = stream('owner agent', 'owner', { kind: 'agent', agentId: CHILD });
const ownerRootAgent = stream('owner root agent', 'owner', { kind: 'agent', agentId: ROOT });
const ownerPlain = stream('owner no watch', 'owner', null);
const strangerAgent = stream('stranger agent', 'stranger', { kind: 'agent', agentId: CHILD });
const strangerThread = stream('stranger thread', 'stranger', { kind: 'thread', threadId: THREAD });
const streams = [ownerThread, ownerAgent, ownerRootAgent, ownerPlain, strangerAgent, strangerThread];

const conversation: RootConversation = { threadId: THREAD, ownerId: 'owner' };
const rootPart: DeltaAddress = { ownerId: 'owner', rootId: ROOT, agentId: ROOT };
const childPart: DeltaAddress = { ownerId: 'owner', rootId: ROOT, agentId: CHILD };

const names = (targets: NamedStream[]): string[] => targets.map((target) => target.name).sort();

type Row =
  | { name: string; rule: 'watch'; value: string | undefined; expected: Watch | null }
  | { name: string; rule: 'note'; expected: string[] }
  | {
      name: string;
      rule: 'delta';
      delta: DeltaAddress;
      found: RootConversation | null;
      expected: string[];
    };

// DC-4, Invariant 3 (design-chat.md, Contract «Поток»; INT-1 A): the rule; its wiring is INT-4.
describe('live notes go to the owner\'s streams and text parts only to the owner\'s stream that watches the agent', () => {
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
    { name: 'thread: without an id watches nothing', rule: 'watch', value: 'thread:', expected: null },
    { name: 'an unknown value watches nothing', rule: 'watch', value: 'foo', expected: null },
    { name: 'an empty value watches nothing', rule: 'watch', value: '', expected: null },
    { name: 'no value watches nothing', rule: 'watch', value: undefined, expected: null },
    {
      name: 'a tree note reaches every stream of the owner and none of a stranger',
      rule: 'note',
      expected: ['owner agent', 'owner no watch', 'owner root agent', 'owner thread'],
    },
    {
      name: "a child's part reaches only the owner's stream watching that agent",
      rule: 'delta',
      delta: childPart,
      found: conversation,
      expected: ['owner agent'],
    },
    {
      name: "a root's part reaches the owner's thread stream and the owner's stream watching the root",
      rule: 'delta',
      delta: rootPart,
      found: conversation,
      expected: ['owner root agent', 'owner thread'],
    },
    {
      // A `thread:` stream opened before the first message: the same stream gets the root's part
      // once the conversation is found (the row above).
      name: "a root's part before its conversation is found reaches no thread stream",
      rule: 'delta',
      delta: rootPart,
      found: null,
      expected: ['owner root agent'],
    },
    {
      name: "a part of another owner's tree reaches none of the owner's streams",
      rule: 'delta',
      delta: { ownerId: 'third', rootId: ROOT, agentId: CHILD },
      found: null,
      expected: [],
    },
  ])('$name', (row) => {
    if (row.rule === 'watch') {
      expect(parseWatch(row.value)).toStrictEqual(row.expected);
    } else if (row.rule === 'note') {
      expect(names(noteTargets(conversation, streams))).toStrictEqual(row.expected);
    } else {
      expect(names(deltaTargets(row.delta, row.found, streams))).toStrictEqual(row.expected);
    }
  });
});
