import "./worker-table.css";

import type { ComponentProps } from "react";

import { Hint } from "./hint";
import { Link, useNavigateTo } from "./link";
import { type MenuEntry, RowMenu } from "./menu";
import { Meter } from "./meter";
import { type Slot, Slots } from "./slots";
import { type Column, DataTable } from "./table";
import { Pill } from "./visuals";

type Tone = ComponentProps<typeof Pill>["tone"];

// why: plain values only. A page builds these from its own data, so the table is the same wherever
// workers are listed.
export interface WorkerTableRow {
  readonly id: string;
  readonly name: string;
  readonly to: string;
  readonly system?: string;
  readonly version?: string;
  readonly health: { readonly tone: Tone; readonly word: string };
  readonly reason: string;
  readonly summary: string;
  readonly slots: readonly Slot[];
  readonly slotsLabel: string;
  readonly meters: readonly {
    readonly label: string;
    readonly percent?: number;
    readonly tone: ComponentProps<typeof Meter>["tone"];
  }[];
  readonly leaseCount?: number;
}

export interface WorkerTableGroup<R extends WorkerTableRow> {
  readonly id: "attention" | "healthy";
  readonly label: string;
  readonly rows: readonly R[];
}

function osLine(row: WorkerTableRow): string {
  return [row.system, row.version].filter((part) => part !== undefined).join(" · ");
}

function Metric(props: { readonly row: WorkerTableRow; readonly label: string }) {
  const meter = props.row.meters.find((candidate) => candidate.label === props.label);
  const percent = meter?.percent;
  return (
    <span className="fleet-metric">
      {percent === undefined ? (
        <span className="fleet-metric-empty" />
      ) : (
        <Meter percent={percent} tone={meter?.tone ?? "neutral"} size="thin" />
      )}
      <b>{percent === undefined ? "—" : `${percent}%`}</b>
    </span>
  );
}

function metricColumn<R extends WorkerTableRow>(
  header: string,
  label: string,
  drop: number,
): Column<R> {
  return {
    cell: (row) => <Metric row={row} label={label} />,
    drop,
    header,
    width: "96px",
  };
}

// why: the reason a worker is not healthy is a line too long for the cell; it shows on hover and on
// keyboard focus of the pill.
function StatePill({ row }: { readonly row: WorkerTableRow }) {
  return (
    <Hint text={row.health.tone === "ok" ? "" : row.reason}>
      <Pill tone={row.health.tone}>{row.health.word}</Pill>
    </Hint>
  );
}

function columnsOf<R extends WorkerTableRow>(): readonly Column<R>[] {
  return [
    {
      cell: (row) => (
        <>
          <Link className="fleet-name cell-line" to={row.to} title={row.name}>
            {row.name}
          </Link>
          <span className="cell-line" title={osLine(row)}>
            {osLine(row)}
          </span>
        </>
      ),
      header: "Worker",
    },
    {
      cell: (row) => <StatePill row={row} />,
      header: "State",
      width: "140px",
    },
    {
      cell: (row) =>
        row.slots.length === 0 ? null : <Slots slots={row.slots} label={row.slotsLabel} />,
      drop: 5,
      header: "Slots",
      width: "120px",
    },
    metricColumn("CPU", "CPU", 4),
    metricColumn("Mem", "Memory", 2),
    metricColumn("Disk", "Disk", 3),
    {
      cell: (row) => (row.leaseCount === undefined ? "—" : String(row.leaseCount)),
      drop: 1,
      header: "Leases",
      numeric: true,
      width: "64px",
    },
  ];
}

const rowTone = (row: WorkerTableRow) => `row-${row.health.tone === "error" ? "error" : "warn"}`;

// why: under 1100px a worker is a list row, not a table row: name and pill, one muted line of
// figures, and its menu. The sheet shows this list there and the table above it.
function WorkerList<R extends WorkerTableRow>(props: {
  readonly groups: readonly WorkerTableGroup<R>[];
  readonly entries: (row: R) => readonly MenuEntry[];
  readonly count: string | undefined;
}) {
  const navigate = useNavigateTo();
  return (
    <div className="fleet-list" role="list" aria-label="Workers">
      {props.groups.map((group) => (
        <div key={group.id} role="presentation">
          <p className="fleet-list-group">{group.label}</p>
          {group.rows.map((row) => (
            <div
              key={row.id}
              role="listitem"
              className={`fleet-item table-row-link${group.id === "attention" ? ` ${rowTone(row)}` : ""}`}
              onClick={(event) => {
                if ((event.target as HTMLElement).closest("a, button") === null) navigate?.(row.to);
              }}
            >
              <div className="fleet-item-main">
                <p className="fleet-item-head">
                  <Link className="fleet-name" to={row.to} title={row.name}>
                    {row.name}
                  </Link>
                  <StatePill row={row} />
                </p>
                <p className="fleet-item-line" title={row.summary}>
                  {row.summary}
                </p>
              </div>
              <RowMenu label={`Actions for ${row.name}`} entries={props.entries(row)} />
            </div>
          ))}
        </div>
      ))}
      {props.count === undefined ? null : <p className="muted fleet-list-count">{props.count}</p>}
    </div>
  );
}

// why: the Fleet page and the Overview's Fleet card draw workers through this one table: a grouped
// data table on a wide screen, a list of two-line rows on a narrow one. `count` is the footer's own
// words when the rows shown are not all the workers there are.
export function WorkerTable<R extends WorkerTableRow>(props: {
  readonly groups: readonly WorkerTableGroup<R>[];
  readonly entries: (row: R) => readonly MenuEntry[];
  readonly count?: string | undefined;
}) {
  const { entries, groups } = props;
  const rows = groups.flatMap((group) => group.rows);
  const attention = new Set(
    groups
      .filter((group) => group.id === "attention")
      .flatMap((group) => group.rows.map((r) => r.id)),
  );
  return (
    <>
      <WorkerList groups={groups} entries={entries} count={props.count} />
      <div className="fleet-wide">
        <DataTable
          label="Workers"
          rows={rows}
          columns={columnsOf<R>()}
          rowId={(row) => row.id}
          empty="No workers."
          menu={{
            entries: (row) => entries(row),
            label: (row) => `Actions for ${row.name}`,
          }}
          groupBy={(row) => {
            const group = groups.find((candidate) => candidate.rows.includes(row));
            return { id: group?.id ?? "healthy", label: group?.label ?? "" };
          }}
          rowClassName={(row) => (attention.has(row.id) ? rowTone(row) : undefined)}
          rowTo={(row) => row.to}
          className="fleet-table table-lines"
          footer="count"
          count={props.count}
          wide
        />
      </div>
    </>
  );
}
