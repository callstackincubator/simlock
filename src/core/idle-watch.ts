import type { ProcessEntry } from "../ports/index.js";

export interface IdleWatchOptions {
  /** why: finds the tree's root in a process table read; the driver knows which process that is. */
  readonly root: (processes: readonly ProcessEntry[]) => ProcessEntry | undefined;
  /** why: the CPU, in cores, under which the tree counts as quiet. */
  readonly idleCores: number;
  /** why: when the booted tree became ready; both waits count from here. */
  readonly readyAt: number;
  readonly windowMs?: number;
  readonly minAfterReadyMs?: number;
  readonly capAfterReadyMs?: number;
}

export type IdleState = "busy" | "idle" | "cap";

interface Sample {
  readonly at: number;
  readonly cpuSeconds: number;
}

const WINDOW_MS = 120_000;
const MIN_AFTER_READY_MS = 180_000;
const CAP_AFTER_READY_MS = 900_000;

/**
 * why: a booted tree is settled once it has stopped working, not after a fixed wait. Cumulative CPU
 * of the root and its descendants, read from the process table, tells when: the cores it used over
 * the last window are the CPU it added divided by the time. A process that exits keeps the largest
 * time read for it, so its work never subtracts.
 */
export class IdleWatch {
  readonly #windowMs: number;
  readonly #minAfterReadyMs: number;
  readonly #capAfterReadyMs: number;
  readonly #peak = new Map<number, number>();
  #samples: Sample[] = [];
  #rootFound = false;

  constructor(private readonly options: IdleWatchOptions) {
    this.#windowMs = options.windowMs ?? WINDOW_MS;
    this.#minAfterReadyMs = options.minAfterReadyMs ?? MIN_AFTER_READY_MS;
    this.#capAfterReadyMs = options.capAfterReadyMs ?? CAP_AFTER_READY_MS;
  }

  observe(processes: readonly ProcessEntry[], now: number): void {
    const root = this.options.root(processes);
    this.#rootFound = root !== undefined;
    if (root === undefined) return;
    for (const entry of descendants(root, processes)) {
      this.#peak.set(entry.pid, Math.max(this.#peak.get(entry.pid) ?? 0, entry.cpuSeconds));
    }
    let cpuSeconds = 0;
    for (const peak of this.#peak.values()) cpuSeconds += peak;
    this.#samples.push({ at: now, cpuSeconds });
    // why: keep the newest sample at or before the window's start, the baseline, and everything after it.
    const start = now - this.#windowMs;
    const baseline = this.#samples.findLastIndex((sample) => sample.at <= start);
    if (baseline > 0) this.#samples = this.#samples.slice(baseline);
  }

  state(now: number): IdleState {
    const sinceReady = now - this.options.readyAt;
    if (sinceReady >= this.#capAfterReadyMs) return "cap";
    if (sinceReady < this.#minAfterReadyMs || !this.#rootFound) return "busy";
    const latest = this.#samples.at(-1);
    if (latest === undefined || latest.at <= now - this.#windowMs) return "busy";
    const baseline = this.#samples.findLast((sample) => sample.at <= latest.at - this.#windowMs);
    if (baseline === undefined) return "busy";
    const cores = (latest.cpuSeconds - baseline.cpuSeconds) / ((latest.at - baseline.at) / 1_000);
    return cores < this.options.idleCores ? "idle" : "busy";
  }
}

function descendants(root: ProcessEntry, processes: readonly ProcessEntry[]): ProcessEntry[] {
  const found = new Map<number, ProcessEntry>([[root.pid, root]]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const entry of processes) {
      if (!found.has(entry.pid) && found.has(entry.ppid)) {
        found.set(entry.pid, entry);
        grew = true;
      }
    }
  }
  return [...found.values()];
}
