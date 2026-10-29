import type { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Agent } from '@mastra/core/agent';
import { GENERATED_THREAD_TITLE_MAX_LENGTH } from '@agent-os/contracts';
import { type ModelId, parseModelId } from '../mastra/models.js';

/** Token of the agent that names threads; it is not registered in `Mastra`. */
export const THREAD_TITLE_AGENT = Symbol('THREAD_TITLE_AGENT');

export const THREAD_TITLE_INSTRUCTIONS =
  'Сформулируй короткий заголовок беседы по сообщению пользователя: до 6 слов и не длиннее 80 символов, на том же языке, что и сообщение. Не повторяй сообщение дословно. Без кавычек, двоеточий, эмодзи и точки в конце. Ответь только заголовком.';

/** Stateless one-shot agent: no memory, no tools, no reasoning provider options. */
export function createThreadTitleAgent(model: ModelId): Agent {
  return new Agent({
    id: 'thread-title',
    name: 'Thread title',
    instructions: THREAD_TITLE_INSTRUCTIONS,
    model,
  });
}

const THINK_BLOCK = /<think>[\s\S]*?<\/think>/gi;
const FRAMING_QUOTES = /^[«»"'`]+|[«»"'`]+$/g;
const WHITESPACE_RUN = /\s+/g;

/**
 * Turns a raw model answer into a thread title of at most 80 characters, or `''` when nothing
 * usable remains. Truncation counts code points so a surrogate pair is never split.
 */
export function normalizeGeneratedTitle(text: string): string {
  const withoutThinking = text.replace(THINK_BLOCK, '');
  const firstLine =
    withoutThinking
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line !== '') ?? '';
  const collapsed = firstLine
    .replace(FRAMING_QUOTES, '')
    .replace(WHITESPACE_RUN, ' ');
  return Array.from(collapsed)
    .slice(0, GENERATED_THREAD_TITLE_MAX_LENGTH)
    .join('')
    .trim();
}

/** Uses `TITLE_MODEL`, else `ASSISTANT_MODEL`; the model is resolved lazily, so no network at startup. */
export function createThreadTitleAgentFromConfig(config: ConfigService): Agent {
  return createThreadTitleAgent(
    parseModelId(
      config.get<string>('TITLE_MODEL') ??
        config.get<string>('ASSISTANT_MODEL'),
    ),
  );
}

export const threadTitleAgentProvider: Provider = {
  provide: THREAD_TITLE_AGENT,
  inject: [ConfigService],
  useFactory: createThreadTitleAgentFromConfig,
};
