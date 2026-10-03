/**
 * The console's one table, built on `@tanstack/react-table`, with its pager under it. Every
 * table of a view's items is one of these: the rows come whole from the route the view reads,
 * and the table pages them in the browser. The page lives in the URL (see `pager.tsx`). A
 * chart's minute-by-minute table is not: it always has its 60 rows.
 */
import {
  createColumnHelper,
  createPaginatedRowModel,
  type RowData,
  rowPaginationFeature,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import type { ReactNode } from "react";

import { Pager, usePaging } from "./pager";
import { TABLE_SIZES } from "./paging";

/** One column: its header, and what each row shows in it. */
export interface Column<T> {
  readonly header: string;
  readonly cell: (row: T) => ReactNode;
  /** A number or a duration: mono, and right-aligned where the table has columns. */
  readonly numeric?: boolean;
  /** Mono, for what people copy or compare. */
  readonly mono?: boolean;
}

const features = tableFeatures({
  paginatedRowModel: createPaginatedRowModel(),
  rowPaginationFeature,
});

/**
 * `rows` as a table, a page at a time. Rows show in the order given: the table never sorts, so
 * a row moves only when the data moves it. `rowId` keeps each row's identity across refreshes.
 * Each cell carries its column's header as `data-label`, so on a phone the row stacks into
 * labelled lines. A `wide` table, of six columns or more, stacks below 1100px as well.
 */
export function DataTable<T extends RowData>(props: {
  /** Names the table's pager: the title of the panel it sits in. */
  readonly label: string;
  readonly rows: readonly T[];
  readonly columns: readonly Column<T>[];
  readonly rowId: (row: T) => string;
  /** What to say instead of an empty table. */
  readonly empty: string;
  /** Where the table keeps its page in the URL, when a page has more than one table. */
  readonly name?: string;
  readonly wide?: boolean;
  readonly className?: string;
}) {
  const { className, columns, empty, label, name, rowId, rows, wide = false } = props;
  const paging = usePaging({
    ...(name === undefined ? {} : { name }),
    sizes: TABLE_SIZES,
    total: rows.length,
  });
  // A view builds its columns on every render, round the facts it has now, so these are too.
  const helper = createColumnHelper<typeof features, T>();
  const definitions = helper.columns(
    columns.map((column, index) =>
      helper.display({
        cell: ({ row }) => column.cell(row.original),
        header: column.header,
        id: String(index),
      }),
    ),
  );
  // The URL owns the page (`usePaging`), and the pager moves it; the table cuts out that page.
  const table = useTable({
    autoResetPageIndex: false,
    columns: definitions,
    data: rows as T[],
    features,
    getRowId: (row) => rowId(row),
    state: { pagination: { pageIndex: paging.at.page - 1, pageSize: paging.at.size } },
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
            <tr key={row.id}>
              {row.getAllCells().map((cell) => {
                const column = columns[Number(cell.column.id)];
                return (
                  <td
                    key={cell.id}
                    data-label={column?.header}
                    className={cellClass(column?.numeric, column?.mono)}
                  >
                    <table.FlexRender cell={cell} />
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
