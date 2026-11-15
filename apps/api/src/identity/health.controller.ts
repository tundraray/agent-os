import { Controller, Get } from '@nestjs/common';
import { Public } from './public.decorator.js';

/** `GET /api/health`: 200 with an empty body while the process accepts requests. */
@Controller('health')
export class HealthController {
  @Public()
  @Get()
  health(): void {}
}
