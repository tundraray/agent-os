'use client';

import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { LoaderCircle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { ScriptSchema, type Script } from '@agent-os/contracts';
import {
  AdminRadioField,
  AdminSelectField,
  AdminTextField,
  CAPTION,
  CONTROL_SIZE,
  FormError,
} from '@/components/admin/admin-form';
import { ConfirmDialog } from '@/components/admin/confirm-dialog';
import { ScriptToggle } from '@/components/agents/script-toggle';
import { Button } from '@/components/ui/button';
import { Field, FieldError, FieldLabel } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import { describeApiError } from '@/lib/api/api-request';
import {
  describeLibraryError,
  type LibraryErrorText,
} from '@/lib/library/library-errors';
import { logger } from '@/lib/logger';
import { cn } from 'cn';
import { ScriptHead } from './agent-script-change';

/** The fields a form error can name; class and owner are chosen, never typed. */
const TYPED_FIELDS = ['name', 'description', 'input', 'code'] as const;
type TypedField = (typeof TYPED_FIELDS)[number];

const BLANK: Script = {
  name: '',
  description: '',
  input: '',
  code: '',
  class: 'read',
  owner: null,
};

/** «На карточке»: the script with its code collapsed and, for whoever edits the agent, its actions. */
function ScriptView({
  script,
  actions,
}: {
  script: Script;
  actions: ReactNode;
}) {
  const t = useTranslations('library.scripts');
  return (
    <article aria-label={script.name} className="flex flex-col gap-1 py-3">
      <ScriptHead script={script} />
      <div className="flex flex-wrap items-start justify-between gap-2">
        <dl className="grid min-w-0 flex-1 grid-cols-[auto_minmax(0,1fr)] gap-x-3">
          <dt className={cn(CAPTION, 'text-muted-foreground pt-1')}>
            {t('fields.code')}
          </dt>
          <ScriptToggle script={script.code} density="ui" />
        </dl>
        {actions}
      </div>
    </article>
  );
}

type ScriptFormProps = {
  initial: Script;
  /** The deep agent's subagents, for «Кто вызывает». */
  subagents: readonly string[];
  /** Names of the other scripts: a name is not repeated (case aside, as the server compares). */
  otherNames: readonly string[];
  onSave: (script: Script) => Promise<void>;
  onCancel: () => void;
  onReread: () => Promise<void>;
};

/** «Правка» (agent-script.md): the fields are checked by `ScriptSchema` before the request; a refusal keeps them. */
function ScriptForm({
  initial,
  subagents,
  otherNames,
  onSave,
  onCancel,
  onReread,
}: ScriptFormProps) {
  const t = useTranslations('library.scripts');
  const tCommon = useTranslations('common');
  const tErrors = useTranslations('errors');
  const id = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const [values, setValues] = useState(initial);
  const [errors, setErrors] = useState<Partial<Record<TypedField, string>>>({});
  const [refusal, setRefusal] = useState<LibraryErrorText | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    formRef.current?.querySelector('input')?.focus();
  }, []);
  useEffect(() => {
    formRef.current
      ?.querySelector<HTMLElement>('[aria-invalid="true"]')
      ?.focus();
  }, [errors]);

  const set = <Key extends keyof Script>(key: Key, value: Script[Key]) =>
    setValues((current) => ({ ...current, [key]: value }));
  const fieldError = (key: TypedField) => errors[key];

  function check(): Partial<Record<TypedField, string>> {
    const found: Partial<Record<TypedField, string>> = {};
    for (const issue of ScriptSchema.safeParse(values).error?.issues ?? []) {
      const key = TYPED_FIELDS.find((field) => field === issue.path[0]);
      if (key !== undefined) found[key] ??= t(`errors.${key}`);
    }
    const name = values.name.toLowerCase();
    if (otherNames.some((other) => other.toLowerCase() === name))
      found.name ??= t('errors.nameTaken');
    return found;
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    setRefusal(null);
    const found = check();
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setSaving(true);
    try {
      await onSave(values);
    } catch (error) {
      // `recordAction` has logged the refusal.
      setRefusal(describeLibraryError(tErrors, error, { where: 'script' }));
      setSaving(false);
    }
  }

  async function reread() {
    setSaving(true);
    try {
      await onReread();
    } catch (error) {
      logger.warn('library: record reread failed', describeApiError(error));
      setRefusal(describeLibraryError(tErrors, error, { where: 'script' }));
      setSaving(false);
    }
  }

  return (
    <form
      ref={formRef}
      noValidate
      onSubmit={(event) => void submit(event)}
      className="flex flex-col gap-3 py-3"
    >
      <fieldset disabled={saving} className="contents">
        <AdminTextField
          id={`${id}-name`}
          label={t('fields.name')}
          hint={t('fields.nameHint')}
          mono
          value={values.name}
          error={fieldError('name')}
          onChange={(value) => set('name', value)}
        />
        <AdminTextField
          id={`${id}-description`}
          label={t('fields.description')}
          hint={t('fields.descriptionHint')}
          value={values.description}
          error={fieldError('description')}
          onChange={(value) => set('description', value)}
        />
        <AdminTextField
          id={`${id}-input`}
          label={t('fields.input')}
          value={values.input}
          error={fieldError('input')}
          onChange={(value) => set('input', value)}
        />
        <AdminSelectField
          id={`${id}-owner`}
          label={t('fields.owner')}
          value={values.owner ?? ''}
          emptyText={t('fields.ownerSelf')}
          options={[
            { value: '', label: t('fields.ownerSelf') },
            ...[...subagents]
              .sort((a, b) => a.localeCompare(b))
              .map((name) => ({
                value: name,
                label: t('fields.ownerSubagent', { name }),
              })),
          ]}
          onChange={(value) => set('owner', value === '' ? null : value)}
          error={undefined}
        />
        <AdminRadioField
          label={t('fields.class')}
          value={values.class}
          options={[
            { value: 'read', label: t('fields.classRead') },
            { value: 'write', label: t('fields.classWrite') },
          ]}
          onChange={(value) => set('class', value)}
        />
        <Field data-invalid={errors.code !== undefined} className="gap-1.5">
          <FieldLabel
            htmlFor={`${id}-code`}
            className="text-data text-foreground font-medium"
          >
            {t('fields.code')}
          </FieldLabel>
          <Textarea
            id={`${id}-code`}
            spellCheck={false}
            autoComplete="off"
            value={values.code}
            aria-invalid={errors.code !== undefined}
            aria-describedby={`${id}-code-error`}
            onChange={(event) => set('code', event.target.value)}
            className="min-h-[calc(12*22px+18px)] font-mono text-sm leading-[22px] md:text-sm"
          />
          <FieldError id={`${id}-code-error`} className={CAPTION}>
            {errors.code}
          </FieldError>
        </Field>
      </fieldset>
      {refusal !== null && (
        <FormError>
          {refusal.text}
          {refusal.place.at === 'conflict' && (
            <>
              {' '}
              <Button
                type="button"
                variant="link"
                size="sm"
                className="h-auto p-0"
                disabled={saving}
                onClick={() => void reread()}
              >
                {t('reread')}
              </Button>
            </>
          )}
        </FormError>
      )}
      <div className="flex gap-2">
        <Button
          type="submit"
          size="sm"
          className={CONTROL_SIZE}
          disabled={saving}
        >
          {saving && (
            <LoaderCircle
              className="animate-spin motion-reduce:animate-none"
              aria-hidden
            />
          )}
          {t('save')}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={CONTROL_SIZE}
          disabled={saving}
          onClick={onCancel}
        >
          {tCommon('cancel')}
        </Button>
      </div>
    </form>
  );
}

export type AgentScriptsProps = {
  scripts: readonly Script[];
  /** For whoever edits the agent; absent — the section is read-only (AC-24.2). */
  edit?: {
    subagents: readonly string[];
    /** Saves the whole list by the record's `PUT`. */
    onSave: (scripts: Script[]) => Promise<void>;
    /** Reads the record again after a version conflict (MC-15 «Перечитать»). */
    onReread: () => Promise<void>;
  };
};

/** One open form: the index of the edited script, or `new`. */
type Editing = number | 'new' | null;

/**
 * SC-01 «Скрипты · {n}» (self-learning UXRD): each script «На карточке»; whoever edits the agent changes,
 * adds and deletes them in place (SC-02), each change a new version of the record (KD-5).
 */
export function AgentScripts({ scripts, edit }: AgentScriptsProps) {
  const t = useTranslations('library.scripts');
  const tCommon = useTranslations('common');
  const tErrors = useTranslations('errors');
  const sectionRef = useRef<HTMLElement>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [deleting, setDeleting] = useState<number | null>(null);
  /** The last delete was refused for a version conflict: closing the dialog re-reads the record. */
  const deleteConflict = useRef(false);
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    if (saved === null) return;
    sectionRef.current
      ?.querySelector<HTMLElement>(`[data-script-edit="${saved}"]`)
      ?.focus();
    const timer = setTimeout(() => setSaved(null), 4000);
    return () => clearTimeout(timer);
  }, [saved]);

  if (edit === undefined && scripts.length === 0) return null;

  async function saveAt(at: Editing, script: Script): Promise<void> {
    await edit?.onSave(
      at === 'new'
        ? [...scripts, script]
        : scripts.map((current, index) => (index === at ? script : current)),
    );
    setEditing(null);
    setSaved(script.name);
  }

  const form = (at: Editing, initial: Script) => (
    <ScriptForm
      initial={initial}
      subagents={edit?.subagents ?? []}
      otherNames={scripts
        .filter((_, index) => index !== at)
        .map((script) => script.name)}
      onSave={(script) => saveAt(at, script)}
      onCancel={() => setEditing(null)}
      onReread={async () => {
        await edit?.onReread();
        setEditing(null);
      }}
    />
  );

  return (
    <section ref={sectionRef} className="flex flex-col gap-1">
      <h2 className="text-foreground text-base leading-6 font-semibold">
        {t('title', { count: scripts.length })}
      </h2>
      {scripts.length === 0 && (
        <p className="text-muted-foreground text-sm leading-5">{t('empty')}</p>
      )}
      <div className="divide-border flex flex-col divide-y">
        {scripts.map((script, index) =>
          editing === index ? (
            <div key={script.name}>{form(index, script)}</div>
          ) : (
            <div key={script.name}>
              <ScriptView
                script={script}
                actions={
                  edit !== undefined && (
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        className={CONTROL_SIZE}
                        data-script-edit={script.name}
                        aria-label={t('editNamed', { name: script.name })}
                        disabled={editing !== null}
                        onClick={() => setEditing(index)}
                      >
                        {t('edit')}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className={CONTROL_SIZE}
                        aria-label={t('deleteNamed', { name: script.name })}
                        disabled={editing !== null}
                        onClick={() => setDeleting(index)}
                      >
                        {t('delete')}
                      </Button>
                    </div>
                  )
                }
              />
              {saved === script.name && (
                <p
                  role="status"
                  className={cn(CAPTION, 'text-muted-foreground pb-2')}
                >
                  {tCommon('saved')}
                </p>
              )}
            </div>
          ),
        )}
        {editing === 'new' && form('new', BLANK)}
      </div>
      {edit !== undefined && editing === null && (
        <Button
          variant="outline"
          size="sm"
          className={cn(CONTROL_SIZE, 'w-fit')}
          onClick={() => setEditing('new')}
        >
          {t('add')}
        </Button>
      )}
      {edit !== undefined && (
        <ConfirmDialog
          open={deleting !== null}
          onOpenChange={(open) => {
            if (open) return;
            setDeleting(null);
            if (!deleteConflict.current) return;
            deleteConflict.current = false;
            edit.onReread().catch((error: unknown) => {
              logger.warn(
                'library: record reread failed',
                describeApiError(error),
              );
            });
          }}
          title={t('deleteTitle', {
            name: deleting === null ? '' : (scripts[deleting]?.name ?? ''),
          })}
          body={t('deleteBody')}
          confirmLabel={t('delete')}
          onConfirm={() =>
            edit.onSave(scripts.filter((_, index) => index !== deleting))
          }
          refusalText={(cause) => {
            const refusal = describeLibraryError(tErrors, cause, {
              where: 'script',
            });
            deleteConflict.current = refusal.place.at === 'conflict';
            return refusal.text;
          }}
        />
      )}
    </section>
  );
}
