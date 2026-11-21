import { type INestApplication, ValidationPipe } from '@nestjs/common';

/**
 * HTTP surface shared by `main.ts` and the e2e test app: global `/api` prefix and the
 * class-validator pipe for DTO routes. No CORS: the browser reaches the API only through the web's
 * `/api` forwarding, on the web's own origin.
 */
export function configureApp(app: INestApplication): void {
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
}
