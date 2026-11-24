import { Controller, Get, Inject, Req } from '@nestjs/common';
import { AgentsProviders } from '@agent-os/agents';
import type { MyModels } from '@agent-os/contracts';
import type { AuthedRequest } from '../identity/auth-user';
import { AccessService } from './access.service';

/**
 * "My access" of the signed-in employee (design-access.md, Contract «Для веба — сотрудник»). It lives in
 * `AccessAdminModule` because the readiness of the models' providers comes from `AgentsProviders`
 * (port-module-split.md).
 */
@Controller('access')
export class MyAccessController {
  constructor(
    private readonly access: AccessService,
    @Inject(AgentsProviders) private readonly providers: AgentsProviders,
  ) {}

  /** The chat models allowed now, by name, with this month's spend, quota and `unavailableReason`. */
  @Get('models')
  models(@Req() req: AuthedRequest): Promise<MyModels> {
    return this.access.myModels(req.user.id, (names) =>
      this.providers.readiness(names),
    );
  }
}
