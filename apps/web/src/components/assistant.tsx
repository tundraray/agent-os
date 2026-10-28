'use client';
import { AssistantRuntimeProvider } from '@assistant-ui/react';
import { AssistantChatTransport, useChatRuntime } from '@assistant-ui/ai-sdk';
import { lastAssistantMessageIsCompleteWithToolCalls } from 'ai';
import { Thread } from '@/components/assistant-ui/elements/thread.aui';

export function Assistant({ agentId }: { agentId: string }) {
  const runtime = useChatRuntime({
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
    transport: new AssistantChatTransport({
      api: `${process.env.NEXT_PUBLIC_API_URL}/api/chat/${agentId}`,
      credentials: 'include',
    }),
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread />
    </AssistantRuntimeProvider>
  );
}
