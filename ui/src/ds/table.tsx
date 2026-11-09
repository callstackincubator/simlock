import "./table.css";

import {
  createColumnHelper,
  createPaginatedRowModel,
  type RowData,
  rowPaginationFeature,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import type { MouseEvent, ReactNode } from "react";
import { Fragment, useLayoutEffect, useRef, useState } from "react";

import { useNavigateTo } from "./link";
import { type MenuEntry, MenuRow, RowMenu } from "./menu";
import { Pager, type Paging } from "./pager";

export interface Column<T> {
  readonly header: string;
  // why: called as the table draws, not mounted, so it calls no hook: a component it returns may.
  readonly cell: (row: T) => ReactNode;
  readonly numeric?: boolean;
  readonly mono?: boolean;
  // why: a fixed column keeps its width, so the first column takes the rest and a row never moves.
  readonly width?: string;
  // why: a page sizes or marks one column in its own sheet.
  readonly className?: string;
  // why: a column that holds no text of its own (a reserved width) is still named for a screen reader.
  readonly hideHeader?: boolean;
  // why: when the table is too narrow for its columns the first (identity) column stays and the others
  // go in this order, the lowest number first; a column with none never goes.
  readonly drop?: number;
  // why: a column sized by its page's sheet (no `width`) says how much room it takes, for the fit above.
  readonly fit?: number;
}

// why: the identity column keeps this much, and a column with no width of its own counts this much.
const FIRST_MIN_PX = 180;
const OPEN_MIN_PX = 120;
const MENU_PX = 80;

function pixels(column: Column<unknown>): number {
  if (column.fit !== undefined) return column.fit;
  const parsed = column.width === undefined ? Number.NaN : Number.parseFloat(column.width);
  return Number.isFinite(parsed) ? parsed : OPEN_MIN_PX;
}

// why: the columns to leave out of a card this wide, taken from the lowest `drop` upward until the
// rest fit; a stacked table shows every column as a labelled line.
function droppedColumns<T>(
  columns: readonly Column<T>[],
  available: number,
  hasMenu: boolean,
): ReadonlySet<number> {
  const gone = new Set<number>();
  const order = columns
    .map((column, index) => ({ drop: column.drop, index }))
    .filter((entry) => entry.drop !== undefined && entry.index > 0)
    .sort((a, b) => (a.drop ?? 0) - (b.drop ?? 0));
  const need = () =>
    columns.reduce(
      (sum, column, index) =>
        sum +
        (gone.has(index) ? 0 : index === 0 ? FIRST_MIN_PX : pixels(column as Column<unknown>)),
      hasMenu ? MENU_PX : 0,
    );
  for (const entry of order) {
    if (need() <= available) break;
    gone.add(entry.index);
  }
  return gone;
}

const features = tableFeatures({
  paginatedRowModel: createPaginatedRowModel(),
  rowPaginationFeature,
});

export interface Group {
  readonly id: string;
  readonly label: string;
}

interface MenuSpec<T> {
  readonly label: (row: T) => string;
  readonly entries: (row: T) => readonly MenuEntry[];
}

interface DrawnRow<T> {
  readonly id: string;
  readonly original: T;
  readonly cells: readonly { readonly id: string; readonly column: string }[];
}

interface BodyContext<T> {
  readonly columns: readonly Column<T>[];
  readonly groupBy: ((row: T) => Group) | undefined;
  readonly menu: MenuSpec<T> | undefined;
  readonly navigate: ((to: string) => void) | undefined;
  readonly rowClassName: ((row: T) => string | undefined) | undefined;
  readonly rowTo: ((row: T) => string) | undefined;
  readonly gone: ReadonlySet<number>;
  readonly selectedId: string | undefined;
}

const COUNT = new Intl.NumberFormat("en-US");

// why: the count line is a table's own footer; `paging.range` is the caller's text for the rows it
// cut out, and without paging the table shows every row, so its range is the whole list.
function countText(paging: Paging | undefined, total: number): string {
  if (paging !== undefined) return paging.range;
  const all = COUNT.format(total);
  return `1–${all} of ${all}`;
}

export function DataTable<T extends RowData>(props: {
  readonly label: string;
  readonly rows: readonly T[];
  readonly columns: readonly Column<T>[];
  readonly rowId: (row: T) => string;
  readonly empty: string;
  // why: a table given no `paging` shows every row and no pager.
  readonly paging?: Paging | undefined;
  readonly wide?: boolean | undefined;
  readonly className?: string | undefined;
  // why: a row that opens something is clicked anywhere; its first link stays the keyboard's way in.
  readonly rowTo?: ((row: T) => string) | undefined;
  // why: the row's ⋯ menu, in a last column of its own that has no header text to show.
  readonly menu?: MenuSpec<T> | undefined;
  readonly groupBy?: ((row: T) => Group) | undefined;
  // why: a page tints or marks a row (a worker needing attention) in its own sheet.
  readonly rowClassName?: ((row: T) => string | undefined) | undefined;
  readonly footer?: "count" | "pager" | undefined;
  // why: a page that shows only the first rows of a list says so in the count line's own words.
  readonly count?: string | undefined;
  readonly selectedId?: string | undefined;
}) {
  const {
    className,
    columns,
    count,
    empty,
    footer = "pager",
    groupBy,
    label,
    menu,
    paging,
    rowClassName,
    rowId,
    rowTo,
    rows,
    selectedId,
    wide = false,
  } = props;
  const navigate = useNavigateTo();
  const card = useRef<HTMLDivElement>(null);
  const [gone, setGone] = useState<ReadonlySet<number>>(new Set());
  // why: the effect reads the latest columns through a ref and runs again only when the table's shape
  // changes, since a state update from an effect that runs on every render would loop.
  const latest = useRef(columns);
  latest.current = columns;
  const hasMenu = menu !== undefined;
  const hasDrops = columns.some((column) => column.drop !== undefined);
  const shape = columns.length;
  const noRows = rows.length === 0;
  useLayoutEffect(() => {
    const element = card.current;
    if (element === null || !hasDrops) return;
    const measure = () => {
      const table = element.querySelector("table");
      const blocks = table !== null && getComputedStyle(table).display === "block";
      const next = blocks
        ? new Set<number>()
        : droppedColumns(latest.current, element.clientWidth, hasMenu);
      setGone((previous) =>
        previous.size === next.size && [...next].every((index) => previous.has(index))
          ? previous
          : next,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasDrops, hasMenu, shape, noRows]);
  // why: `FlexRender` mounts a cell function as a component, and a view builds its columns anew on
  // every render, so each refresh would mount a new component, draw the cell's elements afresh and
  // take the keyboard's focus off a link in it. Each cell's function is called instead.
  const helper = createColumnHelper<typeof features, T>();
  const definitions = helper.columns(
    columns.map((column, index) => helper.display({ header: column.header, id: String(index) })),
  );
  // why: the page belongs to whoever hands in `paging` (the URL, in the console); the table only
  // cuts that page out of the rows.
  const table = useTable({
    autoResetPageIndex: false,
    columns: definitions,
    data: rows as T[],
    features,
    getRowId: (row) => rowId(row),
    state: {
      pagination:
        paging === undefined
          ? { pageIndex: 0, pageSize: Math.max(rows.length, 1) }
          : { pageIndex: paging.page - 1, pageSize: paging.size },
    },
  });
  if (rows.length === 0) {
    return (
      <div className="table-card">
        <p className="muted table-empty">{empty}</p>
      </div>
    );
  }
  const classes = ["table", wide ? "table-wide" : undefined, className].filter(Boolean).join(" ");
  return (
    <div className="table-card" ref={card}>
      <table className={classes}>
        <thead>
          <tr>
            {columns.map((column, index) =>
              gone.has(index) ? null : (
                <th
                  key={column.header}
                  scope="col"
                  className={cellClass(column.numeric, undefined, column.className)}
                  style={column.width === undefined ? undefined : { width: column.width }}
                >
                  {column.hideHeader === true ? (
                    <span className="visually-hidden">{column.header}</span>
                  ) : (
                    column.header
                  )}
                </th>
              ),
            )}
            {menu === undefined ? null : (
              <th scope="col" className="table-menu">
                <span className="visually-hidden">Actions</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {bodyRows(
            table.getRowModel().rows.map((row) => ({
              id: row.id,
              original: row.original,
              cells: row.getAllCells().map((cell) => ({ id: cell.id, column: cell.column.id })),
            })),
            { columns, gone, groupBy, menu, navigate, rowClassName, rowTo, selectedId },
          )}
        </tbody>
      </table>
      {footer === "count" ? (
        <p className="muted table-count">{count ?? countText(paging, rows.length)}</p>
      ) : paging === undefined ? null : (
        <Pager label={label} paging={paging} />
      )}
    </div>
  );
}

function cellClass(numeric = false, mono = false, extra?: string): string | undefined {
  const base = numeric ? "num" : mono ? "mono" : undefined;
  return [base, extra].filter(Boolean).join(" ") || undefined;
}

function rowClass(link: string | undefined, selected: boolean, extra?: string): string | undefined {
  return (
    [link, selected ? "table-row-selected" : undefined, extra].filter(Boolean).join(" ") ||
    undefined
  );
}

function rowCells<T>(
  row: DrawnRow<T>,
  columns: readonly Column<T>[],
  menu: MenuSpec<T> | undefined,
  gone: ReadonlySet<number>,
) {
  return (
    <>
      {row.cells.map((cell) => {
        if (gone.has(Number(cell.column))) return null;
        const column = columns[Number(cell.column)];
        return (
          <td
            key={cell.id}
            data-label={column?.header}
            className={cellClass(column?.numeric, column?.mono, column?.className)}
          >
            {column?.cell(row.original)}
          </td>
        );
      })}
      {menu === undefined ? null : (
        <td className="table-menu">
          <RowMenu label={menu.label(row.original)} entries={menu.entries(row.original)} />
        </td>
      )}
    </>
  );
}

function dataRowOf<T>(row: DrawnRow<T>, context: BodyContext<T>) {
  const { columns, gone, menu, navigate, rowClassName, rowTo, selectedId } = context;
  const extra = rowClassName?.(row.original);
  const link = rowTo === undefined ? undefined : "table-row-link";
  const selected = selectedId !== undefined && selectedId === row.id;
  const onClick =
    rowTo === undefined
      ? undefined
      : (event: MouseEvent<HTMLTableRowElement>) => {
          if ((event.target as HTMLElement).closest("a, button") === null) {
            navigate?.(rowTo(row.original));
          }
        };
  const cells = rowCells(row, columns, menu, gone);
  if (menu === undefined) {
    return (
      <tr
        aria-selected={selected || undefined}
        className={rowClass(link, selected, extra)}
        onClick={onClick}
      >
        {cells}
      </tr>
    );
  }
  return (
    <MenuRow
      className={rowClass(link, selected, extra)}
      onClick={onClick}
      entries={menu.entries(row.original)}
      selected={selected}
    >
      {cells}
    </MenuRow>
  );
}

function bodyRows<T>(rows: readonly DrawnRow<T>[], context: BodyContext<T>) {
  let drawn: string | undefined;
  const span = context.columns.length - context.gone.size + (context.menu === undefined ? 0 : 1);
  return rows.map((row) => {
    const group = context.groupBy?.(row.original);
    const heading = group !== undefined && group.id !== drawn;
    if (group !== undefined) drawn = group.id;
    const dataRow = dataRowOf(row, context);
    if (!heading) return <Fragment key={row.id}>{dataRow}</Fragment>;
    return (
      <Fragment key={row.id}>
        <tr className="table-group">
          <td colSpan={span}>{group?.label}</td>
        </tr>
        {dataRow}
      </Fragment>
    );
  });
}
