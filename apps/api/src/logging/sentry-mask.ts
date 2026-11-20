import { createSecretMasker, withoutQueryParamsText } from '@agent-os/common';

/** The part of a Sentry event whose text an error the SDK captured by itself carries. */
interface EventWithExceptions {
  exception?: { values?: { value?: string }[] };
}

// Reads the process's secret memory on every call, so a key set while the server runs is redacted too.
const maskSecrets = createSecretMasker([]);

/**
 * `beforeSend` of Sentry: an error the SDK captures by itself (unhandled, uncaught) does not pass the
 * logger, so its exception texts lose a failed query's bound values and every remembered secret here,
 * as the logger does (design-core.md, KD-7).
 */
export function maskSentryEvent<T extends EventWithExceptions>(event: T): T {
  for (const exception of event.exception?.values ?? []) {
    if (exception.value !== undefined)
      exception.value = maskSecrets(withoutQueryParamsText(exception.value));
  }
  return event;
}
