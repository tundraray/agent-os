// chat-shell / web-shell Integration Test — Design Doc: docs/features/chat-shell/design-web-shell.md (v1.2)
// File: shell.workspace.int.test.tsx — Test Strategy, "Integration Tests (I)" (replaced workspace-panel.test.tsx in v1.2, N003)
// Generated: 2026-10-28 | Budget Used: 6/3 integration files (design-mandated, see generation report), 0/2 E2E (L1 checklist instead)
// Test Type: Integration (Vitest + RTL + MSW 2, jsdom, real assistant-ui runtime)
//
// Harness (planned, src/test/): renderWithRuntime(options) from '@/test/render-with-runtime'
//   mounts ChatRuntimeProvider + ChatShell with mocked next/navigation (controlled pathname, router spy).
//   options.media: { '(min-width: 1024px)': true, '(min-width: 768px)': true } drives the matchMedia polyfill (src/test/setup.ts).
//   MSW server from '@/test/msw-server' (onUnhandledRequest: 'error'); fixtures from '@/test/fixtures'.
//   API base URL in tests: NEXT_PUBLIC_API_URL = 'http://api.test' (vitest.config.ts test.env).
// Mock boundary: network only (MSW, empty list) + next/navigation. ChatShell, WorkspacePanel, ChatHeader,
//   react-resizable-panels — real. Panel widths (40 %, 360 px / 480 px limits) are NOT asserted here (jsdom has no layout) → L1-1.
// Planned imports for implementation (not imported yet: modules do not exist before the plan runs):
//   import { screen } from '@testing-library/react';
//   import { http, HttpResponse } from 'msw';
//   import { server } from '@/test/msw-server';
//   import { renderWithRuntime } from '@/test/render-with-runtime';
import { describe, it } from 'vitest';

describe('Shell: workspace panel (FR-11, AC-11.1 / AC-11.3)', () => {
  // AC-11.1: "When загружается / или /chat/<id> на десктопе, the system shall не показывать рабочую область."
  // EARS: When (event: page load at ≥ 1024 px)
  // ROI: 6.2 | Business Value: 6 (chat gets full width by default) | Frequency: 10 | Legal: false | Defect Detection: 6
  // Behavior: render at '/', desktop media → button «Рабочая область» aria-expanded="false"; no complementary «Рабочая область»
  // Fails when: the panel is open by default (pre-feature layout kept a permanent 60 % panel)
  // @category: core-functionality
  // @dependency: ChatShell, ChatHeader (HD-04), WorkspacePanel, MSW
  // @complexity: low
  it.todo('AC-11.1: workspace panel is hidden on load at desktop width' /*
    Arrange:
      - GET /api/threads → 200 { threads: [], nextCursor: null }
      - renderWithRuntime({ pathname: '/', media: { '(min-width: 1024px)': true, '(min-width: 768px)': true } })
    Act:
      - await screen.findByText('Пока нет бесед')
    Assert:
      - queryByRole('complementary', { name: 'Рабочая область' }) === null
      - getByRole('button', { name: 'Рабочая область' }) has aria-expanded="false"
  */);

  // AC-11.3: "When нажата та же кнопка или «×», the system shall скрыть панель, фокус — на кнопку в шапке."
  // EARS: When (event: close via WS-03 «×»)
  // ROI: 6.5 | Business Value: 6 | Frequency: 5 | Legal: false | Defect Detection: 8 (focus is lost when the focused «×» unmounts)
  // Behavior: click HD-04 → panel visible, aria-expanded="true" → click «Закрыть рабочую область» → panel gone, focus on HD-04
  // Fails when: closing via «×» leaves focus on <body> or the panel stays mounted/visible
  // @category: ux
  // @dependency: ChatShell (workspaceOpen state), ChatHeader (HD-04), WorkspacePanel (WS-03)
  // @complexity: medium
  it.todo('AC-11.3: closing the workspace with «×» hides it and moves focus to the header button' /*
    Arrange:
      - GET /api/threads → 200 { threads: [], nextCursor: null }
      - renderWithRuntime({ pathname: '/', media: { '(min-width: 1024px)': true, '(min-width: 768px)': true } })
    Act:
      - click button "Рабочая область"
      - (intermediate) getByRole('complementary', { name: 'Рабочая область' }) present; button aria-expanded="true";
        text "Здесь появятся артефакты инструментов: таблицы, документы, графики." visible
      - click button "Закрыть рабочую область"
    Assert:
      - queryByRole('complementary', { name: 'Рабочая область' }) === null
      - button "Рабочая область" has aria-expanded="false"
      - document.activeElement === getByRole('button', { name: 'Рабочая область' })
  */);

  // AC-11.3 (same-button branch): "When нажата та же кнопка …"
  // ROI: 5.8 | Business Value: 6 | Frequency: 5 | Legal: false | Defect Detection: 5
  // Behavior: click HD-04 (open) → click HD-04 (close) → panel gone, focus stays on HD-04
  // Fails when: the toggle only opens, or focus jumps into the panel/body on close
  // @category: ux
  // @dependency: ChatShell, ChatHeader (HD-04), WorkspacePanel
  // @complexity: low
  it.todo('AC-11.3: the header button toggles the workspace and keeps focus on itself' /*
    Arrange:
      - GET /api/threads → 200 { threads: [], nextCursor: null }
      - renderWithRuntime({ pathname: '/', media: { '(min-width: 1024px)': true, '(min-width: 768px)': true } })
    Act:
      - click button "Рабочая область" (open); click button "Рабочая область" (close)
    Assert:
      - after open: complementary "Рабочая область" present; document.activeElement is button "Рабочая область"
      - after close: queryByRole('complementary', { name: 'Рабочая область' }) === null; aria-expanded="false";
        document.activeElement is button "Рабочая область"
  */);
});
