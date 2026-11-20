import { z } from 'zod';
import {
  CopyResultSchema,
  KnowledgeViewSchema,
  LibraryChoicesSchema,
  MyRoleListSchema,
  RecordDetailSchema,
  RecordSummarySchema,
  type CopyResult,
  type CreateRecordBody,
  type KnowledgeView,
  type LibraryChoices,
  type MyRoleList,
  type RecordAudienceBody,
  type RecordDetail,
  type RecordSummary,
  type UpdateRecordBody,
} from '@agent-os/contracts';
import { apiRequest } from '@/lib/api/api-request';

/**
 * The employee's library client (design-web.md, «Клиент API библиотеки»): one function per route of
 * design-library.md, each one `apiRequest` parsed by the contract schema. The employee is never sent:
 * the server takes them from the session (ADR-0012).
 */

const recordRoute = (id: string): string => `/api/library/${encodeURIComponent(id)}`;

const knowledgeRoute = (id: string): string => `${recordRoute(id)}/knowledge`;

const RecordSummaryListSchema = z.array(RecordSummarySchema);

export const libraryApi = {
  /** The records the viewer sees, by name. */
  list: (): Promise<RecordSummary[]> => apiRequest({ path: '/api/library', schema: RecordSummaryListSchema }),
  get: (id: string): Promise<RecordDetail> => apiRequest({ path: recordRoute(id), schema: RecordDetailSchema }),
  create: (body: CreateRecordBody): Promise<RecordDetail> =>
    apiRequest({ path: '/api/library', method: 'POST', body, schema: RecordDetailSchema }),
  /** `body.version` is the version the edit started from (Invariant 2). */
  save: (id: string, body: UpdateRecordBody): Promise<RecordDetail> =>
    apiRequest({ path: recordRoute(id), method: 'PUT', body, schema: RecordDetailSchema }),
  saveAudience: (id: string, body: RecordAudienceBody): Promise<RecordDetail> =>
    apiRequest({ path: `${recordRoute(id)}/audience`, method: 'PUT', body, schema: RecordDetailSchema }),
  copy: (id: string): Promise<CopyResult> =>
    apiRequest({ path: `${recordRoute(id)}/copy`, method: 'POST', schema: CopyResultSchema }),
  remove: (id: string): Promise<void> => apiRequest({ path: recordRoute(id), method: 'DELETE' }),
  /** The workflow's knowledge graph; the library and the panel read the same route (KD-1). */
  knowledge: (id: string): Promise<KnowledgeView> =>
    apiRequest({ path: knowledgeRoute(id), schema: KnowledgeViewSchema }),
  /** A record's id is unique only within its `type`, so each type has its own route (KD-5). */
  deleteKnowledgeEntity: (id: string, entityId: number): Promise<void> =>
    apiRequest({ path: `${knowledgeRoute(id)}/entities/${String(entityId)}`, method: 'DELETE' }),
  deleteKnowledgeRelation: (id: string, relationId: number): Promise<void> =>
    apiRequest({ path: `${knowledgeRoute(id)}/relations/${String(relationId)}`, method: 'DELETE' }),
  /** The servers usable to the employee and the model of a new record. */
  choices: (): Promise<LibraryChoices> => apiRequest({ path: '/api/library/choices', schema: LibraryChoicesSchema }),
  /** The viewer's roles by name. */
  myRoles: (): Promise<MyRoleList> => apiRequest({ path: '/api/auth/me/roles', schema: MyRoleListSchema }),
};
