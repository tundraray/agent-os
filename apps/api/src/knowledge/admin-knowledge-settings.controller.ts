import { Body, Controller, Get, Inject, Put, Req } from '@nestjs/common';
import { AgentsKnowledge } from '@agent-os/agents';
import { LOGGER, type Logger } from '@agent-os/common';
import {
  UpdateKnowledgeSettingsBodySchema,
  type KnowledgeSettings,
  type UpdateKnowledgeSettingsBody,
} from '@agent-os/contracts';
import { AuditLog } from '../audit/audit-log';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AdminOnly } from '../identity/admin-only.decorator';
import type { AuthedRequest } from '../identity/auth-user';
import { loggedRoute } from '../common/logged-route';

const SETTINGS_OBJECT_TYPE = 'knowledge_settings';

/** «Было/стало» of the audit: the two values, as the other settings rows write them. */
function auditState(settings: KnowledgeSettings): Record<string, unknown> {
  return {
    limitTokens: settings.limitTokens,
    lessonsEnabled: settings.lessonsEnabled,
  };
}

/**
 * The knowledge settings for an administrator (self-learning design-core.md, KD-7, settings-row.md): the
 * limit of the knowledge block and the lessons switch. The body is checked by the contract schema
 * (400 VALIDATION_FAILED, nothing changes); a write is audited after it as `admin_change` on
 * `knowledge_settings` with «было» and «стало».
 */
@Controller('admin/knowledge')
@AdminOnly()
export class AdminKnowledgeSettingsController {
  private readonly logger: Logger;

  constructor(
    @Inject(AgentsKnowledge) private readonly knowledge: AgentsKnowledge,
    private readonly auditLog: AuditLog,
    @Inject(LOGGER) logger: Logger,
  ) {
    this.logger = logger.child({ service: 'knowledge.routes' });
  }

  /** `KnowledgeSettings`. */
  @Get('settings')
  settings(@Req() req: AuthedRequest): Promise<KnowledgeSettings> {
    return loggedRoute(this.logger, {
      route: 'GET /admin/knowledge/settings',
      fields: { actorId: req.user.id },
      work: () => this.knowledge.settings(),
    });
  }

  /** `KnowledgeSettings` after the change. */
  @Put('settings')
  update(
    @Body(new ZodValidationPipe(UpdateKnowledgeSettingsBodySchema))
    body: UpdateKnowledgeSettingsBody,
    @Req() req: AuthedRequest,
  ): Promise<KnowledgeSettings> {
    const actor = req.user.id;
    return loggedRoute(this.logger, {
      route: 'PUT /admin/knowledge/settings',
      fields: { actorId: actor },
      work: async () => {
        const { before, after } = await this.knowledge.updateSettings({
          actorId: actor,
          limitTokens: body.limitTokens,
          lessonsEnabled: body.lessonsEnabled,
        });
        await this.auditLog.record(null, {
          kind: 'admin_change',
          actor,
          objectType: SETTINGS_OBJECT_TYPE,
          before: auditState(before),
          after: auditState(after),
          outcome: 'ok',
        });
        return after;
      },
      outcomeOf: (after) => ({
        limitTokens: after.limitTokens,
        lessonsEnabled: after.lessonsEnabled,
      }),
    });
  }
}
