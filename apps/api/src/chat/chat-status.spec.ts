import type {
  AgentStatus,
  ChatStatus,
  ConversationState,
  TaskStatus,
  WaitReason,
} from '@agent-os/contracts';
import { chatStatus, conversationState } from './chat-status';

type Row = {
  name: string;
  root: { status: AgentStatus; failureReason: string | null };
  task: { status: TaskStatus; waitReason: WaitReason | null };
  expected: { status: ChatStatus; failureReason: string | null };
};

// design-chat.md, State Transitions: the composer's status follows the root's view and its task. data-model
// design-runtime.md, «Статус агента», DC-38: a root waiting for its children is `awaiting_confirmation` only
// with an open question, which its view carries.
describe('chat status', () => {
  it.each<Row>([
    {
      name: 'root interrupted',
      root: { status: 'interrupted', failureReason: null },
      task: { status: 'waiting', waitReason: 'messages' },
      expected: { status: 'interrupted', failureReason: null },
    },
    {
      name: 'root waits for its children with an open question',
      root: { status: 'awaiting_confirmation', failureReason: null },
      task: { status: 'waiting', waitReason: 'children' },
      expected: { status: 'awaiting_confirmation', failureReason: null },
    },
    {
      name: 'root waits for its children without an open question',
      root: { status: 'working', failureReason: null },
      task: { status: 'waiting', waitReason: 'children' },
      expected: { status: 'working', failureReason: null },
    },
    {
      name: 'root failed on the turn limit',
      root: { status: 'failed', failureReason: 'turn_limit' },
      task: { status: 'failed', waitReason: null },
      expected: { status: 'failed', failureReason: 'turn_limit' },
    },
    {
      name: 'root stopped other than by delete',
      root: { status: 'stopped', failureReason: null },
      task: { status: 'stopped', waitReason: null },
      expected: { status: 'idle', failureReason: null },
    },
    {
      name: 'root completed',
      root: { status: 'completed', failureReason: null },
      task: { status: 'completed', waitReason: null },
      expected: { status: 'idle', failureReason: null },
    },
    {
      name: 'root waits for messages',
      root: { status: 'working', failureReason: null },
      task: { status: 'waiting', waitReason: 'messages' },
      expected: { status: 'idle', failureReason: null },
    },
    {
      name: 'root queued',
      root: { status: 'working', failureReason: null },
      task: { status: 'queued', waitReason: null },
      expected: { status: 'working', failureReason: null },
    },
    {
      name: 'root running',
      root: { status: 'working', failureReason: null },
      task: { status: 'running', waitReason: null },
      expected: { status: 'working', failureReason: null },
    },
  ])(
    "chat status follows the root's task and view: $name",
    ({ root, task, expected }) => {
      expect(chatStatus({ root, task, training: false })).toEqual(expected);
    },
  );
});

type StateRow = {
  name: string;
  facts: Partial<Parameters<typeof conversationState>[0]>;
  expected: ConversationState | null;
};

const IDLE_READ = {
  questionOpen: false,
  rootAnswering: false,
  agentsWorking: false,
  lastAnswerSeq: null,
  lastFailureSeq: null,
  seenThroughSeq: 0,
};

// improvements design-server.md, «How the conversation state works», AC-06.1, AC-06.2: a question beats work, work
// beats the last entry after the seen mark, and a read failure or answer gives no state.
describe('conversation state', () => {
  it.each<StateRow>([
    {
      name: "a subagent's card while the root works waits for you",
      facts: { questionOpen: true, rootAnswering: true, agentsWorking: true },
      expected: 'waiting_for_you',
    },
    {
      name: 'the root answering is working, though an answer is unread',
      facts: { rootAnswering: true, lastAnswerSeq: 4 },
      expected: 'working',
    },
    {
      name: 'an agent under an idle root is working',
      facts: { agentsWorking: true },
      expected: 'working',
    },
    {
      name: 'an answer after the mark is new',
      facts: { lastAnswerSeq: 6, seenThroughSeq: 3 },
      expected: 'new_answer',
    },
    {
      name: 'a failure after the mark is failed',
      facts: { lastFailureSeq: 5, seenThroughSeq: 3 },
      expected: 'failed',
    },
    {
      name: 'a failure, then an answer is a new answer',
      facts: { lastFailureSeq: 4, lastAnswerSeq: 7, seenThroughSeq: 2 },
      expected: 'new_answer',
    },
    {
      name: 'a read failure gives no state',
      facts: { lastFailureSeq: 5, lastAnswerSeq: 2, seenThroughSeq: 5 },
      expected: null,
    },
    {
      name: 'a read answer gives no state',
      facts: { lastAnswerSeq: 6, seenThroughSeq: 8 },
      expected: null,
    },
    {
      name: 'a conversation without answers gives no state',
      facts: {},
      expected: null,
    },
  ])('conversation state: $name', ({ facts, expected }) => {
    expect(conversationState({ ...IDLE_READ, ...facts })).toBe(expected);
  });
});
