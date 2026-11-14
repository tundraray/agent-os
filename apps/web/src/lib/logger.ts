import * as Sentry from '@sentry/nextjs';
import { consoleSink, createLogger, sentrySink } from '@agent-os/common';

/**
 * The web app's only way to write a log, on the Next server and in the browser alike
 * (design-runtime.md, KD-6). The web app holds no secret values, so redaction relies on
 * the logger's field-name rule only.
 */
export const logger = createLogger({
  sinks: [consoleSink(), sentrySink(Sentry)],
  secrets: [],
  minLevel: 'debug',
});
