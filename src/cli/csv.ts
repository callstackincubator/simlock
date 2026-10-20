import type { UsageLedgerEntry } from "../contract/index.js";

const COLUMNS = [
  "requestId",
  "requester",
  "label",
  "platform",
  "model",
  "workerId",
  "source",
  "requestedAt",
  "grantedAt",
  "rejectedAt",
  "endedAt",
  "waitMs",
  "heldMs",
  "turnaroundMs",
  "outcome",
  "probe",
  "reason",
  "endReason",
] as const satisfies readonly (keyof UsageLedgerEntry)[];

const TIME_COLUMNS: ReadonlySet<string> = new Set([
  "requestedAt",
  "grantedAt",
  "rejectedAt",
  "endedAt",
]);
const DURATION_COLUMNS: ReadonlySet<string> = new Set(["waitMs", "heldMs", "turnaroundMs"]);

function cellText(column: (typeof COLUMNS)[number], entry: UsageLedgerEntry): string {
  const value = entry[column];
  if (value === undefined) return "";
  if (TIME_COLUMNS.has(column)) return new Date(value as number).toISOString();
  if (DURATION_COLUMNS.has(column)) return String(Math.round(value as number));
  return String(value);
}

function cell(text: string): string {
  // why: a spreadsheet runs a cell that starts with one of these as a formula, and requester ids and labels are free text.
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function ledgerCsv(entries: readonly UsageLedgerEntry[]): string {
  const rows = [
    COLUMNS.join(","),
    ...entries.map((entry) => COLUMNS.map((column) => cell(cellText(column, entry))).join(",")),
  ];
  return rows.map((row) => `${row}\r\n`).join("");
}
