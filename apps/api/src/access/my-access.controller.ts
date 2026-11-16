import { Controller, Get, Req } from '@nestjs/common';
import type { MyModels } from '@agent-os/contracts';
import type { AuthedRequest } from '../identity/auth-user.js';
import { AccessService } from './access.service.js';

/** "My access" of the signed-in employee (design-access.md, Contract «Для веба — сотрудник»). */
@Controller('access')
export class MyAccessController {
  constructor(private readonly access: AccessService) {}

  /** The models allowed now, by name, with this month's spend and quota. */
  @Get('models')
  models(@Req() req: AuthedRequest): Promise<MyModels> {
    return this.access.myModels(req.user.id);
  }
}
