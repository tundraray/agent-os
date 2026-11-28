// runtime-fixes / send - FeedStore unit test (no React, no network: `createFeedStore` over a stub `api`).
// Design Doc: docs/features/runtime-fixes/design-send.md (KD-3, "C3 · Components: web"). PRD: docs/features/runtime-fixes/prd.md (AC-03.1).
// Generated: 2026-11-28 | Part: send | Test type: Unit (provenAt: unit for the web half of AC-03.1)
//
// One table-driven test: the key rule is one rule with a few rows. The server half of the rule (a repeat creates nothing)
// is proven by `apps/api/test/runtime-fixes-send.int.e2e-spec.ts`; this file proves only which key the web puts in the body.
// Not tested: that `crypto.randomUUID` returns a UUID, the `messageId: null` handling (existing code, unchanged), the request
// wiring of `threads-api-client` (typecheck against the contracts schema).

import { describe, expect, it, vi } from 'vitest';
import type { ThreadsApiClient } from '@/lib/threads/threads-api-client';
import { createAnnouncerStore } from '@/lib/live/announcer-store';
import { createFeedStore, type FeedSource } from './feed-store';

/** One send of a row: from the composer or quiet, accepted or not. */
type Step = { readonly quiet: boolean; readonly accepted: boolean };

const composerFails: Step = { quiet: false, accepted: false };
const composerSends: Step = { quiet: false, accepted: true };
const quietFails: Step = { quiet: true, accepted: false };

const thread: FeedSource = {
  kind: 'thread',
  threadId: '0b6f3c1e-6d0a-4a8e-9f57-0c1b2d3e4f50',
};
const agent: FeedSource = {
  kind: 'agent',
  agentId: '7a1d2c3b-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
};

/** The keys of the calls named by the order their first use appears: ['a', 'a'] — one key twice. */
function keyPattern(keys: readonly string[]): string[] {
  const names = new Map<string, string>();
  return keys.map((key) => {
    if (!names.has(key)) names.set(key, String.fromCharCode(97 + names.size));
    return names.get(key) as string;
  });
}

describe('feed-store - send key (KD-3)', () => {
  // AC: AC-03.1 "…интерфейс повторяет отправку с тем же ключом…" (the web half: the retry after an error carries the failed send's key)
  // Catches: a key made anew on every request, which never catches the one retry the web really makes (the employee sends the
  //   returned text again after an error); or a key that outlives a success, so the NEXT, different message is swallowed
  //   as a repeat; or a quiet send that takes or clears the composer's failed key.
  it.each([
    {
      row: 'A: retry after a failed send, conversation',
      source: thread,
      steps: [composerFails, composerSends],
      pattern: ['a', 'a'],
    },
    {
      row: 'A: retry after a failed send, agent page',
      source: agent,
      steps: [composerFails, composerSends],
      pattern: ['a', 'a'],
    },
    {
      row: 'B: next send after a success',
      source: thread,
      steps: [composerSends, composerSends],
      pattern: ['a', 'b'],
    },
    {
      row: 'C: a quiet send between a failure and its retry',
      source: thread,
      steps: [composerFails, quietFails, composerSends],
      pattern: ['a', 'b', 'a'],
    },
  ])(
    'KD-3 AC-03.1: $row — keys of the calls follow $pattern',
    async ({ source, steps, pattern }) => {
      const keys: string[] = [];
      let call = 0;
      const answer = (sendKey: string) => {
        keys.push(sendKey);
        const step = steps[call];
        call += 1;
        return step.accepted
          ? Promise.resolve({ messageId: null })
          : Promise.reject(new Error('response lost'));
      };
      const api = {
        sendThreadMessage: vi.fn((_id: string, _text: string, key: string) =>
          answer(key),
        ),
        sendAgentMessage: vi.fn((_id: string, _text: string, key: string) =>
          answer(key),
        ),
        // The re-read after an accepted send fails quietly: the read never rejects.
        getConversation: vi.fn(() => Promise.reject(new Error('no read'))),
        getAgentPage: vi.fn(() => Promise.reject(new Error('no read'))),
      } as unknown as ThreadsApiClient;
      const store = createFeedStore({
        source,
        api,
        announcer: createAnnouncerStore(),
        logger: { info: vi.fn(), warn: vi.fn() },
      });

      for (const step of steps) {
        const sent = store.send(
          'retry me',
          undefined,
          step.quiet ? { quiet: true } : undefined,
        );
        if (step.accepted) await expect(sent).resolves.toBeUndefined();
        else await expect(sent).rejects.toThrow('response lost');
      }

      expect(keyPattern(keys)).toEqual(pattern);
      // An accepted composer send leaves no failure behind, so its key is never repeated.
      expect(store.getState().sendFailure).toBeNull();
    },
  );
});
