/**
 * All user-facing CLI output flows through a `Renderer`. Command handlers
 * never call `stdout`/`stderr` directly — they call semantic methods here,
 * and the renderer decides the bytes. `JsonRenderer` reproduces today's
 * output exactly; a `HumanRenderer` (clack-based) lands in a later change.
 */

interface RendererOutput {
  write(value: string): unknown;
}

export interface Renderer {
  /** A command result, printed as one JSON line on stdout. */
  result(value: unknown): void;
  /** A lease-progress event pushed from the daemon while waiting, on stderr. */
  progress(payload: unknown): void;
  /** The full status report, in its non-JSON (plain text) presentation. */
  status(status: unknown): void;
  /** A plain informational line on stdout (daemon state, confirmations, usage). */
  info(message: string): void;
  /** A plain error line on stderr. */
  error(message: string): void;
  /** Command usage text on stderr, shown alongside an error. */
  usage(text: string): void;
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

  status(status: unknown): void {
    this.#stdout.write(`${formatStatus(requireObject(status))}\n`);
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

// fallow-ignore-next-line complexity -- moved verbatim from cli/index.ts (pure code motion, same complexity as before)
function formatStatus(status: Record<string, unknown>): string {
  const devices = requireArray(status.devices);
  const leases = requireArray(status.leases);
  const queueDepth = typeof status.queueDepth === "number" ? status.queueDepth : 0;
  const capacity = requireObject(status.capacity ?? {});
  const global = requireObject(capacity.global ?? {});
  const globalLine = `Running global: ${String(global.running ?? 0)} + ${String(global.reserved ?? 0)} reserved/${String(global.maxRunning ?? 0)}, warm ${String(global.warm ?? 0)}${global.overLimit === true ? " (over limit)" : ""}`;
  const capacityLines = ["ios", "android"].map((platform) => {
    const usage = requireObject(capacity[platform] ?? {});
    return `Capacity ${platform}: managed ${String(usage.used ?? 0)}/${String(usage.limit ?? 0)}, running ${String(usage.running ?? 0)} + ${String(usage.reserved ?? 0)} reserved/${String(usage.maxRunning ?? 0)}, warm ${String(usage.warm ?? 0)}${usage.overLimit === true ? " (over limit)" : ""}`;
  });
  const deviceLines = devices.map((device) => {
    const record = requireObject(device);
    return `Device ${String(record.id)}: ${String(record.state)}`;
  });
  const leaseLines = leases.map((lease) => {
    const record = requireObject(lease);
    return `Lease ${String(record.id)}: ${String(record.requesterId)} since ${String(record.grantedAt)}`;
  });
  return [
    `Daemon: ${typeof status.health === "string" ? status.health : "running"}`,
    globalLine,
    ...capacityLines,
    ...deviceLines,
    ...leaseLines,
    `Queue depth: ${queueDepth}`,
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
