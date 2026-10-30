// chat-shell / web-shell Integration Test — Design Doc: docs/features/chat-shell/design-web-shell.md (v1.5)
// File: shell.workspace.int.test.tsx — Test Strategy, "Integration Tests (I)" (replaced workspace-panel.test.tsx in v1.2, N003)
// Generated: 2026-10-30 | Budget Used: 14 skeletons in 7 files (design-mandated: Test Strategy lists 7 integration files; over the 3/5 per-part limit, see generation report), 0/2 E2E (L1 checklist instead)
// Budget after the plan merges: 10 it.todo in 7 files (plan «Решение по бюджету интеграционных тестов»).
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
// Imports for implementation (added when the case is filled; an it.todo case imports nothing):
//   import { screen } from '@testing-library/react';
//   import { http, HttpResponse } from 'msw';
//   import { server } from '@/test/msw-server';
//   import { renderWithRuntime } from '@/test/render-with-runtime';
import { describe, it } from 'vitest';

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
  it.todo('AC-11.3 + AC-11.1: the workspace is hidden on load; closing it by «×» or by the header button hides it and leaves focus on the header button' /*
    Arrange:
      - GET /api/threads → 200 { threads: [], nextCursor: null }
      - renderWithRuntime({ pathname: '/', media: { '(min-width: 1024px)': true, '(min-width: 768px)': true } })
    Act 1 (load):
      - await screen.findByText('Пока нет бесед')
    Assert 1 (AC-11.1, before the first click):
      - queryByRole('complementary', { name: 'Рабочая область' }) === null
      - getByRole('button', { name: 'Рабочая область' }) has aria-expanded="false"
    Act 2:
      - click button "Рабочая область" (open)
      - (intermediate) getByRole('complementary', { name: 'Рабочая область' }) present; button aria-expanded="true";
        text "Здесь появятся артефакты инструментов: таблицы, документы, графики." visible
      - click the row's closer
    Assert 2:
      - queryByRole('complementary', { name: 'Рабочая область' }) === null
      - button "Рабочая область" has aria-expanded="false"
      - document.activeElement === getByRole('button', { name: 'Рабочая область' })
  */);
});
