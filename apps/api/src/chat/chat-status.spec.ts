import type {
  AgentStatus,
  ChatStatus,
  TaskStatus,
  WaitReason,
} from '@agent-os/contracts';
import { chatStatus } from './chat-status';

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
