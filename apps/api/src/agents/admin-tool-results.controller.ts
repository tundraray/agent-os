import { Body, Controller, Get, Inject, Put, Req } from '@nestjs/common';
import type { Agents } from '@agent-os/agents';
import type { Logger } from '@agent-os/common';
import {
  UpdateToolResultSettingsBodySchema,
  type ToolResultSettings,
  type UpdateToolResultSettingsBody,
} from '@agent-os/contracts';
import { AuditLog } from '../audit/audit-log.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { AdminOnly } from '../identity/admin-only.decorator.js';
import type { AuthedRequest } from '../identity/auth-user.js';
import { loggedRoute } from '../knowledge/knowledge.controller.js';
import { APP_LOGGER } from '../logging/app-logger.js';
import { AGENTS } from './agents.tokens.js';

const SETTINGS_OBJECT_TYPE = 'tool_result_settings';

/** «Было/стало» of the audit and the route's log: the three values. */
function settingsValues(settings: ToolResultSettings): Record<string, unknown> {
  return {
    storeFromChars: settings.storeFromChars,
    previewChars: settings.previewChars,
    readMaxTokens: settings.readMaxTokens,
  };
}

/**
 * The settings of large tool results for an administrator (tool-result-reading R-5, settings-row.md): the
 * threshold of a stored result, its preview and one reading page. The body is checked by the contract
 * schema (400 VALIDATION_FAILED, nothing changes); a write is audited after it as `admin_change` on
 * `tool_result_settings` with «было» and «стало». The next MCP call reads the new row: no restart.
 */
@Controller('admin/tool-results')
@AdminOnly()
export class AdminToolResultsController {
  private readonly logger: Logger;

  constructor(
    @Inject(AGENTS) private readonly agents: Agents,
    private readonly auditLog: AuditLog,
    @Inject(APP_LOGGER) logger: Logger,
  ) {
    this.logger = logger.child({ service: 'tool-results.routes' });
  }

  /** `ToolResultSettings`. */
  @Get('settings')
  settings(@Req() req: AuthedRequest): Promise<ToolResultSettings> {
    return loggedRoute(
      this.logger,
      'GET /admin/tool-results/settings',
      { actorId: req.user.id },
      () => this.agents.toolResults.settings(),
    );
  }

  /** `ToolResultSettings` after the change. */
  @Put('settings')
  update(
    @Body(new ZodValidationPipe(UpdateToolResultSettingsBodySchema))
    body: UpdateToolResultSettingsBody,
    @Req() req: AuthedRequest,
  ): Promise<ToolResultSettings> {
    const actor = req.user.id;
    return loggedRoute(
      this.logger,
      'PUT /admin/tool-results/settings',
      { actorId: actor },
      async () => {
        const { before, after } = await this.agents.toolResults.updateSettings({
          actorId: actor,
          storeFromChars: body.storeFromChars,
          previewChars: body.previewChars,
          readMaxTokens: body.readMaxTokens,
        });
        await this.auditLog.record(null, {
          kind: 'admin_change',
          actor,
          objectType: SETTINGS_OBJECT_TYPE,
          before: settingsValues(before),
          after: settingsValues(after),
          outcome: 'ok',
        });
        return after;
      },
      settingsValues,
    );
  }
}
