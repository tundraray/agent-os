import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Req,
} from '@nestjs/common';
import { AgentsKnowledge } from '@agent-os/agents';
import { LOGGER, type Logger } from '@agent-os/common';
import type { KnowledgeView } from '@agent-os/contracts';
import { AuditLog } from '../audit/audit-log';
import { loggedRoute } from '../common/logged-route';
import type { AuthedRequest } from '../identity/auth-user';
import { LibraryService } from '../library/library.service';
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
 * The knowledge graph of a record (self-learning design-core.md, KD-7, Contract «Для части `web`»): one
 * route family for the library and the admin panel. Every route first asks
 * `LibraryService.knowledgeTarget` — the only place of the access rule (404 RECORD_NOT_FOUND, 403
 * KNOWLEDGE_FORBIDDEN) — and acts only on the record id it returns; `AgentsKnowledge` touches only that
 * record's rows. A delete is audited as `knowledge_delete` with the entry's kind and id, never its
 * text; an entry that is not there answers 204 with no audit (DC-10).
 */
@Controller('library/:id/knowledge')
export class KnowledgeController {
  private readonly logger: Logger;

  constructor(
    private readonly library: LibraryService,
    @Inject(AgentsKnowledge) private readonly knowledge: AgentsKnowledge,
    private readonly auditLog: AuditLog,
    @Inject(LOGGER) logger: Logger,
  ) {
    this.logger = logger.child({ service: 'knowledge.routes' });
  }

  /** `KnowledgeView`; 404 RECORD_NOT_FOUND, 403 KNOWLEDGE_FORBIDDEN. */
  @Get()
  view(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<KnowledgeView> {
    return loggedRoute(this.logger, {
      route: 'GET /library/:id/knowledge',
      fields: { actorId: req.user.id, recordId: id },
      work: async () =>
        this.knowledge.view(
          await this.library.knowledgeTarget(req.user, id),
        ),
      outcomeOf: (view) => ({ items: view.items.length }),
    });
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
    return loggedRoute(this.logger, {
      route: 'DELETE /library/:id/knowledge/entities/:entityId',
      fields: {
        actorId: actor,
        recordId: id,
        itemType: 'entity',
        itemId: rawEntityId,
      },
      work: async () => {
        const { recordId } = await this.library.knowledgeTarget(req.user, id);
        const entityId = itemIdOf(rawEntityId);
        if (entityId === null) return { deleted: false, relations: 0 };
        const deletion = await this.knowledge.deleteEntity({
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
      outcomeOf: (deletion) => ({
        deleted: deletion.deleted,
        relations: deletion.relations,
      }),
    }).then(() => undefined);
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
    return loggedRoute(this.logger, {
      route: 'DELETE /library/:id/knowledge/relations/:relationId',
      fields: {
        actorId: actor,
        recordId: id,
        itemType: 'relation',
        itemId: rawRelationId,
      },
      work: async () => {
        const { recordId } = await this.library.knowledgeTarget(req.user, id);
        const relationId = itemIdOf(rawRelationId);
        if (relationId === null) return { deleted: false };
        const deletion = await this.knowledge.deleteRelation({
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
      outcomeOf: (deletion) => ({ deleted: deletion.deleted }),
    }).then(() => undefined);
  }

  /** The audit of a delete: the record, the entry's kind and id — not its text (KD-7, UC-5 PRD). */
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
