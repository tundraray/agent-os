'use client';

import type { Grant } from '@agent-os/contracts';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { adminApi } from '@/lib/admin/admin-api';
import { quotaRules, quotaUsdOf } from '@/lib/admin/form-rules';
import { grantTargetText } from '@/lib/admin/grants';
import { AdminForm, AdminTextField } from '../admin-form';

/** UXRD MC-24, MC-25 and MC-20 («Сохранить»). */
const TEXT = {
  title: 'Изменить квоту',
  quota: 'Квота за месяц, $',
  quotaHint: 'Пусто — без квоты',
  submit: 'Сохранить',
} as const;

/** The quota as the field shows it: the dollars the admin set, a comma for the fraction; none → empty. */
const quotaText = (quotaUsd: number | null): string => (quotaUsd === null ? '' : String(quotaUsd).replace('.', ','));

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
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{TEXT.title}</DialogTitle>
          {grant !== null && <DialogDescription>{grantTargetText(grant.target)}</DialogDescription>}
        </DialogHeader>
        {grant !== null && (
          <AdminForm
            key={grant.id}
            variant="dialog"
            initialValues={{ quota: quotaText(grant.quotaUsd) }}
            validate={quotaRules}
            onSubmit={async ({ quota }) => {
              await adminApi.grants.updateQuota(grant.id, quotaUsdOf(quota));
            }}
            submitLabel={TEXT.submit}
            onSaved={onSaved}
            logEvent="admin: grant quota"
          >
            {(form) => (
              <AdminTextField
                {...form.field('quota')}
                label={TEXT.quota}
                hint={TEXT.quotaHint}
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
