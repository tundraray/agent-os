import { ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';

/** Room for a deep agent with tens of scripts of 64 KiB each (KD-6); a larger body is refused with 413. */
const JSON_BODY_LIMIT = '2mb';

/**
 * HTTP surface shared by `main.ts` and the e2e test app: global `/api` prefix, the JSON body limit and the
 * class-validator pipe for DTO routes. No CORS: the browser reaches the API only through the web's
 * `/api` forwarding, on the web's own origin.
 */
export function configureApp(app: NestExpressApplication): void {
  app.setGlobalPrefix('api');
  app.useBodyParser('json', { limit: JSON_BODY_LIMIT });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
}
