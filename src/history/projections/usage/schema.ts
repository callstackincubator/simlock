import type { SqliteDatabase } from "../../../ports/index.js";
import { USAGE_VALUES } from "./types.js";

interface TableDefinition {
  readonly name: string;
  readonly columns: ReadonlyArray<readonly [string, string]>;
  readonly constraints?: string;
  readonly suffix?: string;
  readonly indexes: readonly string[];
}

const valueColumns = USAGE_VALUES.flatMap(
  (value): Array<readonly [string, string]> => [
    [`${value}Peak`, "REAL"],
    [`${value}Last`, "REAL"],
    [`${value}Integral`, "REAL"],
  ],
);

export const USAGE_TABLES: readonly TableDefinition[] = [
  {
    columns: [
      ["requestId", "TEXT PRIMARY KEY"],
      ["requester", "TEXT NOT NULL"],
      ["platform", "TEXT NOT NULL"],
      ["model", "TEXT"],
      ["workerId", "TEXT"],
      ["requestedAt", "INTEGER NOT NULL"],
      ["grantedAt", "INTEGER"],
      ["rejectedAt", "INTEGER"],
      ["reason", "TEXT"],
      ["source", "TEXT"],
      ["leaseId", "TEXT"],
      ["workerLeaseId", "TEXT"],
      ["heldMs", "INTEGER"],
      ["endedAt", "INTEGER"],
      ["endReason", "TEXT"],
      ["probe", "INTEGER NOT NULL"],
      ["declined", "INTEGER"],
      ["refusedAtAdmission", "INTEGER"],
    ],
    indexes: [
      "CREATE INDEX request_rows_requested ON request_rows (requestedAt, requestId)",
      "CREATE INDEX request_rows_lease ON request_rows (leaseId)",
      "CREATE INDEX request_rows_worker_lease ON request_rows (workerId, workerLeaseId)",
    ],
    name: "request_rows",
  },
  {
    columns: [
      ["workerId", "TEXT NOT NULL"],
      ["platform", "TEXT NOT NULL"],
      ["minute", "INTEGER NOT NULL"],
      ["knownMs", "INTEGER NOT NULL"],
      ["carryUntil", "INTEGER"],
      ...valueColumns,
    ],
    constraints: "PRIMARY KEY (workerId, platform, minute)",
    indexes: [],
    name: "minute_rows",
    suffix: "WITHOUT ROWID",
  },
  {
    columns: [
      ["id", "INTEGER PRIMARY KEY"],
      ["at", "INTEGER NOT NULL"],
      ["kind", "TEXT NOT NULL"],
      ["durationMs", "INTEGER"],
      ["platform", "TEXT"],
      ["workerId", "TEXT"],
      ["deviceId", "TEXT"],
    ],
    indexes: ["CREATE INDEX device_fact_rows_at ON device_fact_rows (at, id)"],
    name: "device_fact_rows",
  },
  {
    columns: [
      ["at", "INTEGER PRIMARY KEY"],
      ["workerId", "TEXT"],
    ],
    indexes: [],
    name: "gaps",
  },
  {
    columns: [
      ["workerId", "TEXT NOT NULL"],
      ["leaseId", "TEXT NOT NULL"],
      ["platform", "TEXT NOT NULL"],
      ["source", "TEXT"],
      ["at", "INTEGER NOT NULL"],
    ],
    constraints: "PRIMARY KEY (workerId, leaseId)",
    indexes: ["CREATE INDEX held_leases_at ON held_leases (at)"],
    name: "held_leases",
  },
];

function createStatements(table: TableDefinition): string[] {
  const body = [
    ...table.columns.map(([name, declaration]) => `${name} ${declaration}`),
    ...(table.constraints === undefined ? [] : [table.constraints]),
  ].join(", ");
  return [`CREATE TABLE ${table.name} (${body}) ${table.suffix ?? ""}`, ...table.indexes];
}

export const USAGE_MIGRATIONS: readonly string[] = [
  USAGE_TABLES.flatMap(createStatements)
    .map((statement) => `${statement};`)
    .join("\n"),
];

export const USAGE_VERSION = USAGE_MIGRATIONS.length;

function typeOf(declaration: string): string {
  return declaration.split(" ")[0] ?? "";
}

export function tableMatches(database: SqliteDatabase, table: TableDefinition): boolean {
  const present = new Map(
    database
      .prepare(`PRAGMA table_info(${table.name})`)
      .all()
      .map((column) => [String(column.name), String(column.type).toUpperCase()] as const),
  );
  return table.columns.every(([name, declaration]) => present.get(name) === typeOf(declaration));
}

export function checkUsageTables(database: SqliteDatabase): boolean {
  return USAGE_TABLES.every((table) => tableMatches(database, table));
}

export function recreateTable(database: SqliteDatabase, table: TableDefinition): void {
  database.exec(`DROP TABLE IF EXISTS ${table.name}`);
  for (const statement of createStatements(table)) database.exec(statement);
}
