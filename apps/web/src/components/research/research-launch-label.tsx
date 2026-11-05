import { TelescopeIcon } from 'lucide-react';

/** DR-02: marks the user message that started a deep research by the user's choice; read before the message text. */
export function ResearchLaunchLabel() {
  return (
    <p className="text-muted-foreground flex items-center justify-end gap-1 text-xs font-medium">
      <TelescopeIcon aria-hidden className="size-3.5 shrink-0" />
      Глубокий ресерч
    </p>
  );
}
