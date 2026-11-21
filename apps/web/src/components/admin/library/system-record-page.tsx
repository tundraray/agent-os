'use client';

import { useTranslations } from 'next-intl';
import type { RecordDetail, RecordKind } from '@agent-os/contracts';
import { RecordPlaceholder } from '@/components/admin/admin-header';
import { blankAgent } from '@/components/library/agent-fields';
import { RecordEditor, type RecordEditorProps, type RecordEditorSource } from '@/components/library/record-editor';
import { blankWorkflow } from '@/components/library/workflow-fields';
import { useResource } from '@/hooks/use-resource';
import { adminApi } from '@/lib/admin/admin-api';
import { modelUnavailableReason } from '@/lib/admin/model-providers';
import { libraryApi } from '@/lib/library/library-api';

/** `/admin/library/<id>` of a company record (no author): AL-02, the editor in mode `system`. */
export function SystemRecordPage({ record, handoff }: { record: RecordDetail; handoff: RecordEditorProps['handoff'] }) {
  return <SystemEditor start={{ saved: record }} handoff={handoff} />;
}

/** `/admin/library/new/{kind}`: the empty form of a company agent or workflow (AL-02). */
export function NewSystemRecordPage({ kind }: { kind: RecordKind }) {
  return <SystemEditor start={{ newKind: kind }} handoff={null} />;
}

/**
 * The editor's data in the panel, read on open (design-web.md, «Данные экранов»): the whole registry
 * (`adminApi.servers.list`), the model catalogue (`adminApi.models.list`) and the model providers
 * (`adminApi.modelProviders.list`); the platform's default model and «Максимум шагов» of a new record — from
 * `choices`. The editor waits for the registry and the default model; the catalogue and the providers fill the
 * model field once both are read.
 */
function SystemEditor({
  start,
  handoff,
}: {
  start: { saved: RecordDetail } | { newKind: RecordKind };
  handoff: RecordEditorProps['handoff'];
}) {
  const t = useTranslations('admin.library');
  const choices = useResource(libraryApi.choices, 'choices', 'library');
  const servers = useResource(adminApi.servers.list, 'servers', 'library');
  const models = useResource(adminApi.models.list, 'models', 'library');
  const providers = useResource(adminApi.modelProviders.list, 'model-providers', 'library');
  const providerList = providers.data;

  if (choices.data === undefined || servers.data === undefined) {
    const waiting = choices.data === undefined ? choices : servers;
    return <RecordPlaceholder section="library" resource={waiting} loadFailed={t('loadFailed')} />;
  }
  const source: RecordEditorSource =
    'saved' in start
      ? start
      : { blank: start.newKind === 'agent' ? blankAgent(choices.data) : blankWorkflow(choices.data) };
  return (
    <RecordEditor
      mode="system"
      source={source}
      handoff={handoff}
      choices={{
        ...choices.data,
        servers: servers.data.map((server) => server.name),
        // Readiness by the providers' list (KD-5); the field waits for both reads, so no model shows as broken meanwhile.
        models:
          providerList === undefined
            ? undefined
            : models.data
                ?.filter((model) => model.purpose === 'chat')
                .map((model) => ({
                  model: model.id,
                  name: model.name,
                  unavailableReason: modelUnavailableReason(model.id, providerList),
                })),
      }}
    />
  );
}
