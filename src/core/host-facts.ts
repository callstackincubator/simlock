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

/**
 * The bounds `status.get`'s `host` schema enforces (`hostFactsSchema` in the contract, which this
 * module cannot import). A value past them would fail the daemon's own output check and take
 * `status.get` down with it, so it is kept out here instead: a tool that does not fit is left
 * out like one that cannot be read, and a host string that does not fit is cut to length.
 */
const MAX_HOST_STRING_LENGTH = 128;
const MAX_HOST_TOOLS = 32;

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
    this.#system = {
      arch: options.system.arch.slice(0, MAX_HOST_STRING_LENGTH),
      os: options.system.os.slice(0, MAX_HOST_STRING_LENGTH),
      osVersion: options.system.osVersion.slice(0, MAX_HOST_STRING_LENGTH),
    };
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
        .flatMap((index) => this.#toolsByDriver.get(index) ?? [])
        .slice(0, MAX_HOST_TOOLS),
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
            tools.filter(fitsBounds).map((tool) => ({ ...tool, platform: driver.platform })),
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

function fitsBounds(tool: DriverToolVersion): boolean {
  return [tool.name, tool.version, ...(tool.build === undefined ? [] : [tool.build])].every(
    (value) => value.length > 0 && value.length <= MAX_HOST_STRING_LENGTH,
  );
}
