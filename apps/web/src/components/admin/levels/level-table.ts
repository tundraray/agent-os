/**
 * The classes of a level table (access-level-editor, parts 3–5). The table is laid out as columns only from the
 * width of the editor at which its columns fit — a container query on the editor, not the viewport, because the
 * sidebar and the panel's navigation take a varying share of the screen. Below it every element of the table is a
 * block and each row a wrapped flex block: the name on its own line, the level choice on its own (at most 384 px), then the
 * total and the toggle, then «Откуда». A `tr` left `display: table-row` inside a flex row would be wrapped in an
 * anonymous cell and collapse, so the table and its body become blocks too, and the row loses its fixed height.
 */
export type LevelTableClasses = {
  /** On the element that holds the table: the container the breakpoint measures. */
  container: string;
  table: string;
  header: string;
  body: string;
  row: string;
  cell: string;
  /** A part that takes a line of its own when stacked: the name, the level choice, «Откуда». */
  line: string;
  /** «Откуда»: after the total and the toggle when stacked. */
  last: string;
  /** The toggle: at the end of the total's line when stacked. */
  end: string;
  pickerRow: string;
  pickerCell: string;
};

/**
 * «Серверы роли»: four columns, three of them fixed (480 px); columns from 640 px, where the server's name keeps
 * 160 px.
 */
export const ROLE_LEVEL_TABLE: LevelTableClasses = {
  container: '@container',
  table: '@min-[640px]:table-fixed @max-[640px]:block',
  header: '@max-[640px]:sr-only',
  body: '@max-[640px]:block',
  row: 'h-10 border-border hover:bg-transparent @max-[640px]:flex @max-[640px]:h-auto @max-[640px]:flex-wrap @max-[640px]:items-center @max-[640px]:gap-x-3 @max-[640px]:gap-y-2 @max-[640px]:py-2',
  cell: 'px-3 py-1 align-middle @max-[640px]:block @max-[640px]:p-0',
  line: '@max-[640px]:min-w-0 @max-[640px]:basis-full',
  last: '@max-[640px]:order-last',
  end: '@max-[640px]:ml-auto',
  pickerRow: '@max-[640px]:block',
  pickerCell: '@max-[640px]:block @max-[640px]:px-0',
};

/**
 * «Роли сервера»: four columns, three of them fixed (512 px, the last holds «Выбрать инструменты»); columns from
 * 672 px, where the role's name keeps 160 px.
 */
export const SERVER_ROLES_TABLE: LevelTableClasses = {
  container: '@container',
  table: '@2xl:table-fixed @max-2xl:block',
  header: '@max-2xl:sr-only',
  body: '@max-2xl:block',
  row: 'h-10 border-border hover:bg-transparent @max-2xl:flex @max-2xl:h-auto @max-2xl:flex-wrap @max-2xl:items-center @max-2xl:gap-x-3 @max-2xl:gap-y-2 @max-2xl:py-2',
  cell: 'px-3 py-1 align-middle @max-2xl:block @max-2xl:p-0',
  line: '@max-2xl:min-w-0 @max-2xl:basis-full',
  last: '@max-2xl:order-last',
  end: '@max-2xl:ml-auto',
  pickerRow: '@max-2xl:block',
  pickerCell: '@max-2xl:block @max-2xl:px-0',
};

/**
 * «Серверы сотрудника»: five columns — the name a quarter of the table, three fixed (464 px), «Откуда» the rest;
 * columns from 768 px, where the name keeps 192 px and «Откуда» 112 px (one source, «SRE — Все»).
 */
export const USER_LEVEL_TABLE: LevelTableClasses = {
  container: '@container',
  table: '@3xl:table-fixed @max-3xl:block',
  header: '@max-3xl:sr-only',
  body: '@max-3xl:block',
  row: 'h-10 border-border hover:bg-transparent @max-3xl:flex @max-3xl:h-auto @max-3xl:flex-wrap @max-3xl:items-center @max-3xl:gap-x-3 @max-3xl:gap-y-2 @max-3xl:py-2',
  cell: 'px-3 py-1 align-middle @max-3xl:block @max-3xl:p-0',
  line: '@max-3xl:min-w-0 @max-3xl:basis-full',
  last: '@max-3xl:order-last',
  end: '@max-3xl:ml-auto',
  pickerRow: '@max-3xl:block',
  pickerCell: '@max-3xl:block @max-3xl:px-0',
};

/** The column heads of every level table. */
export const LEVEL_HEAD =
  'h-8 px-3 text-xs leading-4 font-medium text-muted-foreground';
