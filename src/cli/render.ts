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
    this.#stdout.write(`${message}\n`);
  }

  error(message: string): void {
    this.#stderr.write(`${message}\n`);
  }

  usage(text: string): void {
    this.#stderr.write(`${text}\n`);
  }

  leaseGranted(result: LeaseGrant): void {
    this.result(result);
  }

  leaseReleased(): void {
    // Legacy contract: held-mode release after a signal prints nothing on the JSON path.
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
  readonly #stderr: RendererOutput;
  readonly #stderrStream: Writable;
  readonly #stdout: RendererOutput;
  #introduced = false;
  #spinner: SpinnerResult | undefined;

  constructor(environment: { readonly stderr: RendererOutput; readonly stdout: RendererOutput }) {
    this.#stdout = environment.stdout;
    this.#stderr = environment.stderr;
    // `RendererOutput` only requires `write`, which is all clack's primitives use;
    // it is not a real `Writable`, but structurally sufficient for clack's calls.
    this.#stderrStream = environment.stderr as unknown as Writable;
    this.#colors = pc.createColors(!isNoColorSet());
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
    this.#stdout.write(`${message}\n`);
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

  #ensureIntro(): void {
    if (this.#introduced) return;
    this.#introduced = true;
    intro(this.#colors.bold("pitlane"), { output: this.#stderrStream });
  }
}

function isNoColorSet(): boolean {
  return Boolean(process.env.NO_COLOR);
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

export function requireObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Daemon returned an invalid response");
  return value as Record<string, unknown>;
}

export function requireArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Daemon returned an invalid response");
  return value;
}
