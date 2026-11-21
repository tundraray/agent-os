'use client';

import { useFormatter, useTranslations } from 'next-intl';
import type { Grant } from '@agent-os/contracts';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { adminApi } from '@/lib/admin/admin-api';
import { quotaRules, quotaUsdOf } from '@/lib/admin/form-rules';
import { grantTargetText } from '@/lib/admin/grants';
import type { Formatter } from '@/lib/i18n/formats';
import { AdminForm, AdminTextField } from '../admin-form';

/** The quota as the field shows it: the dollars the admin set, the page's decimal mark, no grouping; none → empty. */
const quotaText = (format: Formatter, quotaUsd: number | null): string =>
  quotaUsd === null ? '' : format.number(quotaUsd, { useGrouping: false, maximumFractionDigits: 2 });

type QuotaDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A model allow; kept while the dialog closes. */
  grant: Grant | null;
  /** After the quota is saved: the owner reads the grants again and closes the dialog. */
  onSaved: () => void;
};

/** DC-14: «Изменить квоту» of a model allow — the same field as GR-01; empty removes the quota. */
export function QuotaDialog({ open, onOpenChange, grant, onSaved }: QuotaDialogProps) {
  const t = useTranslations('admin.grants');
  const format = useFormatter();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('changeQuota')}</DialogTitle>
          {grant !== null && <DialogDescription>{grantTargetText(grant.target)}</DialogDescription>}
        </DialogHeader>
        {grant !== null && (
          <AdminForm
            key={grant.id}
            variant="dialog"
            initialValues={{ quota: quotaText(format, grant.quotaUsd) }}
            validate={quotaRules}
            onSubmit={async ({ quota }) => {
              await adminApi.grants.updateQuota(grant.id, quotaUsdOf(quota));
            }}
            submitLabel={t('quota.submit')}
            onSaved={onSaved}
            logEvent="admin: grant quota"
          >
            {(form) => (
              <AdminTextField
                {...form.field('quota')}
                label={t('quota.label')}
                hint={t('quota.hint')}
                inputMode="decimal"
                value={form.values.quota}
                onChange={(quota) => form.set('quota', quota)}
              />
            )}
          </AdminForm>
        )}
      </DialogContent>
    </Dialog>
  );
}
