'use client';

import { useTranslations } from 'next-intl';
import type { RecordDetail } from '@agent-os/contracts';
import { RecordPlaceholder } from '@/components/admin/admin-header';
import { BLANK_SKILL, blankAgent } from '@/components/library/agent-fields';
import { DeepAgentCard } from '@/components/library/deep-agent-card';
import {
  RecordEditor,
  type RecordEditorSource,
} from '@/components/library/record-editor';
import { useResource } from '@/hooks/use-resource';
import { adminApi } from '@/lib/admin/admin-api';
import { modelUnavailableReason } from '@/lib/admin/model-providers';
import { libraryApi } from '@/lib/library/library-api';
import type { EditorRecord } from '@/lib/library/record-rules';
import type { FormKind } from '@/lib/shell-route';

/**
 * `/admin/library/<id>` of a company record (no author): AL-02, the record editor in mode `system` for an agent or
 * a skill (agent-guidance SK-05); a company deep agent opens in its card (deep-agents UXRD DA-13).
 */
export function SystemRecordPage({
  record,
  created,
}: {
  record: RecordDetail;
  created: boolean;
}) {
  if (record.kind === 'deep_agent')
    return <DeepAgentCard mode="system" record={record} />;
  return <SystemEditor start={{ saved: record }} created={created} />;
}

/**
 * `/admin/library/new/agent` and `/new/skill`: the empty form of a company agent or skill (AL-02, SK-05); a deep
 * agent has no form (UXRD KD-1).
 */
export function NewSystemRecordPage({ kind }: { kind: FormKind }) {
  return <SystemEditor start={{ blank: kind }} created={false} />;
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
  created,
}: {
  start: { saved: EditorRecord } | { blank: FormKind };
  created: boolean;
}) {
  const t = useTranslations('admin.library');
  const choices = useResource(libraryApi.choices, 'choices', 'library');
  const servers = useResource(adminApi.servers.list, 'servers', 'library');
  const models = useResource(adminApi.models.list, 'models', 'library');
  const providers = useResource(
    adminApi.modelProviders.list,
    'model-providers',
    'library',
  );
  const providerList = providers.data;

  if (choices.data === undefined || servers.data === undefined) {
    const waiting = choices.data === undefined ? choices : servers;
    return (
      <RecordPlaceholder
        section="library"
        resource={waiting}
        loadFailed={t('loadFailed')}
      />
    );
  }
  const source: RecordEditorSource =
    'saved' in start
      ? start
      : {
          blank:
            start.blank === 'skill' ? BLANK_SKILL : blankAgent(choices.data),
        };
  return (
    <RecordEditor
      mode="system"
      source={source}
      created={created}
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
                  unavailableReason: modelUnavailableReason(
                    model.id,
                    providerList,
                  ),
                })),
      }}
    />
  );
}
