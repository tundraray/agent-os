import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  Inject,
  Param,
  Req,
} from '@nestjs/common';
import type { Agents } from '@agent-os/agents';
import type { Logger, LogFields } from '@agent-os/common';
import type { KnowledgeView } from '@agent-os/contracts';
import { AGENTS } from '../agents/agents.tokens';
import { AuditLog } from '../audit/audit-log';
import type { AuthedRequest } from '../identity/auth-user';
import { LibraryService } from '../library/library.service';
import { APP_LOGGER } from '../logging/app-logger';

const LIBRARY_RECORD_OBJECT_TYPE = 'library_record';
const KNOWLEDGE_DELETE_KIND = 'knowledge_delete';
/** Graph ids are Postgres `integer` identities: nothing above this exists. */
const MAX_ITEM_ID = 2_147_483_647;

/**
 * The id of a graph entry from the path, or `null` when it is not a positive integer a graph row can
 * have — such an entry does not exist, so the route answers as for one already deleted (DC-10).
 */
function itemIdOf(raw: string): number | null {
  if (!/^[1-9]\d{0,9}$/.test(raw)) return null;
  const id = Number(raw);
  return id <= MAX_ITEM_ID ? id : null;
}

/**
 * Runs one route and logs it once (design-core.md, Logging «Маршруты»): the route, the
 * caller's fields, the outcome (`ok`, or the status and `errorCode` of a refusal), `durationMs`. The
 * fields carry ids and counts only, never the text of a graph entry.
 */
export async function loggedRoute<T>(
  logger: Logger,
  route: string,
  fields: LogFields,
  work: () => Promise<T>,
  outcomeOf: (result: T) => LogFields = () => ({}),
): Promise<T> {
  const startedAt = Date.now();
  try {
    const result = await work();
    logger.info('route answered', {
      route,
      ...fields,
      outcome: 'ok',
      ...outcomeOf(result),
      durationMs: Date.now() - startedAt,
    });
    return result;
  } catch (error) {
    if (error instanceof HttpException && error.getStatus() < 500) {
      const body = error.getResponse();
      logger.info('route refused', {
        route,
        ...fields,
        outcome: 'refused',
        status: error.getStatus(),
        errorCode:
          typeof body === 'object' && 'errorCode' in body
            ? body.errorCode
            : undefined,
        durationMs: Date.now() - startedAt,
      });
    } else {
      logger.error('route failed', {
        route,
        ...fields,
        outcome: 'error',
        durationMs: Date.now() - startedAt,
        error,
      });
    }
    throw error;
  }
}

/**
 * The knowledge graph of a workflow (self-learning design-core.md, KD-7, Contract «Для части `web`»): one
 * route family for the library and the admin panel. Every route first asks
 * `LibraryService.knowledgeTarget` — the only place of the access rule (404 RECORD_NOT_FOUND, 403
 * KNOWLEDGE_FORBIDDEN) — and acts only on the record id it returns; `Agents.knowledge` touches only that
 * workflow's rows. A delete is audited as `knowledge_delete` with the entry's kind and id, never its
 * text; an entry that is not there answers 204 with no audit (DC-10).
 */
@Controller('library/:id/knowledge')
export class KnowledgeController {
  private readonly logger: Logger;

  constructor(
    private readonly library: LibraryService,
    @Inject(AGENTS) private readonly agents: Agents,
    private readonly auditLog: AuditLog,
    @Inject(APP_LOGGER) logger: Logger,
  ) {
    this.logger = logger.child({ service: 'knowledge.routes' });
  }

  /** `KnowledgeView`; 404 RECORD_NOT_FOUND, 403 KNOWLEDGE_FORBIDDEN. */
  @Get()
  view(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<KnowledgeView> {
    return loggedRoute(
      this.logger,
      'GET /library/:id/knowledge',
      { actorId: req.user.id, recordId: id },
      async () =>
        this.agents.knowledge.view(
          await this.library.knowledgeTarget(req.user, id),
        ),
      (view) => ({ items: view.items.length }),
    );
  }

  /** 204, also when the entity is not there; its fact relations go with it. 404, 403. */
  @Delete('entities/:entityId')
  @HttpCode(204)
  deleteEntity(
    @Param('id') id: string,
    @Param('entityId') rawEntityId: string,
    @Req() req: AuthedRequest,
  ): Promise<void> {
    const actor = req.user.id;
    return loggedRoute(
      this.logger,
      'DELETE /library/:id/knowledge/entities/:entityId',
      { actorId: actor, recordId: id, itemType: 'entity', itemId: rawEntityId },
      async () => {
        const { recordId } = await this.library.knowledgeTarget(req.user, id);
        const entityId = itemIdOf(rawEntityId);
        if (entityId === null) return { deleted: false, relations: 0 };
        const deletion = await this.agents.knowledge.deleteEntity({
          recordId,
          entityId,
        });
        if (deletion.deleted)
          await this.recordDelete(actor, recordId, {
            type: 'entity',
            id: entityId,
            relations: deletion.relations,
          });
        return deletion;
      },
      (deletion) => ({
        deleted: deletion.deleted,
        relations: deletion.relations,
      }),
    ).then(() => undefined);
  }

  /** 204, also when the relation, lesson or «searched — found nothing» is not there. 404, 403. */
  @Delete('relations/:relationId')
  @HttpCode(204)
  deleteRelation(
    @Param('id') id: string,
    @Param('relationId') rawRelationId: string,
    @Req() req: AuthedRequest,
  ): Promise<void> {
    const actor = req.user.id;
    return loggedRoute(
      this.logger,
      'DELETE /library/:id/knowledge/relations/:relationId',
      {
        actorId: actor,
        recordId: id,
        itemType: 'relation',
        itemId: rawRelationId,
      },
      async () => {
        const { recordId } = await this.library.knowledgeTarget(req.user, id);
        const relationId = itemIdOf(rawRelationId);
        if (relationId === null) return { deleted: false };
        const deletion = await this.agents.knowledge.deleteRelation({
          recordId,
          relationId,
        });
        if (deletion.deleted)
          await this.recordDelete(actor, recordId, {
            type: 'relation',
            id: relationId,
          });
        return deletion;
      },
      (deletion) => ({ deleted: deletion.deleted }),
    ).then(() => undefined);
  }

  /** The audit of a delete: the workflow, the entry's kind and id — not its text (KD-7, UC-5 PRD). */
  private recordDelete(
    actor: string,
    recordId: string,
    after: { type: 'entity' | 'relation'; id: number; relations?: number },
  ): Promise<void> {
    return this.auditLog.record(null, {
      kind: KNOWLEDGE_DELETE_KIND,
      actor,
      objectType: LIBRARY_RECORD_OBJECT_TYPE,
      objectId: recordId,
      after: { ...after },
      outcome: 'ok',
    });
  }
}
