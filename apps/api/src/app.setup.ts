import { type INestApplication, ValidationPipe } from '@nestjs/common';

/**
 * HTTP surface shared by `main.ts` and the e2e test app: global `/api` prefix,
 * CORS for the web frontend and the class-validator pipe for DTO routes.
 */
export function configureApp(app: INestApplication): void {
  app.setGlobalPrefix('api');
  app.enableCors({
    origin: process.env.FRONTEND_ORIGIN ?? 'http://localhost:3000',
    credentials: true,
  });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
}
