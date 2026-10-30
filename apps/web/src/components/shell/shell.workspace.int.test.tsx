// chat-shell / web-shell Integration Test — Design Doc: docs/features/chat-shell/design-web-shell.md (v1.9)
// File: shell.workspace.int.test.tsx — Test Strategy, "Integration Tests (I)" (replaced workspace-panel.test.tsx in v1.2, N003)
// Generated: 2026-10-30 | Budget Used: 10 skeletons in 7 files (design-mandated: Test Strategy lists 7 integration files; over the 3/5 per-part limit, see generation report), 0/2 E2E (L1 checklist instead)
// Budget after the plan merges: 10 tests in 7 files, all implemented — no it.todo left (plan «Решение по бюджету интеграционных тестов»).
// ROI = (Business Value x Frequency + Legal x 10 + Defect Detection) / 11 (integration cost total, integration-e2e-testing skill)
// Test Type: Integration (Vitest + RTL + MSW 2, jsdom, real assistant-ui runtime)
//
// Harness (src/test/): renderWithRuntime(options) from '@/test/render-with-runtime'
//   mounts ChatRuntimeProvider + ChatShell with mocked next/navigation (controlled pathname, router spy).
//   options.media: { '(min-width: 1024px)': true, '(min-width: 768px)': true } drives the matchMedia polyfill (src/test/setup.ts).
//   MSW server from '@/test/msw-server' (onUnhandledRequest: 'error'); fixtures from '@/test/fixtures'.
//   API base URL in tests: NEXT_PUBLIC_API_URL = 'http://api.test' (vitest.config.ts test.env).
// Mock boundary: network only (MSW, empty list) + next/navigation. ChatShell, WorkspacePanel, ChatHeader,
//   react-resizable-panels — real. Panel widths (40 %, 360 px / 480 px limits) are NOT asserted here (jsdom has no layout) → L1-1.
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { threadList } from '@/test/fixtures';
import { server } from '@/test/msw-server';
import { renderWithRuntime } from '@/test/render-with-runtime';

const API = 'http://api.test';
const PLACEHOLDER = 'Здесь появятся артефакты инструментов: таблицы, документы, графики.';

describe('Shell: workspace panel (FR-11, AC-11.1 / AC-11.3)', () => {
  // AC-11.3: "When нажата та же кнопка или «×», the system shall скрыть панель, фокус — на кнопку в шапке."
  // AC-11.1 (merged into this test as the after-load assertion, before the first click):
  //   "When загружается / или /chat/<id> на десктопе, the system shall не показывать рабочую область."
  // EARS: When (event: close). Both closers hide the same panel and land focus on the same button, so they are table rows of ONE test.
  //   AC-11.1: When (event: page load at ≥ 1024 px) — the same ChatShell render, asserted before the panel is opened.
  // ROI: 3.5 | Business Value: 6 | Frequency: 5 | Legal: false | Defect Detection: 8 (focus is lost when the focused «×» unmounts)
  // ROI (AC-11.1): 6.0 | Business Value: 6 (chat gets full width by default) | Frequency: 10 | Legal: false | Defect Detection: 6
  // Behavior: render at '/', desktop media → button «Рабочая область» aria-expanded="false", no complementary «Рабочая область» (AC-11.1)
  //   → click HD-04 → panel visible, aria-expanded="true" → close by the row's closer → panel gone, aria-expanded="false", focus on HD-04
  // Primary failure mode: closing via «×» leaves focus on <body> (the focused element unmounted), the HD-04 toggle only opens,
  //   or focus jumps into the panel/body on close; AC-11.1: the panel is open by default (the pre-feature layout kept a permanent 60 % panel)
  // @category: ux
  // @dependency: ChatShell (workspaceOpen state), ChatHeader (HD-04), WorkspacePanel (WS-03), MSW
  // @complexity: medium
  // Table rows (implement with it.each):
  //   | closer                                   | focus before close | focus after close            |
  //   | button "Закрыть рабочую область" (WS-03) | on «×» (in panel)  | button "Рабочая область" (HD-04) |
  //   | button "Рабочая область" (HD-04)         | on HD-04           | button "Рабочая область" (HD-04) |
  it.each([
    { closer: 'Закрыть рабочую область' },
    { closer: 'Рабочая область' },
  ])(
    'AC-11.3 + AC-11.1: the workspace is hidden on load; closing it by "$closer" hides it and leaves focus on the header button',
    async ({ closer }) => {
      // Arrange
      server.use(http.get(`${API}/api/threads`, () => HttpResponse.json(threadList([]))));
      const user = userEvent.setup();
      renderWithRuntime({ pathname: '/', media: { '(min-width: 1024px)': true, '(min-width: 768px)': true } });

      // Act 1: load
      await screen.findByText('Пока нет бесед');

      // Assert 1 (AC-11.1): hidden by default, HD-04 not pressed
      const toggle = screen.getByRole('button', { name: 'Рабочая область' });
      expect(screen.queryByRole('complementary', { name: 'Рабочая область' })).toBeNull();
      expect(toggle).toHaveAttribute('aria-expanded', 'false');

      // Act 2: open
      await user.click(toggle);
      const panel = screen.getByRole('complementary', { name: 'Рабочая область' });
      expect(toggle).toHaveAttribute('aria-expanded', 'true');
      expect(panel).toHaveTextContent(PLACEHOLDER);

      // Act 3: close by the row's closer
      await user.click(screen.getByRole('button', { name: closer }));

      // Assert 2 (AC-11.3)
      expect(screen.queryByRole('complementary', { name: 'Рабочая область' })).toBeNull();
      expect(toggle).toHaveAttribute('aria-expanded', 'false');
      expect(toggle).toHaveFocus();
    },
  );
});
