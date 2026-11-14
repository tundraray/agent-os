import type { AgentStatus } from '@agent-os/contracts';
import { type AgentStatusInput, agentStatus } from './agent-view.js';

// State Transitions (MC-3 labels) and KD-3: «Прерван» is visible right after the command, from the
// pending `interrupt` without text, and after the step took it, from the session's mark.
const PLAIN = { pendingInterruptWithoutText: false, sessionInterrupted: false };

describe('agent status is derived from the task status and the session mark', () => {
  it.each<[string, AgentStatusInput, AgentStatus]>([
    ['queued is working', { ...PLAIN, taskStatus: 'queued', waitReason: null }, 'working'],
    ['running is working', { ...PLAIN, taskStatus: 'running', waitReason: null }, 'working'],
    ['waiting for messages is working', { ...PLAIN, taskStatus: 'waiting', waitReason: 'messages' }, 'working'],
    [
      'waiting for a decision awaits confirmation',
      { ...PLAIN, taskStatus: 'waiting', waitReason: 'decision' },
      'awaiting_confirmation',
    ],
    [
      'queued with a pending interrupt without text is interrupted',
      { ...PLAIN, taskStatus: 'queued', waitReason: null, pendingInterruptWithoutText: true },
      'interrupted',
    ],
    [
      'running with a pending interrupt without text is interrupted',
      { ...PLAIN, taskStatus: 'running', waitReason: null, pendingInterruptWithoutText: true },
      'interrupted',
    ],
    [
      'waiting for messages with the session mark is interrupted',
      { ...PLAIN, taskStatus: 'waiting', waitReason: 'messages', sessionInterrupted: true },
      'interrupted',
    ],
    ['completed', { ...PLAIN, taskStatus: 'completed', waitReason: null }, 'completed'],
    ['failed', { ...PLAIN, taskStatus: 'failed', waitReason: null }, 'failed'],
    [
      'stopped, even with a stale interrupted mark',
      { ...PLAIN, taskStatus: 'stopped', waitReason: null, sessionInterrupted: true },
      'stopped',
    ],
  ])('%s', (_, input, expected) => {
    expect(agentStatus(input)).toBe(expected);
  });
});
