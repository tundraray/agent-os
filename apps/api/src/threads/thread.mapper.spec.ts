import { NotFoundException } from '@nestjs/common';
import { ErrorCategory, ErrorDomain, MastraError } from '@mastra/core/error';
import type { StorageThreadType } from '@mastra/core/memory';
import { maskHistoryErrors, toThreadSummary } from './thread.mapper.js';
import { isMastraUserError, threadNotFound } from './threads.errors.js';

const storedThread = (
  overrides: Partial<StorageThreadType> = {},
): StorageThreadType => ({
  id: 'thread-1',
  title: 'План отпуска',
  resourceId: 'user-1',
  createdAt: new Date(Date.UTC(2026, 9, 28, 9, 15, 30, 123)),
  updatedAt: new Date(Date.UTC(2026, 9, 28, 10, 0, 0, 7)),
  metadata: { secret: 'internal' },
  ...overrides,
});

describe('toThreadSummary', () => {
  it('maps an empty stored title to null', () => {
    expect(toThreadSummary(storedThread({ title: '' })).title).toBeNull();
  });

  it('maps a missing stored title to null', () => {
    expect(
      toThreadSummary(storedThread({ title: undefined })).title,
    ).toBeNull();
  });

  it('keeps a non-empty title as is', () => {
    expect(toThreadSummary(storedThread({ title: '  Байкал  ' })).title).toBe(
      '  Байкал  ',
    );
  });

  it('projects only id, title and ISO UTC dates with milliseconds', () => {
    expect(toThreadSummary(storedThread())).toEqual({
      id: 'thread-1',
      title: 'План отпуска',
      createdAt: '2026-10-28T09:15:30.123Z',
      updatedAt: '2026-10-28T10:00:00.007Z',
    });
  });
});

// AC-14.5: a tool error in the history shows the same text as the live stream, never the raw message;
// a model error part (not a v7 UIMessage part) is dropped.
describe('maskHistoryErrors', () => {
  it('replaces errorText of output-error tool-* and dynamic-tool parts with Agent error', () => {
    const masked = maskHistoryErrors([
      {
        id: 'm-1',
        role: 'assistant',
        parts: [
          {
            type: 'tool-failing',
            toolCallId: 'call-1',
            state: 'output-error',
            input: {},
            errorText: 'boom',
          },
          {
            type: 'dynamic-tool',
            toolName: 'external',
            toolCallId: 'call-2',
            state: 'output-error',
            input: { q: 1 },
            errorText: 'connection refused at 10.0.0.5',
          },
        ],
      },
    ]);

    expect(masked).toEqual([
      {
        id: 'm-1',
        role: 'assistant',
        parts: [
          {
            type: 'tool-failing',
            toolCallId: 'call-1',
            state: 'output-error',
            input: {},
            errorText: 'Agent error',
          },
          {
            type: 'dynamic-tool',
            toolName: 'external',
            toolCallId: 'call-2',
            state: 'output-error',
            input: { q: 1 },
            errorText: 'Agent error',
          },
        ],
      },
    ]);
  });

  it('returns output-available tool, text and reasoning parts unchanged', () => {
    const masked = maskHistoryErrors([
      { id: 'u-1', role: 'user', parts: [{ type: 'text', text: 'Погода?' }] },
      {
        id: 'm-2',
        role: 'assistant',
        parts: [
          { type: 'reasoning', text: 'Нужно узнать погоду.', state: 'done' },
          {
            type: 'tool-getWeather',
            toolCallId: 'call-3',
            state: 'output-available',
            input: { city: 'Казань' },
            output: { temperatureC: 21 },
          },
          { type: 'text', text: 'Солнечно.' },
        ],
      },
    ]);

    expect(masked).toEqual([
      { id: 'u-1', role: 'user', parts: [{ type: 'text', text: 'Погода?' }] },
      {
        id: 'm-2',
        role: 'assistant',
        parts: [
          { type: 'reasoning', text: 'Нужно узнать погоду.', state: 'done' },
          {
            type: 'tool-getWeather',
            toolCallId: 'call-3',
            state: 'output-available',
            input: { city: 'Казань' },
            output: { temperatureC: 21 },
          },
          { type: 'text', text: 'Солнечно.' },
        ],
      },
    ]);
  });

  it('drops a model error part and keeps the parts saved before the error', () => {
    const masked = maskHistoryErrors([
      {
        id: 'm-3',
        role: 'assistant',
        parts: [
          { type: 'text', text: 'Частичный' },
          {
            type: 'error',
            error: { name: 'Error', message: 'mock stream failure' },
          },
        ],
      },
    ]);

    expect(masked).toEqual([
      {
        id: 'm-3',
        role: 'assistant',
        parts: [{ type: 'text', text: 'Частичный' }],
      },
    ]);
  });

  it('keeps a reply that consisted only of an error part, with no parts', () => {
    const masked = maskHistoryErrors([
      {
        id: 'm-4',
        role: 'assistant',
        parts: [
          {
            type: 'error',
            error: { name: 'Error', message: 'mock stream failure' },
          },
        ],
      },
    ]);

    expect(masked).toEqual([{ id: 'm-4', role: 'assistant', parts: [] }]);
  });
});

describe('threadNotFound', () => {
  it('builds the single 404 THREAD_NOT_FOUND body', () => {
    const error = threadNotFound();

    expect(error).toBeInstanceOf(NotFoundException);
    expect(error.getStatus()).toBe(404);
    expect(error.getResponse()).toEqual({
      message: 'Thread not found',
      error: 'Not Found',
      statusCode: 404,
      errorCode: 'THREAD_NOT_FOUND',
    });
  });
});

describe('isMastraUserError', () => {
  const mastraError = (category: ErrorCategory): MastraError =>
    new MastraError({
      id: 'MASTRA_STORAGE_UPDATE_THREAD_FAILED',
      domain: ErrorDomain.STORAGE,
      category,
      text: 'Thread t-1 not found',
    });

  it('is true for a MastraError of category USER', () => {
    expect(isMastraUserError(mastraError(ErrorCategory.USER))).toBe(true);
  });

  it('is false for a MastraError of another category', () => {
    expect(isMastraUserError(mastraError(ErrorCategory.THIRD_PARTY))).toBe(
      false,
    );
  });

  it('is false for a plain Error', () => {
    expect(isMastraUserError(new Error('db down'))).toBe(false);
  });
});
