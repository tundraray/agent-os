import { Assistant } from '@/components/assistant';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';

export default function Home() {
  return (
    <ResizablePanelGroup orientation="horizontal" className="h-dvh">
      <ResizablePanel defaultSize="40%" minSize="25%">
        <Assistant agentId="assistant" />
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel defaultSize="60%" minSize="25%">
        {/* Workspace: artifacts from assistant-ui Tool UI will render here. */}
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
          Рабочая область
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
