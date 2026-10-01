/**
 * ADR 0008 §5-§7: what `status.get` reports about the machine. The operating system comes from
 * the host port, read once by the composition root; tool versions come from each driver. This
 * module joins the two and names no tool (architecture rule 1).
 *
 * `status.get` is the gateway's liveness probe, so it never waits here: facts are served from
 * memory, and a re-read starts in the background once they are older than `HOST_FACTS_MAX_AGE_MS`.
 */
import type { Clock, HostSystem, Logger } from "../ports/index.js";
import { NoopLogger } from "../ports/index.js";
import type { Driver, DriverToolVersion } from "./driver.js";
import type { Platform } from "./domain.js";

/** Fixed, not configured (ADR 0008 §9): tool versions change only when someone installs one. */
export const HOST_FACTS_MAX_AGE_MS = 60_000;

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
          const tools = await driver.toolVersions();
          this.#toolsByDriver.set(
            index,
            tools.map((tool) => ({ ...tool, platform: driver.platform })),
          );
        } catch (error: unknown) {
          // The contract says a driver does not throw here. One that does keeps the tools it
          // reported last, so a passing failure does not blank the host's status.
          this.#logger.warn("Tool version read failed", {
            platform: driver.platform,
            reason: error instanceof Error ? error.message : "unknown",
          });
        }
      }),
    );
    this.#readAt = this.#clock.now();
  }
}
