'use client';

import { PageHeader } from '@/components/shell/page-header';
import { useResource } from '@/hooks/use-resource';
import { adminApi } from '@/lib/admin/admin-api';
import { PANEL_TITLE } from '../admin-header';
import { adminSectionTitle } from '../admin-sections';
import { CatalogSection } from './catalog-section';
import { ModelDefaultsForm } from './model-defaults-form';
import { ModelProvidersTable } from './model-providers-table';

/**
 * model-providers design-web.md, KD-1: «Модели» — blocks one under another. The blocks depend on each other
 * (models per provider, «Нет провайдера», the defaults' warnings), so the screen holds the three reads and any
 * change of any block re-reads all three through `reloadAll`; no block reads on its own.
 */
export function ModelsScreen() {
  const defaults = useResource(adminApi.modelDefaults.get, 'models:defaults');
  const providers = useResource(adminApi.modelProviders.list, 'models:providers');
  const catalog = useResource(adminApi.models.list, 'models:catalog');

  const reloadAll = (): void => {
    defaults.reload();
    providers.reload();
    catalog.reload();
  };

  return (
    <>
      <PageHeader area={PANEL_TITLE} title={adminSectionTitle('models')} />
      <div className="flex flex-col gap-8">
        <ModelDefaultsForm defaults={defaults} providers={providers} catalog={catalog} reloadAll={reloadAll} />
        <ModelProvidersTable
          providers={providers}
          defaults={defaults.data}
          catalog={catalog.data}
          reloadAll={reloadAll}
        />
        <CatalogSection
          catalog={catalog}
          providers={providers.data}
          defaults={defaults.data}
          reloadAll={reloadAll}
        />
      </div>
    </>
  );
}
