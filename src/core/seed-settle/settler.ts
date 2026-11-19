import { type Logger, NoopLogger, type TimerHandle } from "../../ports/index.js";
import { capacityDevices } from "../capacity/index.js";
import { stableError } from "../stable-error.js";
import type { Driver, DriverSource } from "../driver.js";
import { CHECK_INTERVAL_MS, QUIET_MS, nextSettle, type SettleCandidate } from "./policy.js";
import type { SeedSettler, SeedSettlerOptions, SettlerDriver } from "./types.js";

/** why: a driver's `listSources` can walk a whole sources folder; a check that waits longer ends and the next one tries again. */
const LIST_SOURCES_BOUND_MS = 60_000;

/** why: a candidate remembers the driver that listed it, so the settle calls that driver. */
interface Chosen extends SettleCandidate {
  readonly driver: SettlerDriver & Pick<Required<Driver>, "settleSeed">;
}

class ListSourcesTimeout extends Error {
  constructor() {
    super("listing sources took longer than 60 s");
    this.name = "ListSourcesTimeout";
  }
}

export function createSeedSettler(options: SeedSettlerOptions): SeedSettler {
  return new SeedSettlerImpl(options);
}

class SeedSettlerImpl implements SeedSettler {
  readonly #logger: Logger;
  #timer: TimerHandle | undefined;
  #started = false;
  #checking = false;
  #again = false;
  #underWay = 0;
  #lastReleasedAt: number | undefined;
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
      this.options.memoryPressure.onReading(() => this.#requestCheck()),
    );
    this.#arm(CHECK_INTERVAL_MS);
  }

  beginStop(): void {}

  async stop(): Promise<void> {}

  holdWhile<Result>(work: () => Promise<Result>): Promise<Result> {
    return work();
  }

  settle(): never {
    throw new Error("not built");
  }

  #arm(delayMs: number): void {
    if (this.#timer !== undefined) this.options.clock.cancel(this.#timer);
    this.#timer = this.options.clock.setTimer(Math.max(1, delayMs), () => {
      this.#timer = undefined;
      this.#requestCheck();
    });
  }

  #requestCheck(): void {
    if (!this.#started) return;
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
    if (gate.kind === "wait" && gate.reason === "quiet") {
      return (this.#lastReleasedAt ?? 0) + QUIET_MS - this.options.clock.now();
    }
    if (gate.kind === "wait" && gate.reason !== "no-candidate") return CHECK_INTERVAL_MS;
    let candidates: readonly Chosen[];
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
    if (chosen !== undefined) await this.#begin(chosen);
    return CHECK_INTERVAL_MS;
  }

  async #decide(candidates: readonly SettleCandidate[]) {
    const diskFreeBytes = await this.options.filesystem.diskFree(this.options.diskPath ?? ".");
    return nextSettle({
      candidates,
      diskFreeBytes,
      freeBytesThreshold: this.options.diskPressure.freeBytesThreshold,
      operator: [],
      running: false,
      now: this.options.clock.now(),
      pressure: this.options.memoryPressure.current()?.step ?? "none",
      underWay: this.#underWay,
      ...(this.#lastReleasedAt === undefined ? {} : { lastReleasedAt: this.#lastReleasedAt }),
    });
  }

  async #candidates(): Promise<readonly Chosen[]> {
    const lists = await Promise.all(
      this.options.drivers.map(async (driver): Promise<readonly Chosen[]> => {
        const { settleSeed } = driver;
        if (settleSeed === undefined) return [];
        const sources = await this.#listBounded(driver);
        return sources.filter(isQuickSeed).map((source) => ({
          driver: { ...driver, settleSeed: settleSeed.bind(driver) },
          leases: source.leases ?? 0,
          platform: driver.platform,
          sourceId: source.id,
        }));
      }),
    );
    return lists.flat();
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

  async #begin(chosen: Chosen): Promise<void> {
    const reserved = await this.options.decisions.run(() => {
      return this.options.capacity.tryReserveProvisioning(
        { mode: "full", platform: chosen.platform },
        capacityDevices(this.options.registry.snapshot.virtualDevices),
      );
    });
    if (!reserved.ok) return;
    try {
      await chosen.driver.settleSeed(chosen.sourceId, { signal: new AbortController().signal });
    } catch (error: unknown) {
      this.#logger.warn("a seed settle failed", { error: stableError(error) });
    } finally {
      reserved.reservation.release();
    }
  }
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
