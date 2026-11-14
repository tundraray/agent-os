import { describe, expect, it, vi } from 'vitest';
import { createLogger, sentrySink, type LogLevel, type Logger, type SentrySdk } from './index.js';
import { memorySink, type MemorySink } from './testing.js';

// DC-11 / UC-9: the logger redacts, expands and truncates before both sinks.

const SECRET = 'sk-live-123';

function sentryDouble() {
  return {
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    captureException: vi.fn(),
  } satisfies SentrySdk;
}

function setup(minLevel: LogLevel = 'debug', secrets: string[] = [SECRET]) {
  const memory = memorySink();
  const sentry = sentryDouble();
  const logger = createLogger({ sinks: [memory, sentrySink(sentry)], secrets, minLevel });
  return { memory, sentry, logger };
}

function only(memory: MemorySink) {
  expect(memory.records).toHaveLength(1);
  return memory.records[0]!;
}

describe('logger redacts, expands and truncates before both sinks', () => {
  it.each<[string, Record<string, unknown>, Record<string, unknown>]>([
    [
      'field by name in any case',
      { Password: 'p1', TOKEN: 't1', apiKey: 'k1', Authorization: 'Bearer x', user: 'ann' },
      { Password: '[redacted]', TOKEN: '[redacted]', apiKey: '[redacted]', Authorization: '[redacted]', user: 'ann' },
    ],
    [
      'field by name in a nested object and array',
      { request: { headers: { cookie: 'c=1', accept: 'json' } }, list: [{ dsn: 'https://d' }, 'plain'] },
      { request: { headers: { cookie: '[redacted]', accept: 'json' } }, list: [{ dsn: '[redacted]' }, 'plain'] },
    ],
    [
      'secret value inside a field string',
      { url: `https://api?key=${SECRET}&x=1`, nested: [`a ${SECRET} b`] },
      { url: 'https://api?key=[redacted]&x=1', nested: ['a [redacted] b'] },
    ],
  ])('%s', (_name, fields, expected) => {
    const { memory, sentry, logger } = setup();

    logger.info('call done', fields);

    expect(only(memory).fields).toEqual(expected);
    expect(sentry.logger.info).toHaveBeenCalledTimes(1);
    expect(sentry.logger.info).toHaveBeenCalledWith('call done', expected);
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it('redacts a secret value in the message', () => {
    const { memory, sentry, logger } = setup();

    logger.warn(`retry with ${SECRET}`);

    expect(only(memory)).toMatchObject({ level: 'warn', message: 'retry with [redacted]', fields: {} });
    expect(sentry.logger.warn).toHaveBeenCalledWith('retry with [redacted]', {});
  });

  it('ignores empty secrets', () => {
    const { memory, logger } = setup('debug', ['', SECRET]);

    logger.info('plain text', { note: 'kept as is' });

    expect(only(memory)).toMatchObject({ message: 'plain text', fields: { note: 'kept as is' } });
  });

  it('redacts by value only secrets of 8 or more characters; a shorter one still by field name', () => {
    const { memory, logger } = setup('debug', ['agent', 'pass-123']);

    logger.info('agents started with pass-123', { table: 'agent_sessions', password: 'agent' });

    expect(only(memory)).toMatchObject({
      message: 'agents started with [redacted]',
      fields: { table: 'agent_sessions', password: '[redacted]' },
    });
  });

  it('expands error with cause and stack, redacted, into both sinks', () => {
    const { memory, sentry, logger } = setup();
    const cause = new TypeError(`bad key ${SECRET}`);
    cause.stack = 'TypeError: bad key\n    at inner';
    const error = new Error('request failed', { cause });
    error.stack = 'Error: request failed\n    at outer';

    logger.error('step failed', { error, taskId: 't-1' });

    const expectedFields = {
      taskId: 't-1',
      error: {
        name: 'Error',
        message: 'request failed',
        stack: 'Error: request failed\n    at outer',
        cause: { name: 'TypeError', message: 'bad key [redacted]', stack: 'TypeError: bad key\n    at inner' },
      },
    };
    expect(only(memory).fields).toEqual(expectedFields);
    expect(sentry.logger.error).toHaveBeenCalledTimes(1);
    expect(sentry.logger.error).toHaveBeenCalledWith('step failed', expectedFields);
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    const [captured, context] = sentry.captureException.mock.calls[0]!;
    expect(captured).toBeInstanceOf(Error);
    expect(captured).toMatchObject({ name: 'Error', message: 'request failed', stack: 'Error: request failed\n    at outer' });
    expect(context).toEqual({ extra: expectedFields });
  });

  it('builds the Sentry exception from the redacted error', () => {
    const { sentry, logger } = setup();

    logger.error('auth failed', { error: new Error(`token ${SECRET} rejected`) });

    const [captured] = sentry.captureException.mock.calls[0]!;
    expect((captured as Error).message).toBe('token [redacted] rejected');
  });

  it('expands a non-Error thrown value into a message', () => {
    const { memory, logger } = setup();

    logger.error('odd throw', { error: 42 });

    expect(only(memory).fields).toEqual({ error: { message: '42' } });
  });

  it('truncates a string longer than 16 KiB with the number of cut bytes', () => {
    const { memory, logger } = setup();
    const long = 'a'.repeat(16 * 1024 + 10);

    logger.info('big', { body: long });

    expect(only(memory).fields).toEqual({ body: `${'a'.repeat(16 * 1024)}…[truncated 10 bytes]` });
  });

  it('child adds its fields to every record', () => {
    const { memory, logger } = setup();
    const child: Logger = logger.child({ taskId: 't-1' }).child({ stepId: 's-2' });

    child.info('step started', { durationMs: 5 });

    expect(only(memory).fields).toEqual({ taskId: 't-1', stepId: 's-2', durationMs: 5 });
  });

  it('minLevel drops records below it', () => {
    const { memory, sentry, logger } = setup('warn');

    logger.debug('d');
    logger.info('i');
    logger.warn('w');

    expect(only(memory)).toMatchObject({ level: 'warn', message: 'w' });
    expect(sentry.logger.debug).not.toHaveBeenCalled();
    expect(sentry.logger.info).not.toHaveBeenCalled();
    expect(sentry.logger.warn).toHaveBeenCalledTimes(1);
  });
});
