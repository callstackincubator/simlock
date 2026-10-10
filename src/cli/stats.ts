import type { UsageFigures, UsageOutput } from "../contract/index.js";

/** The human rendering of `usage.get`'s answer for `simlock stats`. */
export function formatUsage(usage: UsageOutput): string {
  const lines = [`Usage from ${iso(usage.window.from)} to ${iso(usage.window.to)}`];
  if (usage.partial) {
    lines.push(
      `Figures cover from ${iso(usage.coversFrom)}: the history does not reach back to the start of the window.`,
    );
  }
  lines.push("", "Totals", ...totalRows(usage.totals));
  lines.push(
    "",
    "Platforms",
    ...rows(Object.entries(usage.platforms), (figures) => summary(figures)),
  );
  if (usage.workers.length > 0) {
    lines.push(
      "",
      "Workers",
      ...rows(
        usage.workers.map((worker) => [
          worker.label === undefined ? worker.id : `${worker.label} (${worker.id})`,
          worker,
        ]),
        (figures) => summary(figures),
      ),
    );
  }
  if (usage.requesters.length > 0) {
    lines.push(
      "",
      "Requesters",
      ...rows(
        usage.requesters.map((requester) => [
          requester.label === undefined ? requester.id : `${requester.label} (${requester.id})`,
          requester,
        ]),
        (requester) =>
          `${plural(requester.requests, "request")}, ${requester.granted} granted, ` +
          `${requester.rejected} rejected, held ${duration(requester.heldTotalMs)}`,
      ),
    );
  }
  return lines.join("\n");
}

const iso = (ms: number): string => new Date(ms).toISOString();

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** One row for each `[name, item]`, the names set to a common width. */
function rows<Item>(
  entries: readonly (readonly [string, Item])[],
  render: (item: Item) => string,
): string[] {
  const width = Math.max(...entries.map(([name]) => name.length));
  return entries.map(([name, item]) => `  ${name.padEnd(width)}  ${render(item)}`);
}

/** A platform's or a worker's figures on one line. */
function summary(figures: UsageFigures): string {
  return (
    `${plural(figures.requests, "request")}, ${figures.granted} granted, ` +
    `${figures.rejected.total} rejected, wait p50 ${duration(figures.wait.p50)}, ` +
    `held p50 ${duration(figures.held.p50)}, slots peak ${figures.utilisation.slots.peak ?? "-"}`
  );
}

const row = (label: string, value: string): string => `  ${label.padEnd(14)}${value}`;

/** `name count` pairs, by name. */
function list(counts: Readonly<Record<string, number>>): string {
  return Object.entries(counts)
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([name, count]) => `${name} ${count}`)
    .join(", ");
}

function totalRows(totals: UsageFigures): string[] {
  return [
    ...requestRows(totals),
    row("Wait:", samples(totals.wait)),
    row("Held:", samples(totals.held)),
    row("Turnaround:", samples(totals.turnaround)),
    row("Provisioning:", samples(totals.provisioning)),
    row("Boot:", samples(totals.boot)),
    ...capacityRows(totals),
    row(
      "Incidents:",
      `${totals.incidents.quarantined} quarantined, ${totals.incidents.crashRecovered} recovered after a crash, ` +
        `${totals.incidents.quarantineRecovered} recovered from quarantine, ${totals.incidents.lost} lost`,
    ),
    ...(Object.keys(totals.failures.byEvent).length === 0
      ? []
      : [row("Failures:", list(totals.failures.byEvent))]),
  ];
}

/** The requests, and what became of them, leaving out the rows with nothing in them. */
function requestRows({
  bySource,
  declined,
  granted,
  probes,
  rejected,
  requests,
}: UsageFigures): string[] {
  return [
    row("Requests:", `${requests} (${granted} granted, ${rejected.total} rejected)`),
    ...(granted === 0
      ? []
      : [
          row(
            "Granted:",
            `warm ${bySource.warm}, booted ${bySource.booted}, provisioned ${bySource.provisioned}` +
              (bySource.unknown === undefined || bySource.unknown === 0
                ? ""
                : `, unknown ${bySource.unknown}`),
          ),
        ]),
    ...(rejected.total === 0 ? [] : [row("Rejected:", list(rejected.byReason))]),
    ...(declined === 0 ? [] : [row("Declined:", String(declined))]),
    ...(probes === undefined || probes === 0 ? [] : [row("Probes:", String(probes))]),
  ];
}

function capacityRows({ queue, utilisation }: UsageFigures): string[] {
  const { ram, slots } = utilisation;
  return [
    row(
      "Slots:",
      slots.peak === null || slots.max === null || slots.mean === null
        ? "not known"
        : `peak ${figure(slots.peak)} of ${figure(slots.max)}, mean ${figure(slots.mean)}`,
    ),
    ...(ram === undefined
      ? []
      : [
          row(
            "RAM:",
            `peak ${gibibytes(ram.peakBytes)} of ${gibibytes(ram.limitBytes)}, mean ${gibibytes(ram.meanBytes)}`,
          ),
        ]),
    row(
      "Queue:",
      queue.peakDepth === null || queue.meanDepth === null
        ? "not known"
        : `peak depth ${figure(queue.peakDepth)}, mean ${figure(queue.meanDepth)}`,
    ),
  ];
}

function samples(figures: UsageFigures["wait"]): string {
  if (figures.p50 === null || figures.p95 === null || figures.max === null) return "no samples";
  return (
    `p50 ${duration(figures.p50)}, p95 ${duration(figures.p95)}, max ${duration(figures.max)} ` +
    `(${plural(figures.count, "sample")})`
  );
}

/** A number to one decimal, without a trailing `.0`. */
const figure = (value: number): string => String(Math.round(value * 10) / 10);

const gibibytes = (bytes: number): string => `${(bytes / 1024 ** 3).toFixed(1)} GiB`;

/** A time in the unit a person reads it in; `-` for a figure there is none of. */
function duration(ms: number | null): string {
  if (ms === null) return "-";
  if (ms === 0) return "0s";
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${figure(ms / 1_000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1_000)}s`;
  return `${Math.floor(ms / 3_600_000)}h ${Math.floor((ms % 3_600_000) / 60_000)}m`;
}
