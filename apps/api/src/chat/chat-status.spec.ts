import type { AgentStatus, ChatStatus, TaskStatus, WaitReason } from '@agent-os/contracts';
import { chatStatus } from './chat-status.js';

type Row = {
  name: string;
  root: { status: AgentStatus; failureReason: string | null } | null;
  task: { status: TaskStatus; waitReason: WaitReason | null } | null;
  expected: { status: ChatStatus; failureReason: string | null };
};

// design-chat.md, State Transitions: the composer's status follows the root's view and its task.
describe('chat status', () => {
  it.each<Row>([
    {
      name: 'no root yet',
      root: null,
      task: null,
      expected: { status: 'new', failureReason: null },
    },
    {
      name: 'root interrupted without text',
      root: { status: 'interrupted', failureReason: null },
      task: { status: 'waiting', waitReason: 'messages' },
      expected: { status: 'interrupted', failureReason: null },
    },
    {
      name: 'root awaits a decision',
      root: { status: 'awaiting_confirmation', failureReason: null },
      task: { status: 'waiting', waitReason: 'decision' },
      expected: { status: 'awaiting_confirmation', failureReason: null },
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
  ])('chat status follows the root\'s task and view: $name', ({ root, task, expected }) => {
    expect(chatStatus({ root, task })).toEqual(expected);
  });
});
