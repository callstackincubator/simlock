import "./table.css";

import {
  createColumnHelper,
  createPaginatedRowModel,
  type RowData,
  rowPaginationFeature,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import type { ReactNode } from "react";

import { useNavigateTo } from "./link";
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
  readonly paging: Paging;
  readonly wide?: boolean;
  readonly className?: string;
  // why: a row that opens something is clicked anywhere; its first link stays the keyboard's way in.
  readonly rowTo?: (row: T) => string;
}) {
  const { className, columns, empty, label, paging, rowId, rowTo, rows, wide = false } = props;
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
    state: { pagination: { pageIndex: paging.page - 1, pageSize: paging.size } },
  });
  if (rows.length === 0) return <p className="muted">{empty}</p>;
  const classes = ["table", wide ? "table-wide" : undefined, className].filter(Boolean).join(" ");
  return (
    <>
      <table className={classes}>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.header} scope="col" className={column.numeric ? "num" : undefined}>
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row) => (
            <tr
              key={row.id}
              className={rowTo === undefined ? undefined : "table-row-link"}
              onClick={
                rowTo === undefined
                  ? undefined
                  : (event) => {
                      if ((event.target as HTMLElement).closest("a, button") === null) {
                        navigate?.(rowTo(row.original));
                      }
                    }
              }
            >
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
            </tr>
          ))}
        </tbody>
      </table>
      <Pager label={label} paging={paging} />
    </>
  );
}

function cellClass(numeric = false, mono = false): string | undefined {
  if (numeric) return "num";
  return mono ? "mono" : undefined;
}
