import { z } from 'zod';
import {
  AgentMemoryViewSchema,
  CopyResultSchema,
  LibraryChoicesSchema,
  MyRoleListSchema,
  RecordDetailSchema,
  RecordSummarySchema,
  TestRunStartedSchema,
  TestRunTakenSchema,
  TestRunViewSchema,
  TrainingActivatedSchema,
  TrainingStartedSchema,
  TrainingStateSchema,
  TrainingViewSchema,
  type ActivateTestRunBody,
  type AgentMemoryView,
  type CopyRecordBody,
  type CopyResult,
  type CreateRecordBody,
  type Language,
  type LibraryChoices,
  type MyRoleList,
  type RecordAudienceBody,
  type RecordDetail,
  type RecordSummary,
  type StartTestRunBody,
  type TestRunStarted,
  type TestRunTaken,
  type TestRunView,
  type TrainingActivated,
  type TrainingStarted,
  type TrainingState,
  type TrainingView,
  type UpdateRecordBody,
} from '@agent-os/contracts';
import { apiRequest } from '@/lib/api/api-request';

/**
 * The employee's library client (design-web.md, «Клиент API библиотеки»): one function per route of
 * design-library.md, each one `apiRequest` parsed by the contract schema. The employee is never sent:
 * the server takes them from the session (ADR-0012).
 */

const recordRoute = (id: string): string =>
  `/api/library/${encodeURIComponent(id)}`;

const testRunRoute = (id: string): string =>
  `/api/test-runs/${encodeURIComponent(id)}`;

const RecordSummaryListSchema = z.array(RecordSummarySchema);

export const libraryApi = {
  /** The records the viewer sees, by name. */
  list: (): Promise<RecordSummary[]> =>
    apiRequest({ path: '/api/library', schema: RecordSummaryListSchema }),
  get: (id: string): Promise<RecordDetail> =>
    apiRequest({ path: recordRoute(id), schema: RecordDetailSchema }),
  create: (body: CreateRecordBody): Promise<RecordDetail> =>
    apiRequest({
      path: '/api/library',
      method: 'POST',
      body,
      schema: RecordDetailSchema,
    }),
  /** `body.version` is the version the edit started from (Invariant 2). */
  save: (id: string, body: UpdateRecordBody): Promise<RecordDetail> =>
    apiRequest({
      path: recordRoute(id),
      method: 'PUT',
      body,
      schema: RecordDetailSchema,
    }),
  saveAudience: (id: string, body: RecordAudienceBody): Promise<RecordDetail> =>
    apiRequest({
      path: `${recordRoute(id)}/audience`,
      method: 'PUT',
      body,
      schema: RecordDetailSchema,
    }),
  /** `language` is the page's: the copy mark and an unrenamed built-in name are written in it (i18n Flow 4). */
  copy: (id: string, language: Language): Promise<CopyResult> =>
    apiRequest({
      path: `${recordRoute(id)}/copy`,
      method: 'POST',
      body: { language } satisfies CopyRecordBody,
      schema: CopyResultSchema,
    }),
  remove: (id: string): Promise<void> =>
    apiRequest({ path: recordRoute(id), method: 'DELETE' }),
  /** The deep agent's memory; the library and the panel read the same route (KD-5). */
  memory: (id: string): Promise<AgentMemoryView> =>
    apiRequest({
      path: `${recordRoute(id)}/memory`,
      schema: AgentMemoryViewSchema,
    }),
  /** 204 also when the agent has no such record. */
  deleteMemory: (id: string, memoryId: string): Promise<void> =>
    apiRequest({
      path: `${recordRoute(id)}/memory/${encodeURIComponent(memoryId)}`,
      method: 'DELETE',
    }),
  /** What the deep agent's card shows of training; the library and the panel read the same routes. */
  trainingState: (id: string): Promise<TrainingState> =>
    apiRequest({
      path: `${recordRoute(id)}/training`,
      schema: TrainingStateSchema,
    }),
  startTraining: (id: string): Promise<TrainingStarted> =>
    apiRequest({
      path: `${recordRoute(id)}/training`,
      method: 'POST',
      schema: TrainingStartedSchema,
    }),
  training: (id: string, trainingId: string): Promise<TrainingView> =>
    apiRequest({
      path: `${recordRoute(id)}/training/${encodeURIComponent(trainingId)}`,
      schema: TrainingViewSchema,
    }),
  activateTraining: (
    id: string,
    trainingId: string,
  ): Promise<TrainingActivated> =>
    apiRequest({
      path: `${recordRoute(id)}/training/${encodeURIComponent(trainingId)}/activate`,
      method: 'POST',
      schema: TrainingActivatedSchema,
    }),
  startTestRun: (body: StartTestRunBody): Promise<TestRunStarted> =>
    apiRequest({
      path: '/api/test-runs',
      method: 'POST',
      body,
      schema: TestRunStartedSchema,
    }),
  testRun: (testRunId: string): Promise<TestRunView> =>
    apiRequest({ path: testRunRoute(testRunId), schema: TestRunViewSchema }),
  takeTestRun: (testRunId: string): Promise<TestRunTaken> =>
    apiRequest({
      path: `${testRunRoute(testRunId)}/take`,
      method: 'POST',
      schema: TestRunTakenSchema,
    }),
  activateTestRun: (
    testRunId: string,
    version: number,
  ): Promise<TrainingActivated> =>
    apiRequest({
      path: `${testRunRoute(testRunId)}/activate`,
      method: 'POST',
      body: { version } satisfies ActivateTestRunBody,
      schema: TrainingActivatedSchema,
    }),
  /** The servers usable to the employee and the model of a new record. */
  choices: (): Promise<LibraryChoices> =>
    apiRequest({ path: '/api/library/choices', schema: LibraryChoicesSchema }),
  /** The viewer's roles by name. */
  myRoles: (): Promise<MyRoleList> =>
    apiRequest({ path: '/api/auth/me/roles', schema: MyRoleListSchema }),
};
