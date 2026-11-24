import type { EventMap } from "../../bus/index.js";
import { type Logger, NoopLogger, type TimerHandle } from "../../ports/index.js";
import { capacityDevices } from "../capacity/index.js";
import type { Platform, VirtualSpec } from "../domain.js";
import { type DriverSource, SeedSettleFailedError, SeedSettlerStoppedError } from "../driver.js";
import { stableError } from "../stable-error.js";
import { CHECK_INTERVAL_MS, QUIET_MS, nextSettle, type SettleCandidate } from "./policy.js";
import type {
  SeedSettleProgress,
  SeedSettleResult,
  SeedSettler,
  SeedSettlerOptions,
  SettlerDriver,
} from "./types.js";

/** why: a driver's `listSources` can walk a whole sources folder; a check that waits longer ends and the next one tries again. */
const LIST_SOURCES_BOUND_MS = 60_000;

/** why: a seed that cannot settle must not boot a device at every check (ADR 0090 §2). */
const RETRY_AFTER_FAILURE_MS = 60 * 60_000;

/** why: an operator's call waits at most this long from its arrival; the settle it started goes on (ADR 0090 §4). */
const OPERATOR_WAIT_MS = 60 * 60_000;

/** why: an operator's run that must give back its reservation and wait: the pressure came while it made the seed. */
class Requeue extends Error {}

class ListSourcesTimeout extends Error {
  constructor() {
    super("listing sources took longer than 60 s");
    this.name = "ListSourcesTimeout";
  }
}

type AbortReason = "memory-pressure" | "daemon-stopping" | "nuke";

/** why: an operator's `simlock seed` call waiting for its kind's seed to be settled. */
interface OperatorEntry {
  readonly spec: VirtualSpec;
  readonly specKey: string;
  readonly onProgress: (progress: SeedSettleProgress) => void;
  readonly resolve: (result: SeedSettleResult) => void;
  readonly reject: (error: unknown) => void;
  /** why: the kind has no fresh ready seed yet, so the run starts with a make. */
  needsMake: boolean;
  /** why: once the seed is known (listed or made), the call is matched to the settle running on it (ADR 0090). */
  sourceId?: string;
  /** why: the wait reason the caller was last told, so a repeated check does not tell it again. */
  lastWaiting?: string | undefined;
}

/** why: what one settle works on: the driver, the kind of the quick seed, and who asked. */
interface Target {
  readonly driver: SettlerDriver;
  readonly platform: Platform;
  readonly kind: Pick<VirtualSpec, "model" | "osVersion" | "imageTag">;
  readonly sourceId?: string;
  /** why: the plain leases copied from the quick seed, as its driver listed them. */
  readonly leases?: number;
  readonly operator?: OperatorEntry;
}

interface Running {
  readonly controller: AbortController;
  abortReason?: AbortReason;
  /** why: the seed the driver was called for, so a call for it joins this run and a failure delays it. */
  sourceId?: string;
  done: Promise<void>;
}

interface Held {
  release(): void;
}

export function createSeedSettler(options: SeedSettlerOptions): SeedSettler {
  return new SeedSettlerImpl(options);
}

class SeedSettlerImpl implements SeedSettler {
  readonly #logger: Logger;
  #timer: TimerHandle | undefined;
  #started = false;
  #stopped = false;
  #stopping = false;
  #holds = 0;
  #checking = false;
  #again = false;
  #underWay = 0;
  #lastReleasedAt: number | undefined;
  #running: Running | undefined;
  readonly #operators: OperatorEntry[] = [];
  readonly #failedUntil = new Map<string, number>();
  readonly #cleanups: (() => void)[] = [];

  constructor(private readonly options: SeedSettlerOptions) {
    this.#logger = options.logger?.child("seed-settler") ?? new NoopLogger();
  }

  start(): void {
    this.#started = true;
    this.#cleanups.push(
      this.options.capacity.onBootActivity((underWay) => {
        if (this.#underWay > 0 && underWay === 0) {
          this.#lastReleasedAt = this.options.clock.now();
          this.#arm(QUIET_MS);
        }
        this.#underWay = underWay;
      }),
      this.options.memoryPressure.onReading(() => {
        if (this.#pressureStep() === "new-devices-paused") this.#abort("memory-pressure");
        this.#requestCheck();
      }),
    );
    this.#arm(CHECK_INTERVAL_MS);
  }

  beginStop(): void {
    this.#stopping = true;
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    this.#stopped = true;
    for (const entry of this.#operators.splice(0)) entry.reject(new SeedSettlerStoppedError());
    if (this.#timer !== undefined) this.options.clock.cancel(this.#timer);
    for (const cleanup of this.#cleanups) cleanup();
    this.#abort("daemon-stopping");
    await this.#running?.done;
  }

  async holdWhile<Result>(work: () => Promise<Result>): Promise<Result> {
    this.#holds += 1;
    try {
      this.#abort("nuke");
      await this.#running?.done;
      return await work();
    } finally {
      this.#holds -= 1;
      if (this.#holds === 0) this.#requestCheck();
    }
  }

  settle(
    spec: VirtualSpec,
    { onProgress }: { readonly onProgress: (progress: SeedSettleProgress) => void },
  ): Promise<SeedSettleResult> {
    if (this.#stopping) return Promise.reject(new SeedSettlerStoppedError());
    return new Promise((resolve, reject) => {
      const timer = this.options.clock.setTimer(OPERATOR_WAIT_MS, () => {
        const queued = this.#operators.indexOf(entry);
        if (queued >= 0) this.#operators.splice(queued, 1);
        reject(
          new SeedSettleFailedError(
            spec.platform,
            spec.model,
            "timed-out",
            `seed ${spec.model} was not settled within 60 minutes`,
          ),
        );
      });
      const entry: OperatorEntry = {
        needsMake: true,
        onProgress,
        reject: (error) => {
          this.options.clock.cancel(timer);
          reject(error);
        },
        resolve: (result) => {
          this.options.clock.cancel(timer);
          resolve(result);
        },
        spec,
        specKey: [spec.platform, spec.model, spec.osVersion, spec.imageTag ?? ""].join("|"),
      };
      this.#admit(entry).catch((error: unknown) => {
        reject(
          new SeedSettleFailedError(
            spec.platform,
            spec.model,
            "failed",
            `seed ${spec.model} could not be settled: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      });
    });
  }

  async #admit(entry: OperatorEntry): Promise<void> {
    const driver = this.#driverOf(entry.spec.platform);
    if (driver?.ensureSeed === undefined || driver.settleSeed === undefined) {
      throw new Error(`no ${entry.spec.platform} driver settles seeds`);
    }
    const { spec } = entry;
    const found = (await this.#listBounded(driver)).find(
      (source) =>
        source.kind === "seed" &&
        source.orphan !== true &&
        source.staleReason === undefined &&
        source.model === spec.model &&
        source.osVersion === spec.osVersion &&
        (source.imageTag ?? "") === (spec.imageTag ?? ""),
    );
    if (found?.settled === true) {
      entry.resolve({
        outcome: "already-settled",
        sourceId: found.id,
        ...(found.sizeBytes === undefined ? {} : { sizeBytes: found.sizeBytes }),
      });
      return;
    }
    entry.needsMake = found === undefined;
    if (found !== undefined) entry.sourceId = found.id;
    this.#operators.push(entry);
    this.#requestCheck();
  }

  #driverOf(platform: Platform): SettlerDriver | undefined {
    return this.options.drivers.find((driver) => driver.platform === platform);
  }

  #emit<Name extends "seed.settle-started" | "seed.settle-ended">(
    name: Name,
    target: Target,
    fields: Omit<EventMap[Name], "platform" | "model" | "osVersion" | "imageTag">,
  ): void {
    const { imageTag, model, osVersion } = target.kind;
    this.options.eventBus.emit(
      name,
      {
        model,
        osVersion,
        platform: target.platform,
        ...(imageTag === undefined ? {} : { imageTag }),
        ...fields,
      } as EventMap[Name],
      "seed-settler",
    );
  }

  #pressureStep() {
    return this.options.memoryPressure.current()?.step ?? "none";
  }

  #abort(reason: AbortReason): void {
    const running = this.#running;
    if (running === undefined || running.abortReason !== undefined) return;
    running.abortReason = reason;
    running.controller.abort(reason);
  }

  #arm(delayMs: number): void {
    if (this.#stopped) return;
    if (this.#timer !== undefined) this.options.clock.cancel(this.#timer);
    this.#timer = this.options.clock.setTimer(Math.max(1, delayMs), () => {
      this.#timer = undefined;
      this.#requestCheck();
    });
  }

  #requestCheck(): void {
    if (!this.#started || this.#stopping || this.#holds > 0) return;
    if (this.#checking) {
      this.#again = true;
      return;
    }
    this.#checking = true;
    void (async () => {
      let nextDelay = CHECK_INTERVAL_MS;
      try {
        do {
          this.#again = false;
          nextDelay = await this.#check();
        } while (this.#again);
      } catch (error: unknown) {
        this.#logger.warn("a seed settle check failed", { error: stableError(error) });
      } finally {
        this.#checking = false;
        this.#arm(nextDelay);
      }
    })();
  }

  async #check(): Promise<number> {
    const gate = await this.#decide([]);
    if (gate.kind === "settle") {
      await this.#beginOperator(gate.specKey);
      return CHECK_INTERVAL_MS;
    }
    if (gate.reason === "quiet") {
      return (this.#lastReleasedAt ?? 0) + QUIET_MS - this.options.clock.now();
    }
    if (gate.reason !== "no-candidate") return CHECK_INTERVAL_MS;
    let candidates: readonly (SettleCandidate & { readonly target: Target })[];
    try {
      candidates = await this.#candidates();
    } catch (error: unknown) {
      this.#logger.warn("could not list seeds to settle", { error: stableError(error) });
      return CHECK_INTERVAL_MS;
    }
    const decision = await this.#decide(candidates);
    if (decision.kind !== "settle") return CHECK_INTERVAL_MS;
    const chosen = candidates.find(
      (candidate) =>
        candidate.platform === decision.platform && candidate.sourceId === decision.sourceId,
    );
    if (chosen !== undefined) await this.#begin(chosen.target);
    return CHECK_INTERVAL_MS;
  }

  #reportWaiting(reason: string): void {
    if (reason !== "settle-running" && reason !== "memory-pressure" && reason !== "disk-pressure") {
      return;
    }
    for (const entry of this.#operators) {
      if (entry.lastWaiting === reason) continue;
      entry.lastWaiting = reason;
      entry.onProgress({ reason, stage: "waiting" });
    }
  }

  async #beginOperator(specKey: string | undefined): Promise<void> {
    const index = this.#operators.findIndex((entry) => entry.specKey === specKey);
    const entry = this.#operators[index];
    const driver = entry === undefined ? undefined : this.#driverOf(entry.spec.platform);
    if (entry === undefined || driver === undefined) return;
    this.#operators.splice(index, 1);
    // why: a call that runs again after a wait reports its waits and its make afresh.
    entry.lastWaiting = undefined;
    const started = await this.#begin({
      driver,
      operator: entry,
      kind: entry.spec,
      platform: entry.spec.platform,
    });
    if (!started) {
      this.#operators.unshift(entry);
      entry.onProgress({ reason: "capacity", stage: "waiting" });
    }
  }

  async #decide(candidates: readonly SettleCandidate[]) {
    const diskFreeBytes = await this.options.filesystem.diskFree(this.options.diskPath ?? ".");
    const decision = nextSettle({
      candidates,
      diskFreeBytes,
      freeBytesThreshold: this.options.diskPressure.freeBytesThreshold,
      now: this.options.clock.now(),
      operator: this.#operators.map(({ sourceId, spec, specKey }) => ({
        platform: spec.platform,
        specKey,
        ...(sourceId === undefined ? {} : { sourceId }),
      })),
      pressure: this.#pressureStep(),
      running: this.#running !== undefined,
      underWay: this.#underWay,
      ...(this.#lastReleasedAt === undefined ? {} : { lastReleasedAt: this.#lastReleasedAt }),
    });
    if (decision.kind === "wait") this.#reportWaiting(decision.reason);
    return decision;
  }

  async #candidates(): Promise<readonly (SettleCandidate & { readonly target: Target })[]> {
    const lists = await Promise.all(
      this.options.drivers.map(async (driver) => {
        if (driver.settleSeed === undefined) return [];
        const sources = await this.#listBounded(driver);
        return sources.filter(isQuickSeed).map((source) => ({
          leases: source.leases ?? 0,
          platform: driver.platform,
          sourceId: source.id,
          ...this.#failure(driver.platform, source.id),
          target: {
            driver,
            kind: {
              model: source.model,
              osVersion: source.osVersion,
              ...(source.imageTag === undefined ? {} : { imageTag: source.imageTag }),
            },
            leases: source.leases ?? 0,
            platform: driver.platform,
            sourceId: source.id,
          },
        }));
      }),
    );
    return lists.flat();
  }

  #failure(platform: Platform, sourceId: string): { readonly failedUntil?: number } {
    const until = this.#failedUntil.get(`${platform}:${sourceId}`);
    return until === undefined ? {} : { failedUntil: until };
  }

  #listBounded(driver: SettlerDriver): Promise<readonly DriverSource[]> {
    return new Promise((resolve, reject) => {
      const timer = this.options.clock.setTimer(LIST_SOURCES_BOUND_MS, () =>
        reject(new ListSourcesTimeout()),
      );
      driver.listSources().then(
        (sources) => {
          this.options.clock.cancel(timer);
          resolve(sources);
        },
        (error: unknown) => {
          this.options.clock.cancel(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

  async #begin(target: Target): Promise<boolean> {
    const held = await this.options.decisions.run((): Held | undefined => {
      let releaseClaim: () => void;
      try {
        releaseClaim = this.options.components.claimProvision({
          osVersion: target.kind.osVersion,
          platform: target.platform,
        });
      } catch (error: unknown) {
        this.#logger.warn("a seed settle could not claim its runtime", {
          error: stableError(error),
        });
        return undefined;
      }
      const attempt = this.options.capacity.tryReserveProvisioning(
        { mode: "full", platform: target.platform },
        capacityDevices(this.options.registry.snapshot.virtualDevices),
      );
      if (!attempt.ok) {
        releaseClaim();
        return undefined;
      }
      return {
        release: () => {
          attempt.reservation.release();
          releaseClaim();
        },
      };
    });
    if (held === undefined) return false;
    if (this.#holds > 0 || this.#stopping) {
      held.release();
      return false;
    }
    const running: Running = { controller: new AbortController(), done: Promise.resolve() };
    this.#running = running;
    running.done = this.#execute(target, running, held);
    return true;
  }

  async #execute(target: Target, running: Running, held: Held): Promise<void> {
    try {
      const chosen = await this.#choose(target, running);
      if (chosen !== undefined) await this.#settle(target, running, chosen);
    } catch (error: unknown) {
      this.#ended(target, running, error);
    } finally {
      held.release();
      this.#running = undefined;
      this.#requestCheck();
    }
  }

  /** why: an operator's call makes the seed first; it answers at once for a seed already settled and requeues when pressure appeared during the make. */
  async #choose(
    target: Target,
    running: Running,
  ): Promise<{ readonly sourceId: string; readonly leases: number } | undefined> {
    const { driver, operator } = target;
    if (operator === undefined) {
      if (target.sourceId === undefined || driver.settleSeed === undefined) return undefined;
      return { leases: target.leases ?? 0, sourceId: target.sourceId };
    }
    return this.#ensure(target, running, operator);
  }

  async #ensure(
    target: Target,
    running: Running,
    operator: OperatorEntry,
  ): Promise<{ readonly sourceId: string; readonly leases: number } | undefined> {
    if (operator.needsMake) operator.onProgress({ stage: "making" });
    const ensured = await target.driver.ensureSeed?.(operator.spec);
    if (ensured === undefined) throw new Error("the driver cannot make a seed");
    if (ensured.settled) {
      operator.resolve({
        outcome: "already-settled",
        sourceId: ensured.sourceId,
        ...(ensured.sizeBytes === undefined ? {} : { sizeBytes: ensured.sizeBytes }),
      });
      return undefined;
    }
    operator.needsMake = false;
    operator.sourceId = ensured.sourceId;
    if (running.abortReason !== undefined || this.#pressureStep() !== "none") {
      throw new Requeue();
    }
    operator.onProgress({ stage: "settling" });
    return { leases: ensured.leases, sourceId: ensured.sourceId };
  }

  async #settle(
    target: Target,
    running: Running,
    chosen: { readonly sourceId: string; readonly leases: number },
  ): Promise<void> {
    const { driver, operator } = target;
    const { leases, sourceId } = chosen;
    if (driver.settleSeed === undefined) return;
    const startedAt = this.options.clock.now();
    running.sourceId = sourceId;
    this.#emit("seed.settle-started", target, {
      leases,
      sourceId,
      trigger: operator === undefined ? "background" : "operator",
    });
    let result;
    try {
      result = await driver.settleSeed(sourceId, { signal: running.controller.signal });
    } catch (error: unknown) {
      const ended =
        running.abortReason === undefined
          ? { message: errorText(error).slice(0, 500), outcome: "failed" as const }
          : { outcome: "aborted" as const, reason: running.abortReason };
      this.#emit("seed.settle-ended", target, {
        durationMs: this.options.clock.now() - startedAt,
        sourceId,
        ...ended,
      });
      throw error;
    }
    this.#emit("seed.settle-ended", target, {
      durationMs: this.options.clock.now() - startedAt,
      newSourceId: result.sourceId,
      outcome: result.reason === "cap" ? "cap" : "settled",
      sourceId,
      ...(result.sizeBytes === undefined ? {} : { sizeBytes: result.sizeBytes }),
    });
    const answer: SeedSettleResult = {
      outcome: "settled",
      settledAfterMs: result.settledAfterMs,
      sourceId: result.sourceId,
      ...(result.sizeBytes === undefined ? {} : { sizeBytes: result.sizeBytes }),
    };
    operator?.resolve(answer);
    for (const joined of this.#joined(running, operator)) joined.resolve(answer);
  }

  /** why: a call for the kind that settles, or for the seed that settles, takes this run's answer instead of starting another (ADR 0090). */
  #joined(running: Running, operator: OperatorEntry | undefined): OperatorEntry[] {
    const joined = this.#operators.filter(
      (entry) =>
        (running.sourceId !== undefined && entry.sourceId === running.sourceId) ||
        (operator !== undefined && entry.specKey === operator.specKey),
    );
    for (const entry of joined) this.#operators.splice(this.#operators.indexOf(entry), 1);
    return joined;
  }

  /** why: an abort or a requeue is no failure and sets no delay; a stop refuses the operator; anything else is logged and waits an hour. */
  #ended(target: Target, running: Running, error: unknown): void {
    const { operator } = target;
    if (running.abortReason === "daemon-stopping") {
      operator?.reject(new SeedSettlerStoppedError());
      return;
    }
    if (running.abortReason !== undefined || error instanceof Requeue) {
      if (operator !== undefined) this.#operators.unshift(operator);
      return;
    }
    this.#failed(target, running, error);
  }

  #failed(target: Target, running: Running, error: unknown): void {
    const { operator } = target;
    this.#logger.warn("a seed settle failed", {
      message: errorText(error),
      model: target.kind.model,
      osVersion: target.kind.osVersion,
      platform: target.platform,
      ...(target.kind.imageTag === undefined ? {} : { imageTag: target.kind.imageTag }),
    });
    const sourceId = target.sourceId ?? running.sourceId;
    if (sourceId !== undefined) {
      this.#failedUntil.set(
        `${target.platform}:${sourceId}`,
        this.options.clock.now() + RETRY_AFTER_FAILURE_MS,
      );
    }
    const callers = operator === undefined ? [] : [operator];
    for (const entry of [...callers, ...this.#joined(running, operator)]) {
      entry.reject(
        new SeedSettleFailedError(
          target.platform,
          entry.spec.model,
          "failed",
          `seed ${entry.spec.model} could not be settled: ${errorText(error)}`,
        ),
      );
    }
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isQuickSeed(source: DriverSource): boolean {
  return (
    source.kind === "seed" &&
    source.settled !== true &&
    source.orphan !== true &&
    source.staleReason === undefined &&
    (source.leases ?? 0) > 0
  );
}
