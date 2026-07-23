/**
 * All user-facing CLI output flows through a `Renderer`. Command handlers
 * never call `stdout`/`stderr` directly — they call semantic methods here,
 * and the renderer decides the bytes.
 *
 * `JsonRenderer` reproduces the legacy agent-facing output exactly and is
 * used whenever `--json` is passed, or whenever stdout is not a TTY (the
 * piped/agent case). `HumanRenderer` (clack + picocolors) is used only when
 * running interactively with no `--json`. See docs/CLI.md "Output modes".
 */

import { intro, log, note, outro, spinner, type SpinnerResult } from "@clack/prompts";
import pc from "picocolors";
import type { Writable } from "node:stream";

interface RendererOutput {
  write(value: string): unknown;
}

/** The shape returned by the daemon for a granted lease, as rendered to the CLI user. */
export interface LeaseGrant {
  readonly device: string;
  readonly lease: string;
  readonly os: string;
  readonly platform: "ios" | "android";
  readonly state: "leased";
  readonly udid: string;
}

export interface Renderer {
  /** A command result, printed as one JSON line on stdout (JSON mode) or a readable summary (human mode). */
  result(value: unknown): void;
  /** A lease-progress event pushed from the daemon while waiting, on stderr. */
  progress(payload: unknown): void;
  /** The full status report. */
  status(status: unknown): void;
  /** A plain informational line on stdout (daemon state, confirmations, usage). */
  info(message: string): void;
  /** A plain error line on stderr. */
  error(message: string): void;
  /** Command usage text on stderr, shown alongside an error. */
  usage(text: string): void;
  /** A lease has been granted; `held` distinguishes held mode from detached mode. */
  leaseGranted(result: LeaseGrant, options: { readonly held: boolean }): void;
  /** A held lease was released after SIGINT/SIGTERM. No-op in JSON mode (legacy contract is silent here). */
  leaseReleased(): void;
  /** `list --devices|--leases|--rules`: the raw array from `list.get`. */
  list(kind: "devices" | "leases" | "rules", items: unknown): void;
  /** A single business event, from `events.replay` or `--follow` streaming. */
  event(payload: unknown): void;
  /** The raw `Proposal[]` from `cleanup.run`; `dryRun` selects planned-vs-returned phrasing. */
  cleanup(actions: unknown, options: { readonly dryRun: boolean }): void;
  /** The raw `DoctorReport` from `doctor.run`; `fix` selects problem-vs-corrected phrasing. */
  doctor(report: unknown, options: { readonly fix: boolean }): void;
  /** The raw result of `nuke.run`. */
  nuke(result: unknown): void;
  /** `daemon start|stop|status`: `state` drives the colored word, `raw` is the byte-identical JSON payload. */
  daemonState(state: string, raw: unknown): void;
  /** The effective configuration tree (`config` / `config get <key>`). */
  config(value: unknown): void;
  /** `config set` confirmation: `payload` is the byte-identical JSON result, `details` adds the applied value. */
  configSet(payload: unknown, details: { readonly key: string; readonly value: unknown }): void;
}

/**
 * Strips ANSI/SGR escape sequences. Needed because citty's own `renderUsage`
 * (used for generated `--help` text) colorizes unconditionally unless
 * `NO_COLOR` is exactly `"1"`, `TERM=dumb`, or `CI`/`TEST` is set — it never
 * checks TTY-ness. `JsonRenderer` is used for every non-interactive/agent
 * invocation (piped, redirected, `--json`), so any raw text it forwards
 * (help output, error/usage text) must never carry color regardless of what
 * produced it. See docs/CLI.md "Output modes".
 */
function stripAnsi(value: string): string {
  // eslint-disable-next-line no-control-regex -- matching literal ESC () CSI sequences
  return value.replace(/\[[0-9;]*[a-zA-Z]/g, "");
}

export class JsonRenderer implements Renderer {
  readonly #stderr: RendererOutput;
  readonly #stdout: RendererOutput;

  constructor(environment: { readonly stderr: RendererOutput; readonly stdout: RendererOutput }) {
    this.#stderr = environment.stderr;
    this.#stdout = environment.stdout;
  }

  result(value: unknown): void {
    this.#stdout.write(`${JSON.stringify(value)}\n`);
  }

  progress(payload: unknown): void {
    this.#stderr.write(`${JSON.stringify(progressLine(payload))}\n`);
  }

  /** Verbatim raw JSON — identical to `result()`. Non-TTY `status` (no `--json`) now matches `--json` exactly. */
  status(status: unknown): void {
    this.result(status);
  }

  info(message: string): void {
    this.#stdout.write(`${stripAnsi(message)}\n`);
  }

  error(message: string): void {
    this.#stderr.write(`${stripAnsi(message)}\n`);
  }

  usage(text: string): void {
    this.#stderr.write(`${stripAnsi(text)}\n`);
  }

  leaseGranted(result: LeaseGrant): void {
    this.result(result);
  }

  leaseReleased(): void {
    // Legacy contract: held-mode release after a signal prints nothing on the JSON path.
  }

  list(_kind: "devices" | "leases" | "rules", items: unknown): void {
    this.result(items);
  }

  event(payload: unknown): void {
    this.result(payload);
  }

  cleanup(actions: unknown): void {
    this.result(actions);
  }

  doctor(report: unknown): void {
    this.result(report);
  }

  nuke(result: unknown): void {
    this.result(result);
  }

  daemonState(_state: string, raw: unknown): void {
    this.result(raw);
  }

  config(value: unknown): void {
    this.result(value);
  }

  configSet(payload: unknown): void {
    this.result(payload);
  }
}

function progressLine(value: unknown): {
  readonly event: string;
  readonly eta_seconds?: number;
  readonly queue_position?: number;
} {
  const progress = requireObject(value);
  if (progress.stage === "queued" && typeof progress.queuePosition === "number") {
    return { event: "queued", queue_position: progress.queuePosition };
  }
  if (
    (progress.stage === "provisioning" ||
      progress.stage === "booting" ||
      progress.stage === "reclaiming") &&
    typeof progress.etaMs === "number"
  ) {
    return { eta_seconds: Math.ceil(progress.etaMs / 1_000), event: progress.stage };
  }
  throw new Error("Daemon returned invalid progress");
}

/**
 * Human-facing renderer: clack for decoration/prompts, picocolors for
 * emphasis. Decoration and progress (intro, spinner, note, outro, log lines)
 * are written to the injected stderr; real command results still land on the
 * injected stdout. Never touches global `process.stdout`/`process.stderr`
 * directly, so tests can capture output via injected streams.
 */
export class HumanRenderer implements Renderer {
  readonly #colors: ReturnType<typeof pc.createColors>;
  readonly #noColor: boolean;
  readonly #stderr: RendererOutput;
  readonly #stderrStream: Writable;
  readonly #stdout: RendererOutput;
  #introduced = false;
  #spinner: SpinnerResult | undefined;

  constructor(environment: {
    readonly noColor?: () => boolean;
    readonly stderr: RendererOutput;
    readonly stdout: RendererOutput;
  }) {
    this.#stdout = environment.stdout;
    this.#stderr = environment.stderr;
    // `RendererOutput` only requires `write`, which is all clack's primitives use;
    // it is not a real `Writable`, but structurally sufficient for clack's calls.
    this.#stderrStream = environment.stderr as unknown as Writable;
    this.#noColor = environment.noColor?.() ?? false;
    this.#colors = pc.createColors(!this.#noColor);
  }

  result(value: unknown): void {
    this.#stdout.write(`${humanizeResult(value, this.#colors)}\n`);
  }

  progress(payload: unknown): void {
    this.#ensureIntro();
    const message = humanProgressMessage(payload);
    if (this.#spinner === undefined) {
      this.#spinner = spinner({ output: this.#stderrStream });
      this.#spinner.start(message);
    } else {
      this.#spinner.message(message);
    }
  }

  status(status: unknown): void {
    this.#stdout.write(`${renderHumanStatus(requireObject(status), this.#colors)}\n`);
  }

  info(message: string): void {
    this.#stdout.write(`${this.#noColor ? stripAnsi(message) : message}\n`);
  }

  error(message: string): void {
    log.error(message, { output: this.#stderrStream });
  }

  usage(text: string): void {
    this.#stderr.write(`${text}\n`);
  }

  leaseGranted(result: LeaseGrant, options: { readonly held: boolean }): void {
    this.#ensureIntro();
    if (this.#spinner !== undefined) {
      this.#spinner.stop(this.#colors.green("Device ready"));
      this.#spinner = undefined;
    }
    const c = this.#colors;
    note(
      [
        `${c.dim("Device:")}   ${c.bold(result.device)}`,
        `${c.dim("OS:")}       ${c.bold(result.os)}`,
        `${c.dim("Platform:")} ${c.bold(result.platform)}`,
        `${c.dim("UDID:")}     ${c.bold(result.udid)}`,
        `${c.dim("Lease:")}    ${c.bold(result.lease)}`,
      ].join("\n"),
      "Lease granted",
      { output: this.#stderrStream },
    );
    this.result(result);
    if (options.held) {
      log.info(`${c.bold("Holding lease")} — press Ctrl+C to release`, {
        output: this.#stderrStream,
      });
    } else {
      outro("Lease acquired (detached)", { output: this.#stderrStream });
    }
  }

  leaseReleased(): void {
    outro("Lease released", { output: this.#stderrStream });
  }

  list(kind: "devices" | "leases" | "rules", items: unknown): void {
    this.#stdout.write(`${renderList(kind, requireArray(items), this.#colors)}\n`);
  }

  event(payload: unknown): void {
    this.#stdout.write(`${renderEvent(payload, this.#colors)}\n`);
  }

  cleanup(actions: unknown, options: { readonly dryRun: boolean }): void {
    this.#stdout.write(`${renderCleanup(requireArray(actions), options, this.#colors)}\n`);
  }

  doctor(report: unknown, options: { readonly fix: boolean }): void {
    this.#stdout.write(`${renderDoctor(requireObject(report), options, this.#colors)}\n`);
  }

  nuke(result: unknown): void {
    this.#stdout.write(`${renderNuke(requireObject(result), this.#colors)}\n`);
  }

  daemonState(state: string, _raw: unknown): void {
    this.#stdout.write(`${renderDaemonState(state, this.#colors)}\n`);
  }

  config(value: unknown): void {
    this.#stdout.write(`${renderConfigTree(value, this.#colors)}\n`);
  }

  configSet(payload: unknown, details: { readonly key: string; readonly value: unknown }): void {
    this.#stdout.write(`${renderConfigSet(requireObject(payload), details, this.#colors)}\n`);
  }

  #ensureIntro(): void {
    if (this.#introduced) return;
    this.#introduced = true;
    intro(this.#colors.bold("pitlane"), { output: this.#stderrStream });
  }
}

const PROGRESS_LABELS: Readonly<Record<string, string>> = {
  booting: "Booting",
  provisioning: "Provisioning device",
  reclaiming: "Reclaiming capacity",
};

function humanProgressMessage(value: unknown): string {
  const progress = requireObject(value);
  if (progress.stage === "queued" && typeof progress.queuePosition === "number") {
    return `Waiting in queue (position ${progress.queuePosition})`;
  }
  const label = typeof progress.stage === "string" ? PROGRESS_LABELS[progress.stage] : undefined;
  if (label !== undefined && typeof progress.etaMs === "number") {
    return `${label} (~${Math.ceil(progress.etaMs / 1_000)}s)`;
  }
  throw new Error("Daemon returned invalid progress");
}

function humanizeResult(value: unknown, colors: ReturnType<typeof pc.createColors>): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return colors.dim("(none)");
    return value.map((item) => humanizeInline(item, colors)).join("\n");
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return colors.dim("(none)");
    return entries
      .map(
        ([key, entry]) => `${colors.dim(`${key}:`)} ${colors.bold(humanizeInline(entry, colors))}`,
      )
      .join("\n");
  }
  return String(value);
}

function humanizeInline(value: unknown, colors: ReturnType<typeof pc.createColors>): string {
  if (typeof value === "object" && value !== null) {
    return colors.dim(JSON.stringify(value));
  }
  return String(value);
}

// fallow-ignore-next-line complexity -- styled report mirrors the JSON status shape field-for-field
function renderHumanStatus(
  status: Record<string, unknown>,
  colors: ReturnType<typeof pc.createColors>,
): string {
  const devices = requireArray(status.devices);
  const leases = requireArray(status.leases);
  const queueDepth = typeof status.queueDepth === "number" ? status.queueDepth : 0;
  const capacity = requireObject(status.capacity ?? {});
  const global = requireObject(capacity.global ?? {});
  const health = typeof status.health === "string" ? status.health : "running";
  const stateColor = (state: string): ((input: string) => string) => stateColorFor(state, colors);

  const lines: string[] = [
    `${colors.dim("Daemon:")} ${stateColor(health)(health)}`,
    `${colors.dim("Capacity global:")} running ${colors.bold(String(global.running ?? 0))} + ${String(global.reserved ?? 0)} reserved/${String(global.maxRunning ?? 0)}, warm ${String(global.warm ?? 0)}${global.overLimit === true ? colors.red(" (over limit)") : ""}`,
  ];
  for (const platform of ["ios", "android"] as const) {
    const usage = requireObject(capacity[platform] ?? {});
    lines.push(
      `${colors.dim(`Capacity ${platform}:`)} managed ${String(usage.used ?? 0)}/${String(usage.limit ?? 0)}, running ${String(usage.running ?? 0)} + ${String(usage.reserved ?? 0)} reserved/${String(usage.maxRunning ?? 0)}, warm ${String(usage.warm ?? 0)}${usage.overLimit === true ? colors.red(" (over limit)") : ""}`,
    );
  }
  lines.push(colors.dim(devices.length === 0 ? "Devices: (none)" : "Devices:"));
  for (const device of devices) {
    const record = requireObject(device);
    const state = String(record.state);
    lines.push(`  ${String(record.id)} ${stateColor(state)(state)}`);
  }
  lines.push(colors.dim(leases.length === 0 ? "Leases: (none)" : "Leases:"));
  for (const lease of leases) {
    const record = requireObject(lease);
    lines.push(
      `  ${String(record.id)} ${colors.bold(String(record.requesterId))} since ${String(record.grantedAt)}`,
    );
  }
  lines.push(`${colors.dim("Queue depth:")} ${colors.bold(String(queueDepth))}`);
  return lines.join("\n");
}

function stateColorFor(
  state: string,
  colors: ReturnType<typeof pc.createColors>,
): (input: string) => string {
  if (["ready", "leased", "running"].includes(state)) return colors.green;
  if (["provisioning", "booting", "reclaiming", "queued"].includes(state)) return colors.yellow;
  if (["error", "expired", "stopped"].includes(state)) return colors.red;
  return colors.dim;
}

interface TableCell {
  readonly color?: (input: string) => string;
  readonly text: string;
}

/** Aligns columns by computing each width from its longest cell (header included); dims headers. */
function renderTable(
  headers: readonly string[],
  rows: readonly (readonly TableCell[])[],
  colors: ReturnType<typeof pc.createColors>,
): string {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]?.text.length ?? 0)),
  );
  const headerLine = headers
    .map((header, index) => colors.dim(header.padEnd(widths[index] as number)))
    .join("  ")
    .trimEnd();
  const bodyLines = rows.map((row) =>
    row
      .map((cell, index) => {
        const padded = cell.text.padEnd(widths[index] as number);
        return cell.color === undefined ? padded : cell.color(padded);
      })
      .join("  ")
      .trimEnd(),
  );
  return [headerLine, ...bodyLines].join("\n");
}

function renderList(
  kind: "devices" | "leases" | "rules",
  items: readonly unknown[],
  colors: ReturnType<typeof pc.createColors>,
): string {
  if (items.length === 0) return colors.dim(`No ${kind}`);
  if (kind === "devices") {
    const rows = items.map((item) => {
      const record = requireObject(item);
      const spec = requireObject(record.spec);
      const state = String(record.state);
      return [
        { text: String(record.id) },
        { text: String(spec.platform) },
        { text: String(spec.model) },
        { text: String(spec.osVersion) },
        { color: stateColorFor(state, colors), text: state },
      ];
    });
    return renderTable(["ID", "PLATFORM", "MODEL", "OS", "STATE"], rows, colors);
  }
  if (kind === "leases") {
    const now = Date.now();
    const rows = items.map((item) => {
      const record = requireObject(item);
      return [
        { text: String(record.id) },
        { text: String(record.requesterId) },
        { text: String(record.deviceId) },
        { text: relativeTime(Number(record.grantedAt), now) },
      ];
    });
    return renderTable(["ID", "REQUESTER", "DEVICE", "GRANTED"], rows, colors);
  }
  const rows = items.map((item) => [{ text: String(requireObject(item).name) }]);
  return renderTable(["NAME"], rows, colors);
}

/** Coarse "3m ago"-style relative time; falls back to a plain duration for future timestamps. */
function relativeTime(timestampMs: number, nowMs: number): string {
  const diff = nowMs - timestampMs;
  if (!Number.isFinite(diff) || diff < 1_000) return "just now";
  if (diff < 60_000) return `${Math.floor(diff / 1_000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

/** Relative time within the last day, otherwise a plain local clock time — for older replayed events. */
function formatEventTime(timestampMs: number, nowMs: number): string {
  const diff = nowMs - timestampMs;
  if (Number.isFinite(diff) && diff >= 0 && diff < 86_400_000)
    return relativeTime(timestampMs, nowMs);
  return new Date(timestampMs).toLocaleTimeString();
}

function eventColor(
  name: string,
  colors: ReturnType<typeof pc.createColors>,
): (input: string) => string {
  const prefix = name.split(".")[0];
  switch (prefix) {
    case "lease":
      return colors.cyan;
    case "device":
      return colors.green;
    case "cleanup":
      return colors.magenta;
    case "doctor":
      return colors.yellow;
    case "daemon":
      return colors.blue;
    case "disk":
      return colors.red;
    default:
      return colors.bold;
  }
}

function formatPayloadValue(value: unknown): string {
  if (typeof value === "object" && value !== null) return JSON.stringify(value);
  return String(value);
}

function summarizePayload(value: unknown): string {
  if (typeof value !== "object" || value === null) return value === undefined ? "" : String(value);
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.map(([key, entry]) => `${key}=${formatPayloadValue(entry)}`).join(" ");
}

function renderEvent(value: unknown, colors: ReturnType<typeof pc.createColors>): string {
  const envelope = requireObject(value);
  const name = String(envelope.event);
  const timestamp = typeof envelope.timestamp === "number" ? envelope.timestamp : Date.now();
  const time = colors.dim(formatEventTime(timestamp, Date.now()));
  const summary = summarizePayload(envelope.payload);
  const coloredName = eventColor(name, colors)(name);
  return summary === ""
    ? `${time} ${coloredName}`
    : `${time} ${coloredName} ${colors.dim(summary)}`;
}

function renderCleanup(
  actions: readonly unknown[],
  options: { readonly dryRun: boolean },
  colors: ReturnType<typeof pc.createColors>,
): string {
  if (actions.length === 0) return colors.dim("Nothing to clean up");
  const lines = actions.map((item) => {
    const proposal = requireObject(item);
    const glyph = options.dryRun ? colors.dim("→") : colors.dim("•");
    return `${glyph} ${colors.bold(String(proposal.rule))}: ${String(proposal.action)} ${String(proposal.target)} (${colors.dim(String(proposal.reason))})`;
  });
  if (!options.dryRun) {
    const noun = actions.length === 1 ? "action" : "actions";
    lines.push(
      colors.dim(`${actions.length} proposed ${noun} returned; execution outcomes unavailable`),
    );
  }
  return lines.join("\n");
}

function findingSeverity(kind: string): "problem" | "warning" {
  return kind === "orphan-device" || kind === "orphan-process" ? "warning" : "problem";
}

// fallow-ignore-next-line complexity -- one branch per DoctorFinding kind, mirrors the discriminated union
function findingMessage(finding: Record<string, unknown>): string {
  switch (finding.kind) {
    case "registry-device-missing":
      return `Registry device ${String(finding.deviceId)} (${String(finding.platform)}) is missing from the driver`;
    case "orphan-device":
      return `Orphan ${String(finding.platform)} device ${String(requireObject(finding.device).deviceId)} is not tracked in the registry`;
    case "orphan-process":
      return `Orphan ${String(finding.platform)} process for device ${String(requireObject(finding.device).deviceId)} is running outside pitlane`;
    case "expired-live-lease":
      return `Lease ${String(finding.leaseId)} on device ${String(finding.deviceId)} expired but is still held`;
    default:
      return `Unrecognized finding: ${JSON.stringify(finding)}`;
  }
}

function renderDoctor(
  report: Record<string, unknown>,
  options: { readonly fix: boolean },
  colors: ReturnType<typeof pc.createColors>,
): string {
  const findings = requireArray(report.findings);
  if (findings.length === 0) return colors.green("✓ No issues found");
  const lines = findings.map((item) => {
    const finding = requireObject(item);
    const severity = findingSeverity(String(finding.kind));
    const glyph = options.fix
      ? colors.dim("•")
      : severity === "warning"
        ? colors.yellow("!")
        : colors.red("✗");
    return `${glyph} ${findingMessage(finding)}`;
  });
  const noun = findings.length === 1 ? "finding" : "findings";
  lines.push(
    colors.dim(
      options.fix
        ? `${findings.length} ${noun} returned; correction outcomes unavailable`
        : `${findings.length} ${noun}`,
    ),
  );
  return lines.join("\n");
}

function renderNuke(
  result: Record<string, unknown>,
  colors: ReturnType<typeof pc.createColors>,
): string {
  const releasedLeaseIds = requireArray(result.releasedLeaseIds ?? []);
  const deletedDevices = requireArray(result.deletedDevices ?? []);
  const lines = [
    `${colors.green("✓")} Released ${releasedLeaseIds.length} lease${releasedLeaseIds.length === 1 ? "" : "s"}`,
  ];
  if (deletedDevices.length > 0) {
    lines.push(
      `${colors.green("✓")} Deleted ${deletedDevices.length} device${deletedDevices.length === 1 ? "" : "s"}`,
    );
  }
  return lines.join("\n");
}

function daemonStateColor(
  state: string,
  colors: ReturnType<typeof pc.createColors>,
): (input: string) => string {
  if (state === "running") return colors.green;
  if (state === "stopping") return colors.yellow;
  return colors.dim;
}

function renderDaemonState(state: string, colors: ReturnType<typeof pc.createColors>): string {
  const colorFn = daemonStateColor(state, colors);
  return `${colors.dim("Daemon")} ${colorFn("●")} ${colorFn(state)}`;
}

function renderConfigTree(
  value: unknown,
  colors: ReturnType<typeof pc.createColors>,
  indent = 0,
): string {
  const pad = "  ".repeat(indent);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return `${pad}${formatPayloadValue(value)}`;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return `${pad}${colors.dim("(none)")}`;
  return entries
    .map(([key, entry]) => {
      if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
        return `${pad}${colors.dim(`${key}:`)}\n${renderConfigTree(entry, colors, indent + 1)}`;
      }
      return `${pad}${colors.dim(`${key}:`)} ${colors.bold(formatPayloadValue(entry))}`;
    })
    .join("\n");
}

function renderConfigSet(
  payload: Record<string, unknown>,
  details: { readonly key: string; readonly value: unknown },
  colors: ReturnType<typeof pc.createColors>,
): string {
  return [
    `${colors.green("✓")} ${colors.bold(details.key)} = ${colors.bold(formatPayloadValue(details.value))}`,
    colors.dim(`takes effect on ${String(payload.effectiveAt)}`),
  ].join("\n");
}

export function requireObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Daemon returned an invalid response");
  return value as Record<string, unknown>;
}

export function requireArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Daemon returned an invalid response");
  return value;
}
