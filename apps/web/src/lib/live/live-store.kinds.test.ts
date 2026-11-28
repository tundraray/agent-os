// live-feed / web - LiveStore unit test (no React; `createLiveStore` over a raw event source, MSW not needed).
// Design Doc: docs/features/live-feed/design-web.md (KD-1, "Какие виды касаются каждой части экрана"). PRD: docs/features/live-feed/prd.md.
// Generated: 2026-11-28 | Part: web | Test type: Unit (provenAt: unit for the filter rule; the wiring of the screen parts is the integration file)
//
// One table-driven test: the subscription filter is one rule with a few rows. Not tested: that the schema parses the
// frame (contracts own it), what each listener re-reads (unchanged code), the reconnect path (live-store.test.ts).

import { describe, expect, it, vi } from 'vitest';
import { createAnnouncerStore } from './announcer-store';
import { createLiveStore, type LiveEventSource } from './live-store';

/** `EventSource.OPEN`; jsdom has no `EventSource`. */
const OPEN = 1;

/** The raw source: a row sends a body the shared test source would not let through its types (an unknown kind). */
class RawSource extends EventTarget implements LiveEventSource {
  readyState = OPEN;
  close(): void {}
  send(type: string, body: string): void {
    this.dispatchEvent(new MessageEvent(type, { data: body }));
  }
}

const X = 'thread-x';
const Y = 'thread-y';

describe('live-store - subscription by kind (KD-1)', () => {
  // AC: AC-06.1 "…ленту показывает после одного чтения ленты, а список бесед, счётчик ожиданий и дерево агентов не перечитываются."
  // AC: AC-06.2 "…обновляется отметка этой беседы в списке, а лента открытой беседы не перечитывается."
  // AC: AC-06.3 "…пришёл неизвестный вид изменения, then все части экрана показывают текущее состояние без перезагрузки страницы."
  // Catches: a filter that lets every `change` through; a filter that drops an unknown kind; a thread-scoped subscriber
  //   that fires on another thread's `state`.
  // @category: core-functionality
  // @dependency: LiveStore, raw live source
  // @complexity: medium
  it.each([
    {
      row: 'entries of the root agent of thread X',
      type: 'change',
      body: { threadId: X, kind: 'entries', agentId: X },
      called: { feedX: ['change'], list: [], attention: [] },
    },
    {
      row: 'entries of a subagent of thread X',
      type: 'change',
      body: { threadId: X, kind: 'entries', agentId: 'subagent' },
      called: { feedX: [], list: [], attention: [] },
    },
    {
      row: 'state of thread Y',
      type: 'change',
      body: { threadId: Y, kind: 'state' },
      called: { feedX: [], list: ['change'], attention: [] },
    },
    {
      row: 'deleted of thread X',
      type: 'change',
      body: { threadId: X, kind: 'deleted' },
      called: { feedX: ['change'], list: ['change'], attention: [] },
    },
    {
      row: 'a kind the web does not know',
      type: 'change',
      body: { threadId: X, kind: 'archived' },
      called: { feedX: ['ready'], list: ['ready'], attention: [] },
    },
    {
      row: 'a change that fails the schema',
      type: 'change',
      body: { kind: 'state' },
      called: { feedX: ['ready'], list: ['ready'], attention: [] },
    },
    {
      row: 'attention',
      type: 'attention',
      body: { threadId: X, event: 'answer' },
      called: { feedX: [], list: [], attention: ['attention'] },
    },
  ])(
    'AC-06.1 AC-06.2 AC-06.3: $row reaches only the subscribers of its kind and thread; an unknown one reaches all as ready',
    ({ type, body, called }) => {
      let source: RawSource | undefined;
      const live = createLiveStore({
        openEventSource: () => {
          source = new RawSource();
          return source;
        },
        announcer: createAnnouncerStore(),
        logger: { warn: vi.fn() },
      });
      void live.watch(null);
      const seen = {
        feedX: [] as string[],
        list: [] as string[],
        attention: [] as string[],
      };
      // The feed of thread X and the conversation list, as design-web subscribes them; each also listens to `ready`.
      live.onChange(
        {
          kinds: ['entries', 'state', 'summary', 'deleted'],
          threadId: X,
          agentId: X,
        },
        () => seen.feedX.push('change'),
      );
      live.onReady(() => seen.feedX.push('ready'));
      live.onChange({ kinds: ['state', 'summary', 'deleted'] }, () =>
        seen.list.push('change'),
      );
      live.onReady(() => seen.list.push('ready'));
      live.onAttention(() => seen.attention.push('attention'));

      source?.send(type, JSON.stringify(body));

      expect(seen).toEqual(called);
    },
  );
});
