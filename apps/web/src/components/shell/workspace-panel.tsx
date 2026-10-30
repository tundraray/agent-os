'use client';

import type { KeyboardEvent } from 'react';
import { XIcon } from 'lucide-react';
import { usePanelRef, type PanelSize } from 'react-resizable-panels';
import { TooltipIconButton } from '@/components/tooltip-icon-button';
import { ResizableHandle, ResizablePanel } from '@/components/ui/resizable';

/** WS-01 element id: the target of HD-04 `aria-controls`. */
export const WORKSPACE_ID = 'workspace-panel';

/** Panel id inside the shell's `ResizablePanelGroup`; its share of the group comes back in `onLayoutChanged`. */
export const WORKSPACE_PANEL_ID = 'workspace';

/** Width limits (UXRD 6.22): the panel ≥ 360 px, the thread feed ≥ 480 px. */
const WORKSPACE_MIN_WIDTH = '360px';
export const FEED_MIN_WIDTH = '480px';

/** Width the panel opens with until the user drags it: 40 % of the main area. */
export const WORKSPACE_DEFAULT_SIZE = '40%';

const KEY_STEP_PX = 16;
const KEY_STEP_LARGE_PX = 64;
const MIN_WIDTH_PX = 360;

type WorkspacePanelProps = {
  /** Size to open with: the width chosen earlier in this tab session (percent of the group) or the default. */
  defaultSize: number | string;
  /** WS-03 «×», or the panel dragged down to its collapsed size. */
  onClose: () => void;
};

/**
 * WS-01…WS-03: the resize handle and the collapsible panel; rendered as direct children of the shell's
 * `ResizablePanelGroup`, and only while the workspace is open.
 */
export function WorkspacePanel({ defaultSize, onClose }: WorkspacePanelProps) {
  const panelRef = usePanelRef();

  // A drag past the collapse threshold closes the workspace instead of leaving an open, zero-width panel.
  const closeWhenCollapsed = (size: PanelSize, _id: string | number | undefined, previous: PanelSize | undefined) => {
    if (previous !== undefined && previous.inPixels > 0 && size.inPixels === 0) onClose();
  };

  // WS-02 keyboard steps in pixels (UXRD 6.22); runs before the library's own percent-based handler.
  const resizeByKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    const panel = panelRef.current;
    if (panel === null) return;
    const step = event.shiftKey ? KEY_STEP_LARGE_PX : KEY_STEP_PX;
    const width = panel.getSize().inPixels;
    // The handle sits on the panel's left edge: moving it left widens the panel.
    if (event.key === 'ArrowLeft') panel.resize(`${width + step}px`);
    else if (event.key === 'ArrowRight') panel.resize(`${Math.max(MIN_WIDTH_PX, width - step)}px`);
    else if (event.key === 'End') panel.resize(WORKSPACE_MIN_WIDTH);
    else return;
    event.preventDefault();
  };

  return (
    <>
      <ResizableHandle
        aria-label="Изменить ширину рабочей области"
        onKeyDownCapture={resizeByKeyboard}
        className="data-[separator=hover]:bg-ring data-[separator=active]:bg-ring after:w-2 focus-visible:ring-2"
      />
      <ResizablePanel
        id={WORKSPACE_PANEL_ID}
        panelRef={panelRef}
        defaultSize={defaultSize}
        minSize={WORKSPACE_MIN_WIDTH}
        collapsible
        collapsedSize={0}
        onResize={closeWhenCollapsed}
      >
        <aside id={WORKSPACE_ID} aria-label="Рабочая область" className="flex h-full min-w-0 flex-col">
          <div className="flex h-(--header-height) shrink-0 items-center justify-between gap-2 px-3">
            <span className="truncate text-sm font-medium">Рабочая область</span>
            <TooltipIconButton tooltip="Закрыть рабочую область" className="size-8 [&_svg]:size-4.5" onClick={onClose}>
              <XIcon aria-hidden />
            </TooltipIconButton>
          </div>
          <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-6">
            <p className="text-muted-foreground max-w-xs text-center text-sm">
              Здесь появятся артефакты инструментов: таблицы, документы, графики.
            </p>
          </div>
        </aside>
      </ResizablePanel>
    </>
  );
}
