"use client";

import { useId, useMemo, useState, type FormEvent } from "react";
import { Combobox } from "@base-ui/react/combobox";
import { CheckIcon, Info, LoaderCircle, Lock, User, Users, X } from "lucide-react";
import { toast } from "sonner";
import type { MyRoleList, RecordAudience, RecordDetail, RecordKind, RecordSummary, RoleList } from "@agent-os/contracts";
import { AdminRadioField, CAPTION, FORM_TEXT, FormError, type AdminRadioOption } from "@/components/admin/admin-form";
import { useShellServices } from "@/components/shell/shell-actions";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { EMPLOYEE_SEARCH_DELAY_MS, useDebouncedValue } from "@/hooks/use-debounced-value";
import { useResource } from "@/hooks/use-resource";
import { adminApi } from "@/lib/admin/admin-api";
import { describeApiError, isApiRequestError } from "@/lib/api/api-request";
import { libraryApi } from "@/lib/library/library-api";
import { describeLibraryError, kindWord } from "@/lib/library/library-errors";
import { recordAction } from "@/lib/library/record-action";
import { logger } from "@/lib/logger";
import { cn } from "cn";

/** UXRD MC-14; «Сохранить» and «Отмена» — MC-20. */
const TEXT = {
  title: (name: string) => `Поделиться «${name}»`,
  who: "Кто видит",
  ownerAlways: "Вы видите всегда",
  leftRole: "вы больше не в этой роли",
  employeeDelivery: (name: string) => `Как коллеги получают «${name}»`,
  adminDelivery: (name: string) => `Как сотрудники получают «${name}»`,
  offer: (kind: RecordKind) => `Их чат предлагает и запускает ${kind === "agent" ? "агента" : "workflow"}`,
  libraryOnly: "Только в библиотеке — прочитать и скопировать",
  consequence: (kind: RecordKind) => `Коллеги увидят, что ${kindWord(kind)} от вас, и он будет работать с их правами.`,
  everyone: "Все сотрудники",
  selected: "Выбранные роли и сотрудники",
  search: "Найти роль или сотрудника",
  onlyAdmins: "Пока видят только администраторы",
  remove: (name: string, kind: HolderKind) => `Убрать: ${name}, ${kind === "role" ? "роль" : "сотрудник"}`,
  save: "Сохранить",
  nowSee: (names: readonly string[]) => `Теперь видят: ${names.join(", ")}`,
  onlyYou: "Теперь видите только вы",
  nowEveryone: "Теперь видят все сотрудники",
  rolesFailed: "Не удалось загрузить роли",
  retry: "Повторить",
  // Not in MC-14: the search list has no texts of its own there.
  noMatches: "Никого не нашли",
  usersFailed: "Не удалось найти сотрудников",
} as const;

/** What the dialog reads of a record: a library row and a record page both fit. */
export type ShareRecord = Pick<RecordSummary, "id" | "kind" | "name" | "audience" | "offerInChat">;

export type ShareDialogProps = {
  /** «Сотрудник» shares their own record with their roles; «Администратор» shares a company record. */
  variant: "employee" | "admin";
  record: ShareRecord;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The record as the server saved it; the dialog has closed by then. */
  onSaved: (record: RecordDetail) => void;
};

/**
 * SH-01 (share-dialog.md): who sees a record and how they get it. The body mounts with the open dialog, so
 * the roles are read on every open (read-on-open). A save goes through `recordAction`, names the new audience
 * in a toast (MC-14), re-reads `libraryIndex` and hands the saved record to `onSaved`; a refusal stays in the
 * form with the choice as it was.
 */
export function ShareDialog({ variant, record, open, onOpenChange, onSaved }: ShareDialogProps) {
  const done = (saved: RecordDetail): void => {
    onOpenChange(false);
    onSaved(saved);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="full-narrow">
        <DialogHeader>
          <DialogTitle>{TEXT.title(record.name)}</DialogTitle>
        </DialogHeader>
        {variant === "employee" ? (
          <EmployeeAudience record={record} onDone={done} />
        ) : (
          <AdminAudience record={record} onDone={done} />
        )}
      </DialogContent>
    </Dialog>
  );
}

type AudienceProps = { record: ShareRecord; onDone: (saved: RecordDetail) => void };

/** The text of a refused save. */
const refusalText = (cause: unknown, kind: RecordKind, role?: string): string =>
  describeLibraryError(cause, { where: "share", kind, role }).text;

/** The save of both variants: one `recordAction` `audience`, then the toast, `libraryIndex` and `onDone`. */
function useAudienceSave({ record, onDone }: AudienceProps) {
  const { libraryIndex } = useShellServices();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(input: {
    send: () => Promise<RecordDetail>;
    savedText: (saved: RecordDetail) => string;
    refusal: (cause: unknown) => Promise<string>;
  }): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      // The audience body carries no version.
      const saved = await recordAction(
        { recordId: record.id, kind: record.kind, action: "audience", version: null },
        input.send,
      );
      toast.success(input.savedText(saved));
      void libraryIndex.refresh();
      onDone(saved);
    } catch (cause) {
      // `recordAction` has logged the refusal; the choice stays as it was.
      setError(await input.refusal(cause));
      setSaving(false);
    }
  }

  return { saving, error, save };
}

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean =>
  a.size === b.size && [...a].every((item) => b.has(item));

const byName = (a: { name: string }, b: { name: string }): number => a.name.localeCompare(b.name, "ru");

// ---------- Сотрудник ----------

type RoleOption = { id: string; name: string; left: boolean };

/** The viewer's roles and the record's roles the owner has left (ticked, marked), by name. */
function roleOptions(mine: MyRoleList, audience: RecordAudience): RoleOption[] {
  const mineIds = new Set(mine.map((role) => role.id));
  const left = audience.roles.filter((role) => !mineIds.has(role.id));
  return [
    ...mine.map((role) => ({ id: role.id, name: role.name, left: false })),
    ...left.map((role) => ({ id: role.id, name: role.name, left: true })),
  ].sort(byName);
}

function EmployeeAudience({ record, onDone }: AudienceProps) {
  const id = useId();
  const roles = useResource(libraryApi.myRoles, record.id, "library");
  const savedIds = useMemo(() => new Set(record.audience.roles.map((role) => role.id)), [record]);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(savedIds);
  // A record shared with nobody yet offers the first way (AC-15.4).
  const [offer, setOffer] = useState(savedIds.size === 0 ? true : record.offerInChat);
  const { saving, error, save } = useAudienceSave({ record, onDone });

  const options = roles.data === undefined ? [] : roleOptions(roles.data, record.audience);
  const changed = !sameSet(chosen, savedIds) || (chosen.size > 0 && offer !== record.offerInChat);

  const toggle = (roleId: string, checked: boolean): void =>
    setChosen((current) => {
      const next = new Set(current);
      if (checked) next.add(roleId);
      else next.delete(roleId);
      return next;
    });

  /** 422 `role_not_member` names no role: the added role the owner is no longer in, by a fresh read. */
  async function leftRoleName(): Promise<string | undefined> {
    const added = options.filter((option) => chosen.has(option.id) && !savedIds.has(option.id));
    try {
      const now = new Set((await libraryApi.myRoles()).map((role) => role.id));
      return added.find((option) => !now.has(option.id))?.name;
    } catch (cause) {
      logger.warn("library: roles read after refusal failed", { recordId: record.id, ...describeApiError(cause) });
      return undefined;
    }
  }

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (saving || !changed) return;
    void save({
      send: () => libraryApi.saveAudience(record.id, { roleIds: [...chosen], offerInChat: offer }),
      savedText: (saved) => {
        const names = saved.audience.roles.map((role) => role.name);
        return names.length === 0 ? TEXT.onlyYou : TEXT.nowSee(names);
      },
      refusal: async (cause) => {
        const role =
          isApiRequestError(cause) && cause.reason === "role_not_member" ? await leftRoleName() : undefined;
        return refusalText(cause, record.kind, role);
      },
    });
  };

  return (
    <form noValidate onSubmit={submit} className="flex flex-col gap-4">
      {/* A disabled fieldset disables every native field and button inside while the request runs. */}
      <fieldset disabled={saving} className="contents">
        <FieldSet className="gap-2">
          <FieldLegend variant="label" className="mb-0 text-data font-medium text-foreground">
            {TEXT.who}
          </FieldLegend>
          <p className="flex items-center gap-2 text-data text-muted-foreground">
            <Lock className="size-4 shrink-0" aria-hidden />
            {TEXT.ownerAlways}
          </p>
          {roles.status === "loading" && <RowSkeletons />}
          {roles.status === "error" && <LoadFailed onRetry={roles.reload} />}
          {options.map((option) => {
            const checked = chosen.has(option.id);
            const noteId = `${id}-${option.id}-left`;
            return (
              <div key={option.id} className="flex flex-wrap items-center gap-x-2">
                <Label className="flex w-fit items-center gap-2 text-data font-normal text-foreground pointer-coarse:min-h-11">
                  <Checkbox
                    checked={checked}
                    // A left role, once unticked, cannot come back: the server would refuse it.
                    disabled={saving || (option.left && !checked)}
                    aria-describedby={option.left ? noteId : undefined}
                    onCheckedChange={(next) => toggle(option.id, next)}
                  />
                  {option.name}
                </Label>
                {option.left && (
                  <span id={noteId} className={cn(CAPTION, "text-muted-foreground")}>
                    {TEXT.leftRole}
                  </span>
                )}
              </div>
            );
          })}
        </FieldSet>
        {chosen.size > 0 && (
          <Delivery
            label={TEXT.employeeDelivery(record.name)}
            kind={record.kind}
            offer={offer}
            onChange={setOffer}
            consequence={TEXT.consequence(record.kind)}
          />
        )}
      </fieldset>
      {error !== null && <FormError>{error}</FormError>}
      <ShareActions saving={saving} disabled={!changed || roles.status !== "ready"} />
    </form>
  );
}

// ---------- Администратор ----------

type HolderKind = "role" | "user";

/** A role or an employee the company record is open to; `email` only for an employee from the search. */
type Holder = { kind: HolderKind; id: string; name: string; email?: string };

const holderKey = (holder: Holder): string => `${holder.kind}:${holder.id}`;

const holdersOf = (audience: RecordAudience): Holder[] => [
  ...audience.roles.map((role): Holder => ({ kind: "role", id: role.id, name: role.name })),
  ...(audience.users ?? []).map((user): Holder => ({ kind: "user", id: user.id, name: user.name })),
];

type Reach = "everyone" | "selected";

const REACH: readonly AdminRadioOption<Reach>[] = [
  { value: "everyone", label: TEXT.everyone },
  { value: "selected", label: TEXT.selected },
];

function AdminAudience({ record, onDone }: AudienceProps) {
  const roles = useResource(adminApi.roles.list, record.id, "library");
  const savedEveryone = record.audience.everyone === true;
  const savedHolders = useMemo(() => holdersOf(record.audience), [record]);
  const [reach, setReach] = useState<Reach>(savedEveryone ? "everyone" : "selected");
  const [chosen, setChosen] = useState<Holder[]>(savedHolders);
  const [offer, setOffer] = useState(savedEveryone || savedHolders.length > 0 ? record.offerInChat : true);
  const { saving, error, save } = useAudienceSave({ record, onDone });

  const everyone = reach === "everyone";
  const reachesSomeone = everyone || chosen.length > 0;
  const changed =
    everyone !== savedEveryone ||
    (!everyone && !sameSet(new Set(chosen.map(holderKey)), new Set(savedHolders.map(holderKey)))) ||
    (reachesSomeone && offer !== record.offerInChat);

  const idsOf = (kind: HolderKind): string[] =>
    everyone ? [] : chosen.filter((holder) => holder.kind === kind).map((holder) => holder.id);

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (saving || !changed) return;
    void save({
      send: () =>
        adminApi.library.saveAudience(record.id, {
          everyone,
          roleIds: idsOf("role"),
          userIds: idsOf("user"),
          offerInChat: offer,
        }),
      savedText: (saved) => {
        if (saved.audience.everyone === true) return TEXT.nowEveryone;
        const names = holdersOf(saved.audience).map((holder) => holder.name);
        return names.length === 0 ? TEXT.onlyAdmins : TEXT.nowSee(names);
      },
      refusal: async (cause) => refusalText(cause, record.kind),
    });
  };

  return (
    <form noValidate onSubmit={submit} className="flex flex-col gap-4">
      <fieldset disabled={saving} className="contents">
        <div className="flex flex-col gap-2">
          <AdminRadioField label={TEXT.who} value={reach} options={REACH} onChange={setReach} />
          {!everyone && (
            <>
              {roles.status === "loading" && <RowSkeletons />}
              {roles.status === "error" && <LoadFailed onRetry={roles.reload} />}
              {roles.data !== undefined && <HolderSearch roles={roles.data} chosen={chosen} onChange={setChosen} />}
              <HolderChips
                chosen={chosen}
                onRemove={(holder) =>
                  setChosen((current) => current.filter((item) => holderKey(item) !== holderKey(holder)))
                }
              />
            </>
          )}
        </div>
        {reachesSomeone && (
          <Delivery label={TEXT.adminDelivery(record.name)} kind={record.kind} offer={offer} onChange={setOffer} />
        )}
      </fieldset>
      {error !== null && <FormError>{error}</FormError>}
      <ShareActions saving={saving} disabled={!changed || roles.status !== "ready"} />
    </form>
  );
}

/** «Найти роль или сотрудника»: roles match the text here, employees come from the panel's search. */
function HolderSearch({
  roles,
  chosen,
  onChange,
}: {
  roles: RoleList;
  chosen: Holder[];
  onChange: (chosen: Holder[]) => void;
}) {
  const [query, setQuery] = useState("");
  const searched = useDebouncedValue(query.trim(), EMPLOYEE_SEARCH_DELAY_MS);
  const users = useResource(() => adminApi.users.list({ query: searched, cursor: null }), searched, "library");

  const candidates = useMemo((): Holder[] => {
    const needle = query.trim().toLocaleLowerCase("ru");
    const matchingRoles = roles
      .filter((role) => role.name.toLocaleLowerCase("ru").includes(needle))
      .sort(byName)
      .map((role): Holder => ({ kind: "role", id: role.id, name: role.name }));
    const found = (users.data?.users ?? []).map(
      (user): Holder => ({ kind: "user", id: user.id, name: user.name, email: user.email }),
    );
    return [...matchingRoles, ...found];
  }, [roles, users.data, query]);

  return (
    <Combobox.Root
      multiple
      items={candidates}
      // The list is already narrowed: roles here, employees by the server.
      filter={null}
      value={chosen}
      onValueChange={onChange}
      isItemEqualToValue={(item: Holder, value: Holder) => holderKey(item) === holderKey(value)}
      itemToStringLabel={(holder: Holder) => holder.name}
      inputValue={query}
      onInputValueChange={setQuery}
    >
      <Combobox.Input
        render={<Input className="text-data md:text-data" />}
        aria-label={TEXT.search}
        placeholder={`${TEXT.search}…`}
      />
      <Combobox.Portal>
        <Combobox.Positioner sideOffset={4} className="isolate z-50">
          <Combobox.Popup className="max-h-[min(var(--available-height),16rem)] w-(--anchor-width) overflow-y-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10">
            <Combobox.Empty className={cn(CAPTION, "px-2 py-1.5 text-muted-foreground empty:hidden")}>
              {users.status === "error" ? TEXT.usersFailed : TEXT.noMatches}
            </Combobox.Empty>
            <Combobox.List>
              {(holder: Holder) => (
                <Combobox.Item
                  key={holderKey(holder)}
                  value={holder}
                  className="flex cursor-default items-center gap-2 rounded-md px-2 py-1 text-data outline-hidden select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground"
                >
                  <HolderIcon kind={holder.kind} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">{holder.name}</span>
                    {holder.email !== undefined && (
                      <span className={cn(CAPTION, "truncate text-muted-foreground")}>{holder.email}</span>
                    )}
                  </span>
                  <Combobox.ItemIndicator>
                    <CheckIcon className="size-4" aria-hidden />
                  </Combobox.ItemIndicator>
                </Combobox.Item>
              )}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}

function HolderIcon({ kind }: { kind: HolderKind }) {
  const Icon = kind === "role" ? Users : User;
  return <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />;
}

/** «Выбранные»: a chip per role or employee with «Убрать»; empty — only administrators see the record. */
function HolderChips({ chosen, onRemove }: { chosen: Holder[]; onRemove: (holder: Holder) => void }) {
  if (chosen.length === 0) {
    return <p className={cn(CAPTION, "text-muted-foreground")}>{TEXT.onlyAdmins}</p>;
  }
  return (
    <ul className="flex flex-wrap gap-2">
      {chosen.map((holder) => (
        <li
          key={holderKey(holder)}
          className="flex items-center gap-1 rounded-md border border-border bg-muted py-0.5 pr-0.5 pl-2 text-data text-foreground"
        >
          <HolderIcon kind={holder.kind} />
          <span className="max-w-48 truncate">{holder.name}</span>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={TEXT.remove(holder.name, holder.kind)}
            onClick={() => onRemove(holder)}
          >
            <X aria-hidden />
          </Button>
        </li>
      ))}
    </ul>
  );
}

// ---------- Общие части ----------

/** `chat` — `offerInChat`; `library` — read and copy only. */
type DeliveryValue = "chat" | "library";

/** «Как … получают»: shows with the first chosen holder, unfolding in 150 ms (none under reduced motion). */
function Delivery({
  label,
  kind,
  offer,
  onChange,
  consequence,
}: {
  label: string;
  kind: RecordKind;
  offer: boolean;
  onChange: (offer: boolean) => void;
  /** The employee's line about what colleagues see; the administrator has none. */
  consequence?: string;
}) {
  const options: readonly AdminRadioOption<DeliveryValue>[] = [
    { value: "chat", label: TEXT.offer(kind) },
    { value: "library", label: TEXT.libraryOnly },
  ];
  return (
    <div className="flex flex-col gap-2 duration-150 animate-in fade-in-0 slide-in-from-top-1 motion-reduce:animate-none">
      <AdminRadioField
        label={label}
        value={offer ? "chat" : "library"}
        options={options}
        onChange={(value) => onChange(value === "chat")}
      />
      {consequence !== undefined && (
        <p className={cn(CAPTION, "flex items-start gap-2 text-muted-foreground")}>
          <Info className="size-4 shrink-0" aria-hidden />
          {consequence}
        </p>
      )}
    </div>
  );
}

function RowSkeletons() {
  return (
    <div className="flex flex-col gap-2" aria-hidden>
      <Skeleton className="h-5 w-40" />
      <Skeleton className="h-5 w-32" />
      <Skeleton className="h-5 w-36" />
    </div>
  );
}

/** «Ошибка загрузки»: the text and «Повторить» in place of the roles. */
function LoadFailed({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-data text-muted-foreground">
      {TEXT.rolesFailed}
      <Button type="button" variant="outline" size="sm" onClick={onRetry}>
        {TEXT.retry}
      </Button>
    </div>
  );
}

function ShareActions({ saving, disabled }: { saving: boolean; disabled: boolean }) {
  return (
    <DialogFooter>
      <DialogClose render={<Button type="button" variant="outline" size="sm" />} disabled={saving}>
        {FORM_TEXT.cancel}
      </DialogClose>
      <Button type="submit" size="sm" disabled={saving || disabled}>
        {saving && <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden />}
        {TEXT.save}
      </Button>
    </DialogFooter>
  );
}
