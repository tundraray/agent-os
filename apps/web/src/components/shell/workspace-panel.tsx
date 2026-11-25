'use client';

import {
  useEffect,
  useRef,
  type ComponentProps,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { Drawer } from '@base-ui/react/drawer';
import { XIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { usePanelRef, type PanelSize } from 'react-resizable-panels';
import { useStore } from 'zustand';
import { TooltipIconButton } from '@/components/tooltip-icon-button';
import { ResizableHandle, ResizablePanel } from '@/components/ui/resizable';
import { useShellServices } from './shell-actions';

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
  /** The panel's content under its heading. */
  children: ReactNode;
  /** A test run's or a training's conversation: the panel is «Ход и итог» (self-learning UXRD TR-01, MC-10). */
  run: boolean;
};

/**
 * WS-01…WS-03, named «Схема» (deep-agents UXRD DA-12, KD-7): the resize handle and the collapsible panel;
 * rendered as direct children of the shell's `ResizablePanelGroup`, and only while the panel is open from 1024 px.
 */
export function WorkspacePanel({
  defaultSize,
  onClose,
  children,
  run,
}: WorkspacePanelProps) {
  const t = useTranslations('shell.schema');
  const panelRef = usePanelRef();

  // A drag past the collapse threshold closes the panel instead of leaving an open, zero-width one.
  const closeWhenCollapsed = (
    size: PanelSize,
    _id: string | number | undefined,
    previous: PanelSize | undefined,
  ) => {
    if (previous !== undefined && previous.inPixels > 0 && size.inPixels === 0)
      onClose();
  };

  // WS-02 keyboard steps in pixels (UXRD 6.22); runs before the library's own percent-based handler.
  const resizeByKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    const panel = panelRef.current;
    if (panel === null) return;
    const step = event.shiftKey ? KEY_STEP_LARGE_PX : KEY_STEP_PX;
    const width = panel.getSize().inPixels;
    // The handle sits on the panel's left edge: moving it left widens the panel.
    if (event.key === 'ArrowLeft') panel.resize(`${width + step}px`);
    else if (event.key === 'ArrowRight')
      panel.resize(`${Math.max(MIN_WIDTH_PX, width - step)}px`);
    else if (event.key === 'End') panel.resize(WORKSPACE_MIN_WIDTH);
    else return;
    event.preventDefault();
  };

  return (
    <>
      <ResizableHandle
        aria-label={t('resize')}
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
        <aside
          id={WORKSPACE_ID}
          aria-label={t(run ? 'runTitle' : 'title')}
          className="flex h-full min-w-0 flex-col"
        >
          <WorkspaceHeading onClose={onClose} run={run} />
          <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-6">
            {children}
          </div>
        </aside>
      </ResizablePanel>
    </>
  );
}

type WorkspaceDrawerProps = {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  run: boolean;
};

/**
 * The same panel below 1024 px: a modal drawer on the right, 400 px wide and the full width below 480 px
 * (UXRD Responsive Behavior). Only the header button opens it; Esc and «×» close it and focus returns there.
 */
export function WorkspaceDrawer({
  open,
  onClose,
  children,
  run,
}: WorkspaceDrawerProps) {
  const t = useTranslations('shell.schema');
  return (
    <Drawer.Root
      open={open}
      onOpenChange={(next) => !next && onClose()}
      swipeDirection="right"
    >
      <Drawer.Portal>
        <Drawer.Backdrop className="fixed inset-0 z-50 bg-black/10 transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0 motion-reduce:transition-none supports-backdrop-filter:backdrop-blur-xs" />
        <Drawer.Viewport className="fixed inset-0 z-50 flex justify-end">
          <Drawer.Popup
            id={WORKSPACE_ID}
            aria-label={t(run ? 'runTitle' : 'title')}
            initialFocus={headingElement}
            finalFocus={toggleElement}
            className="bg-background flex h-full w-[400px] max-w-full flex-col border-l shadow-lg outline-none transition-transform duration-200 ease-out data-ending-style:translate-x-full data-starting-style:translate-x-full motion-reduce:transition-none max-[480px]:w-full"
          >
            <WorkspaceHeading onClose={onClose} run={run} />
            <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-6">
              {children}
            </div>
          </Drawer.Popup>
        </Drawer.Viewport>
      </Drawer.Portal>
    </Drawer.Root>
  );
}

/** The panel's heading: the drawer opens only by a button, so it always starts there. */
const headingElement = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[data-workspace-heading]');

/** The header button «Схема» (HD-04) or «Ход и итог»: where focus returns when the panel or the drawer closes. */
export function toggleElement(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    '[data-shell-focus="workspace-toggle"]',
  );
}

/**
 * «Ход и итог» (self-learning UXRD TR-01, create-and-test UXRD CT-06) of the header and of every test run card:
 * opens the panel on the run's tab and leaves focus on the button (KD-6); a press on an open panel closes it, as «Схема».
 */
export function RunButton({
  className,
  children,
  ...props
}: ComponentProps<'button'> & { className: string }) {
  const t = useTranslations('shell.schema');
  const { workspace } = useShellServices();
  const open = useStore(workspace, (state) => state.open);
  return (
    <button
      {...props}
      type="button"
      className={className}
      aria-expanded={open}
      aria-controls={open ? WORKSPACE_ID : undefined}
      data-shell-focus="workspace-toggle"
      onClick={() =>
        open
          ? workspace.close()
          : workspace.show({ tab: 'run', focusHeading: false })
      }
    >
      {children ?? t('runTitle')}
    </button>
  );
}

/**
 * The heading «Схема» and «×». An open by «Показать схему» or the header button puts focus on the heading; an
 * automatic open leaves it in the feed (deep-agents UXRD, Accessibility).
 */
function WorkspaceHeading({
  onClose,
  run,
}: {
  onClose: () => void;
  run: boolean;
}) {
  const t = useTranslations('shell.schema');
  const { workspace } = useShellServices();
  const focusHeading = useStore(workspace, (state) => state.focusHeading);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (!focusHeading) return;
    headingRef.current?.focus();
    workspace.headingFocused();
  }, [focusHeading, workspace]);

  return (
    <div className="flex h-(--header-height) shrink-0 items-center justify-between gap-2 px-3">
      <h2
        ref={headingRef}
        tabIndex={-1}
        data-workspace-heading=""
        className="truncate text-sm font-medium outline-none"
      >
        {t(run ? 'runTitle' : 'title')}
      </h2>
      <TooltipIconButton
        tooltip={t(run ? 'runClose' : 'close')}
        className="size-8 pointer-coarse:size-11 [&_svg]:size-4.5"
        onClick={onClose}
      >
        <XIcon aria-hidden />
      </TooltipIconButton>
    </div>
  );
}
