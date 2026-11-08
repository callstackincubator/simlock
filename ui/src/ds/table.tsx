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
import { Fragment } from "react";

import { useNavigateTo } from "./link";
import { type MenuEntry, MenuRow, RowMenu } from "./menu";
import { Pager, type Paging } from "./pager";

export interface Column<T> {
  readonly header: string;
  // why: called as the table draws, not mounted, so it calls no hook: a component it returns may.
  readonly cell: (row: T) => ReactNode;
  readonly numeric?: boolean;
  readonly mono?: boolean;
  // why: a page sizes or marks one column in its own sheet; the table knows no widths.
  readonly className?: string;
  // why: a column that holds no text of its own (a reserved width) is still named for a screen reader.
  readonly hideHeader?: boolean;
}

const features = tableFeatures({
  paginatedRowModel: createPaginatedRowModel(),
  rowPaginationFeature,
});

export interface Group {
  readonly id: string;
  readonly label: string;
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
  readonly menu?:
    | {
        readonly label: (row: T) => string;
        readonly entries: (row: T) => readonly MenuEntry[];
      }
    | undefined;
  readonly groupBy?: ((row: T) => Group) | undefined;
  readonly footer?: "count" | "pager" | undefined;
  readonly selectedId?: string | undefined;
}) {
  const {
    className,
    columns,
    empty,
    footer = "pager",
    groupBy,
    label,
    menu,
    paging,
    rowId,
    rowTo,
    rows,
    selectedId,
    wide = false,
  } = props;
  const navigate = useNavigateTo();
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
    <div className="table-card">
      <table className={classes}>
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.header}
                scope="col"
                className={cellClass(column.numeric, undefined, column.className)}
              >
                {column.hideHeader === true ? (
                  <span className="visually-hidden">{column.header}</span>
                ) : (
                  column.header
                )}
              </th>
            ))}
            {menu === undefined ? null : (
              <th scope="col" className="table-menu">
                <span className="visually-hidden">Actions</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {(() => {
            let drawn: string | undefined;
            const span = columns.length + (menu === undefined ? 0 : 1);
            return table.getRowModel().rows.map((row) => {
              const group = groupBy?.(row.original);
              const heading = group !== undefined && group.id !== drawn;
              if (group !== undefined) drawn = group.id;
              const className = rowTo === undefined ? undefined : "table-row-link";
              const selected = selectedId !== undefined && selectedId === row.id;
              const onClick =
                rowTo === undefined
                  ? undefined
                  : (event: MouseEvent<HTMLTableRowElement>) => {
                      if ((event.target as HTMLElement).closest("a, button") === null) {
                        navigate?.(rowTo(row.original));
                      }
                    };
              const cells = (
                <>
                  {row.getAllCells().map((cell) => {
                    const column = columns[Number(cell.column.id)];
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
                      <RowMenu
                        label={menu.label(row.original)}
                        entries={menu.entries(row.original)}
                      />
                    </td>
                  )}
                </>
              );
              const dataRow =
                menu === undefined ? (
                  <tr
                    aria-selected={selected || undefined}
                    className={rowClass(className, selected)}
                    onClick={onClick}
                  >
                    {cells}
                  </tr>
                ) : (
                  <MenuRow
                    className={rowClass(className, selected)}
                    onClick={onClick}
                    entries={menu.entries(row.original)}
                    selected={selected}
                  >
                    {cells}
                  </MenuRow>
                );
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
          })()}
        </tbody>
      </table>
      {footer === "count" ? (
        <p className="muted table-count mono">{countText(paging, rows.length)}</p>
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

function rowClass(link: string | undefined, selected: boolean): string | undefined {
  return [link, selected ? "table-row-selected" : undefined].filter(Boolean).join(" ") || undefined;
}
