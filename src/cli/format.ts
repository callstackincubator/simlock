// why: only command modules import this -- the router never does, so `--help` and a usage
// error never load the human renderers.
import type { StatusGetOutput, WorkerView } from "../admin/index.js";
import type { ServiceManagerName, ServiceState } from "../ports/index.js";

export function formatWorkers(
  workers: WorkerView[],
  options: { readonly installs?: boolean; readonly now: number },
): string {
  if (workers.length === 0) return "No workers have connected to this gateway.";
  const { installs: showInstalls, now } = options;
  return workers
    .map((worker) => {
      const installs =
        showInstalls === true
          ? (worker.installs ?? []).map((install) => `\n  ${formatInstall(install, now)}`).join("")
          : "";
      const load = workerLoadLine(worker, now);
      const label = worker.label === undefined ? worker.id : `${worker.id} (${worker.label})`;
      const state = workerState(worker);
      const capacity =
        worker.capacity === undefined
          ? "capacity unknown"
          : `ios ${worker.capacity.ios.running}/${worker.capacity.ios.limit}, ` +
            `android ${worker.capacity.android.running}/${worker.capacity.android.limit}`;
      const skew =
        worker.protocol === undefined
          ? ""
          : ` protocol ${worker.protocol.worker.min}-${worker.protocol.worker.max}` +
            ` vs gateway ${worker.protocol.gateway.min}-${worker.protocol.gateway.max}`;
      const host = worker.host === undefined ? "" : ` -- ${formatHost(worker.host)}`;
      const capabilities = (worker.capabilities ?? [])
        .map((entry) =>
          entry.state === "unavailable"
            ? ` -- ${entry.name} unavailable: ${entry.reason ?? "unknown"}`
            : ` -- ${entry.name} ${entry.state}`,
        )
        .join("");
      return `${label}: ${state} -- ${capacity}, ${leaseCount(worker)}${skew}${host}${capabilities}${load}${installs}`;
    })
    .join("\n");
}

function workerLoadLine(worker: WorkerView, now: number): string {
  if (worker.connection === "disconnected") return "\n  Load: no reading while disconnected";
  if (worker.load === undefined) return "";
  const { readAt, ...parts } = worker.load;
  return `\n  ${formatLoadLine(parts, Math.ceil(Math.max(0, now - readAt) / 1000))}`;
}

function workerState(worker: WorkerView): string {
  return [
    worker.connection,
    ...(worker.health === "starting" ? ["starting"] : []),
    ...(worker.drained ? ["drained"] : []),
  ].join(", ");
}

function leaseCount(worker: WorkerView): string {
  if (worker.leases === undefined) return "leases unknown";
  return `${String(worker.leases.length)} lease(s)`;
}

function formatInstall(
  install: NonNullable<StatusGetOutput["installs"]>[number],
  now: number,
): string {
  const where = install.workerId === undefined ? "" : ` on ${install.workerId}`;
  const ageSeconds = Math.max(0, Math.round((now - install.since) / 1000));
  const waiters = `${String(install.waiters)} waiter${install.waiters === 1 ? "" : "s"}`;
  return `Install ${install.platform} ${install.component}${where}: ${install.state} for ${String(ageSeconds)}s, ${waiters}`;
}

function formatGibibytes(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

function formatHost(host: StatusGetOutput["host"]): string {
  const system = `${host.os} ${host.osVersion} ${host.arch}`;
  const tools = host.tools.map(
    (tool) => `${tool.name} ${tool.version}${tool.build === undefined ? "" : ` (${tool.build})`}`,
  );
  return tools.length === 0 ? system : `${system}; ${tools.join(", ")}`;
}

function roundHalfUp(value: number, decimals: number): number {
  const scale = 10 ** decimals;
  return Math.floor(value * scale + 0.5) / scale;
}

function formatLoadBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const mebibytes = Math.floor(bytes / 2 ** 20 + 0.5);
  if (mebibytes < 1024) return `${mebibytes} MiB`;
  return `${roundHalfUp(bytes / 2 ** 30, 1).toFixed(1)} GiB`;
}

function formatLoadCores(cores: number): string {
  if (cores < 0.005) return "<0.01";
  return String(roundHalfUp(cores, cores < 0.1 ? 2 : 1));
}

function formatLoadLine(
  load: Pick<NonNullable<StatusGetOutput["load"]>, "cpu" | "disk" | "memory">,
  ageSeconds: number,
): string {
  const { cpu, disk, memory } = load;
  const unread = (text: string): string[] => [text];
  const cpuPart =
    cpu === undefined
      ? unread("CPU unavailable")
      : [
          `CPU ${roundHalfUp(cpu.busyPercent, 0)}% busy (${formatLoadCores(cpu.cores)} ${
            cpu.cores === 1 ? "core" : "cores"
          }${cpu.limited ? ", limit" : ""})`,
        ];
  const memoryParts =
    memory === undefined
      ? unread("memory unavailable")
      : [
          `memory ${formatLoadBytes(memory.availableBytes)} of ${formatLoadBytes(memory.totalBytes)} available${memory.limited ? " (limit)" : ""}`,
          `swap ${formatLoadBytes(memory.swapUsedBytes)} used`,
          ...(memory.pressure === undefined ? [] : [`pressure ${memory.pressure}`]),
        ];
  const diskPart =
    disk === undefined
      ? unread("disk unavailable")
      : [`disk ${formatLoadBytes(disk.freeBytes)} of ${formatLoadBytes(disk.totalBytes)} free`];
  const age = `read ${String(ageSeconds)}s ago`;
  return `Load: ${[...cpuPart, ...memoryParts, ...diskPart, age].join(" · ")}`;
}

function loadLines(status: StatusGetOutput): string[] {
  return status.load === undefined
    ? []
    : [formatLoadLine(status.load, Math.ceil(status.load.ageMs / 1000))];
}

function historyLines(history: StatusGetOutput["history"]): string[] {
  if (history === undefined) return [];
  const lines: string[] = [];
  if (!history.writing) {
    lines.push("History: the event history is not being written; see daemon.log.");
  }
  if (history.setAsideAt !== undefined) {
    lines.push(
      `History: the event history was damaged and set aside at ${formatLocalMinute(history.setAsideAt)}; a fresh one was started.`,
    );
  }
  if (history.rebuiltAt !== undefined) {
    lines.push(
      `History: figures were rebuilt from the event history at ${formatLocalMinute(history.rebuiltAt)}.`,
    );
  }
  if (history.rebuildFailed === true) {
    lines.push("History: figures could not be rebuilt; see daemon.log.");
  }
  return lines;
}

function formatLocalMinute(epochMs: number): string {
  const at = new Date(epochMs);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

export function consoleLines(daemon: StatusGetOutput["daemon"]): string[] {
  return daemon.consoleUrl === undefined ? [] : [`Console: ${daemon.consoleUrl}`];
}

/** why: the role's service as `daemon status --json` prints it, and `serviceLine` renders it. */
export type ServiceReport = ServiceState & {
  readonly manager: ServiceManagerName;
  readonly name: string;
};

export function serviceLine(service: ServiceReport): string {
  if (service.state === "not-installed") return "Service: not installed";
  const who = `(${service.manager}, ${service.name})`;
  if (service.state === "broken") {
    const verb = service.missing.length === 1 ? "is" : "are";
    return `Service: broken ${who}: ${service.missing.join(", ")} ${verb} gone; run simlock daemon install`;
  }
  if (service.state === "installed") return `Service: installed ${who}`;
  return `Service: not loaded ${who}: commands start the daemon without it`;
}

function daemonLines(daemon: StatusGetOutput["daemon"]): string[] {
  const { update, lastUpdateFailure } = daemon;
  return [
    `Daemon: ${daemon.health} (${daemon.mode})`,
    `Simlock: ${daemon.version}`,
    ...(update === null
      ? []
      : [
          `Updating to ${update.to}: ${
            update.stage === "waiting"
              ? `waiting for ${update.leases} ${update.leases === 1 ? "lease" : "leases"}`
              : update.stage
          }`,
        ]),
    ...(lastUpdateFailure === null
      ? []
      : [`Last update failed (${lastUpdateFailure.stage}): ${lastUpdateFailure.message}`]),
    ...consoleLines(daemon),
  ];
}

// fallow-ignore-next-line complexity -- stable human status rendering is intentionally a single formatter.
export function formatStatus(status: StatusGetOutput, now: number): string {
  const { capacity, daemon, devices, host, installs, leases, queueDepth, workers } = status;
  if (
    capacity === undefined ||
    devices === undefined ||
    leases === undefined ||
    queueDepth === undefined
  ) {
    return [
      ...daemonLines(daemon),
      `Host: ${formatHost(host)}`,
      ...loadLines(status),
      "Devices, leases and capacity appear once startup finishes.",
    ].join("\n");
  }
  const globalLine = `Running global: ${capacity.global.running} + ${capacity.global.reserved} reserved/${capacity.global.maxRunning}, warm ${capacity.global.warm}${capacity.global.overLimit ? " (over limit)" : ""}`;
  const capacityLines = (["ios", "android"] as const).map((platform) => {
    const usage = capacity[platform];
    return `Capacity ${platform}: managed ${usage.used}/${usage.limit}, running ${usage.running} + ${usage.reserved} reserved/${usage.maxRunning}, warm ${usage.warm}${usage.overLimit ? " (over limit)" : ""}${usage.atRamBudget ? " (at RAM budget)" : ""}`;
  });
  const ramBudget = capacity.ramBudget;
  const ramLines =
    ramBudget === undefined
      ? []
      : [
          `RAM budget: ${formatGibibytes(ramBudget.usedBytes)}/${formatGibibytes(ramBudget.limitBytes)} used${ramBudget.overLimit ? " (over limit)" : ""}`,
        ];
  const workerLines =
    workers === undefined
      ? []
      : [formatWorkers(workers, { now }), ""].filter((line) => line !== "");
  const warmPoolLines =
    status.warmPool === undefined || daemon.mode === "gateway"
      ? []
      : formatWarmPool(status.warmPool);
  const deviceLines = devices.map((device) => {
    const markers = [
      device.foreignStateDetectedAt === undefined ? undefined : "foreign state change",
      device.foreignProvenanceDetectedAt === undefined ? undefined : "foreign provenance change",
      device.state === "quarantined" ? quarantineMarker(device) : undefined,
      device.transitionAgeMs === undefined
        ? undefined
        : `mid-transition ${device.transitionAgeMs}ms`,
      device.stalled === true ? "stalled" : undefined,
    ].filter((marker) => marker !== undefined);
    const suffix = markers.length === 0 ? "" : ` (${markers.join(", ")})`;
    const where = device.workerId === undefined ? "" : ` on ${device.workerId}`;
    return `Device ${device.id}${where}: ${stateLabel(device)}, ${deviceKind(device)}${suffix}`;
  });
  const leaseLines = leases.map(
    (lease) =>
      `Lease ${lease.id}: ${lease.requesterId}${lease.workerId === undefined ? "" : ` on ${lease.workerId}`} since ${lease.grantedAt}, last renewed ${lease.lastRenewedAt}`,
  );
  return [
    ...daemonLines(daemon),
    `Host: ${formatHost(host)}`,
    ...loadLines(status),
    ...historyLines(status.history),
    globalLine,
    ...capacityLines,
    ...ramLines,
    ...warmPoolLines,
    ...workerLines,
    ...deviceLines,
    ...leaseLines,
    ...(installs ?? []).map((install) => formatInstall(install, now)),
    `Queue depth: ${queueDepth}`,
  ].join("\n");
}

function stateLabel(device: NonNullable<StatusGetOutput["devices"]>[number]): string {
  return device.state === "absent" && device.absentReason !== undefined
    ? `absent (${device.absentReason})`
    : device.state;
}

function deviceKind(device: NonNullable<StatusGetOutput["devices"]>[number]): string {
  if (device.physical) return `physical ${String(device.class)}`;
  return `mode ${String(device.mode)}, serves default mode: ${device.servesDefaultMode ? "yes" : "no"}`;
}

function formatWarmPool(warmPool: NonNullable<StatusGetOutput["warmPool"]>): string[] {
  const { enabled, reserveRunning, targets } = warmPool;
  return [
    `warm pool: ${enabled ? "enabled" : "disabled"}, reserve ios ${reserveRunning.ios} android ${reserveRunning.android}`,
    ...targets.map((target) => {
      const name = [target.model, target.osVersion, target.mode, target.imageTag]
        .filter((part) => part !== undefined)
        .join(" / ");
      const short = target.short === undefined ? "" : `  short: ${target.short}`;
      return `  ${name}   ${target.origin}   wanted ${target.count}  ready ${target.ready}  booting ${target.booting}${short}`;
    }),
  ];
}

function quarantineMarker(device: NonNullable<StatusGetOutput["devices"]>[number]): string {
  const attempts = device.quarantineAttempts ?? 0;
  const nextRetryAt =
    device.quarantineNextRetryAt === undefined
      ? ""
      : `, next retry at ${device.quarantineNextRetryAt}`;
  const cause = device.quarantineCause;
  return `purge retry ${attempts}${nextRetryAt}${cause === undefined ? "" : `; ${quarantineCauseText(cause)}`}`;
}

function quarantineCauseText(cause: {
  readonly kind: "purge-failed" | "shutdown-failed" | "delete-failed" | "stalled";
  readonly stalledState?: string | undefined;
  readonly message?: string | undefined;
}): string {
  if (cause.kind === "stalled") return `stalled while ${cause.stalledState ?? ""}`;
  const text = cause.kind.replace("-", " ");
  return cause.message === undefined ? text : `${text}: ${cause.message}`;
}
