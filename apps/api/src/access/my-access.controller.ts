import { Controller, Get, Inject, Req } from '@nestjs/common';
import type { Agents } from '@agent-os/agents';
import type { MyModels } from '@agent-os/contracts';
import { AGENTS } from '../agents/agents.tokens';
import type { AuthedRequest } from '../identity/auth-user';
import { AccessService } from './access.service';

/**
 * "My access" of the signed-in employee (design-access.md, Contract «Для веба — сотрудник»). It lives in
 * `AccessAdminModule` because the readiness of the models' providers comes from `Agents.providers`
 * (port-module-split.md).
 */
@Controller('access')
export class MyAccessController {
  constructor(
    private readonly access: AccessService,
    @Inject(AGENTS) private readonly agents: Agents,
  ) {}

  /** The chat models allowed now, by name, with this month's spend, quota and `unavailableReason`. */
  @Get('models')
  models(@Req() req: AuthedRequest): Promise<MyModels> {
    return this.access.myModels(req.user.id, (names) =>
      this.agents.providers.readiness(names),
    );
  }
}
