/**
 * ADR 0008 §5-§7: what `status.get` reports about the machine. The operating system comes from
 * the host port, read once by the composition root; tool versions come from each driver. This
 * module joins the two and names no tool (architecture rule 1).
 *
 * `status.get` is the gateway's liveness probe, so it never waits here: facts are served from
 * memory, and a re-read starts in the background once they are older than `HOST_FACTS_MAX_AGE_MS`.
 * Nothing here enforces `status.get`'s size bounds; the contract's `fitHostFacts` does, where the
 * daemon serves these.
 */
import type { Clock, HostSystem, Logger } from "../ports/index.js";
import { NoopLogger } from "../ports/index.js";
import type { Driver, DriverToolVersion } from "./driver.js";
import type { Platform } from "./domain.js";

/** Fixed, not configured (ADR 0008 §9): tool versions change only when someone installs one. */
export const HOST_FACTS_MAX_AGE_MS = 60_000;

/**
 * The core's own bound on one driver's read (architecture rule 11). A driver bounds the
 * processes it starts; this covers one that never settles anyway, which would otherwise hold
 * the single in-flight read open and stop every other driver from being re-read. A read that
 * runs out is a failed read: that driver keeps what it reported last.
 */
const TOOL_READ_TIMEOUT_MS = 30_000;

export interface HostToolVersion extends DriverToolVersion {
  readonly platform: Platform;
}

export interface HostFacts extends HostSystem {
  readonly tools: readonly HostToolVersion[];
}

export interface HostFactsReaderOptions {
  readonly clock: Clock;
  readonly drivers: readonly Pick<Driver, "platform" | "toolVersions">[];
  readonly logger?: Logger;
  readonly system: HostSystem;
}

export class HostFactsReader {
  readonly #clock: Clock;
  readonly #drivers: HostFactsReaderOptions["drivers"];
  readonly #logger: Logger;
  readonly #system: HostSystem;
  /** Each driver's last successful answer, so one driver's failed read keeps its own tools. */
  readonly #toolsByDriver = new Map<number, readonly HostToolVersion[]>();
  /** When the last read finished; undefined until the first one does. */
  #readAt: number | undefined;
  #inFlight: Promise<void> | undefined;

  constructor(options: HostFactsReaderOptions) {
    this.#clock = options.clock;
    this.#drivers = options.drivers;
    this.#logger = options.logger ?? new NoopLogger();
    this.#system = options.system;
  }

  /**
   * The facts as last read. Starts a background re-read when there is none yet or they are
   * older than the maximum age; this call itself never waits for it.
   */
  current(): HostFacts {
    if (this.#readAt === undefined || this.#clock.now() - this.#readAt >= HOST_FACTS_MAX_AGE_MS) {
      void this.refresh();
    }
    return {
      ...this.#system,
      tools: [...this.#toolsByDriver.keys()]
        .sort((left, right) => left - right)
        .flatMap((index) => this.#toolsByDriver.get(index) ?? []),
    };
  }

  /** Reads every driver's tool versions. Single-flight: a call during a read joins it. */
  refresh(): Promise<void> {
    this.#inFlight ??= this.#read().finally(() => {
      this.#inFlight = undefined;
    });
    return this.#inFlight;
  }

  async #read(): Promise<void> {
    await Promise.all(
      this.#drivers.map(async (driver, index) => {
        if (driver.toolVersions === undefined) return;
        try {
          const tools = await this.#bounded(driver.toolVersions());
          this.#toolsByDriver.set(
            index,
            tools.map((tool) => ({ ...tool, platform: driver.platform })),
          );
        } catch (error: unknown) {
          // A failed read, which a driver reports by rejecting: keep the tools it reported last,
          // so a passing failure does not blank the host's status (architecture rule 12).
          this.#logger.warn("Tool version read failed", {
            platform: driver.platform,
            reason: error instanceof Error ? error.message : "unknown",
          });
        }
      }),
    );
    this.#readAt = this.#clock.now();
  }

  /** Rejects once `TOOL_READ_TIMEOUT_MS` passes; the timer is cancelled when `read` settles. */
  #bounded<Value>(read: Promise<Value>): Promise<Value> {
    return new Promise<Value>((resolve, reject) => {
      const timer = this.#clock.setTimer(TOOL_READ_TIMEOUT_MS, () => {
        reject(new Error(`Tool version read did not finish within ${TOOL_READ_TIMEOUT_MS} ms`));
      });
      read.then(
        (value) => {
          this.#clock.cancel(timer);
          resolve(value);
        },
        (error: unknown) => {
          this.#clock.cancel(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }
}
