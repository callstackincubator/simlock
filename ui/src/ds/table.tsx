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

import { useNavigateTo } from "./link";
import { type MenuEntry, MenuRow, RowMenu } from "./menu";
import { Pager, type Paging } from "./pager";

export interface Column<T> {
  readonly header: string;
  // why: called as the table draws, not mounted, so it calls no hook: a component it returns may.
  readonly cell: (row: T) => ReactNode;
  readonly numeric?: boolean;
  readonly mono?: boolean;
}

const features = tableFeatures({
  paginatedRowModel: createPaginatedRowModel(),
  rowPaginationFeature,
});

export function DataTable<T extends RowData>(props: {
  readonly label: string;
  readonly rows: readonly T[];
  readonly columns: readonly Column<T>[];
  readonly rowId: (row: T) => string;
  readonly empty: string;
  // why: a table given no `paging` shows every row and no pager.
  readonly paging?: Paging;
  readonly wide?: boolean;
  readonly className?: string;
  // why: a row that opens something is clicked anywhere; its first link stays the keyboard's way in.
  readonly rowTo?: (row: T) => string;
  // why: the row's ⋯ menu, in a last column of its own that has no header text to show.
  readonly menu?: {
    readonly label: (row: T) => string;
    readonly entries: (row: T) => readonly MenuEntry[];
  };
}) {
  const {
    className,
    columns,
    empty,
    label,
    menu,
    paging,
    rowId,
    rowTo,
    rows,
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
              <th key={column.header} scope="col" className={column.numeric ? "num" : undefined}>
                {column.header}
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
          {table.getRowModel().rows.map((row) => {
            const className = rowTo === undefined ? undefined : "table-row-link";
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
                      className={cellClass(column?.numeric, column?.mono)}
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
            return menu === undefined ? (
              <tr key={row.id} className={className} onClick={onClick}>
                {cells}
              </tr>
            ) : (
              <MenuRow
                key={row.id}
                className={className}
                onClick={onClick}
                entries={menu.entries(row.original)}
              >
                {cells}
              </MenuRow>
            );
          })}
        </tbody>
      </table>
      {paging === undefined ? null : <Pager label={label} paging={paging} />}
    </div>
  );
}

function cellClass(numeric = false, mono = false): string | undefined {
  if (numeric) return "num";
  return mono ? "mono" : undefined;
}
