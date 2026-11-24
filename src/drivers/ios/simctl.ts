import type { ProcessOutcome } from "./boot-courtesies.js";
import { DriverCrashError } from "../../core/index.js";
import type { Clock, Logger, ProcessResult, ProcessRunner } from "../../ports/index.js";
import { deleteLateSimulator, errorMessage, runCommand, type LateAnswer } from "./command-run.js";
import type { SeedTurns } from "./seed-turns.js";
import { parseCatalog, type SimctlCatalog } from "./simctl-parse.js";
import { parseRuntimeImages, type RuntimeImage } from "./runtime-images.js";

interface SimctlOptions {
  readonly clock: Clock;
  readonly createTimeoutMs: number;
  readonly deviceRoot: string;
  readonly logger: Logger | undefined;
  readonly ownsDeviceSet: boolean;
  readonly processRunner: ProcessRunner;
  readonly seedTurns: SeedTurns;
}

/** why: the part of IosSimctlDriver (ADR 0063) that runs `simctl` and `xcrun` for the driver, scoped to the device set it owns, and that every other part reaches simulators through. */
export class Simctl {
  readonly #clock: Clock;
  readonly #createTimeoutMs: number;
  readonly #deviceRoot: string;
  readonly #logger: Logger | undefined;
  readonly #ownsDeviceSet: boolean;
  readonly #processRunner: ProcessRunner;
  readonly #seedTurns: SeedTurns;

  constructor(options: SimctlOptions) {
    this.#clock = options.clock;
    this.#createTimeoutMs = options.createTimeoutMs;
    this.#deviceRoot = options.deviceRoot;
    this.#logger = options.logger;
    this.#ownsDeviceSet = options.ownsDeviceSet;
    this.#processRunner = options.processRunner;
    this.#seedTurns = options.seedTurns;
  }

  async loadCatalog(): Promise<SimctlCatalog> {
    const result = await this.run(["list", "-j", "devicetypes", "runtimes"], COMMAND_TIMEOUT_MS);

    try {
      return parseCatalog(JSON.parse(result.stdout) as unknown);
    } catch (error: unknown) {
      if (error instanceof DriverCrashError) {
        throw error;
      }

      throw new DriverCrashError(`Could not parse simctl device catalog: ${errorMessage(error)}`);
    }
  }

  async loadRuntimeImages(): Promise<readonly RuntimeImage[]> {
    const result = await this.run(["runtime", "list", "-j"], COMMAND_TIMEOUT_MS);
    try {
      return parseRuntimeImages(JSON.parse(result.stdout) as unknown);
    } catch (error: unknown) {
      if (error instanceof DriverCrashError) throw error;
      throw new DriverCrashError(`Could not parse simctl runtime list: ${errorMessage(error)}`);
    }
  }

  async shutdown(udid: string, set?: string): Promise<void> {
    const outcome = await this.invoke(["shutdown", udid], COMMAND_TIMEOUT_MS, set);

    if (outcome.kind === "timed-out") {
      throw new DriverCrashError(`simctl shutdown ${udid} timed out after ${COMMAND_TIMEOUT_MS}ms`);
    }
    if (outcome.result.code !== 0 && !alreadyShutdown(outcome.result.stderr)) {
      this.assertSuccessful(["shutdown", udid], outcome.result);
    }
  }

  async bestEffortShutdown(udid: string, set?: string): Promise<void> {
    try {
      await this.shutdown(udid, set);
    } catch {
      // why: Boot failure cleanup must not obscure the timeout that triggered it, and a destroy
      // lets `simctl delete` decide: a shutdown that timed out must not strand the simulator.
    }
  }

  /**
   * why: `simctl clone` and `simctl create` ask CoreSimulator's service for a whole simulator, and
   * the service finishes it even when `simctl` is killed. At the limit this stops waiting but lets
   * the command run on: the UDID it later prints is the driver's own, so ownership is proven by
   * the call, never by the name (safety rule 8), and that simulator is deleted. A deletion of
   * the seed waits for that copy (`SeedTurns.hold`); another clone of the seed does not.
   */
  async createSimulator(
    args: readonly string[],
    sets: { readonly destination?: string; readonly seedUdid?: string; readonly source?: string },
  ): Promise<ProcessResult> {
    let ended!: () => void;
    const lateEnded = new Promise<void>((resolve) => {
      ended = resolve;
    });
    const outcome = await this.invoke(args, this.#createTimeoutMs, sets.source, {
      killAfterMs: LATE_CREATE_KILL_MS,
      onSettled: (result) => {
        void deleteLateSimulator(args, result, this.#logger, async (udid) => {
          this.checked(
            ["delete", udid],
            COMMAND_TIMEOUT_MS,
            await this.invoke(["delete", udid], COMMAND_TIMEOUT_MS, sets.destination),
          );
        }).finally(ended);
      },
    });
    if (outcome.kind === "timed-out" && sets.seedUdid !== undefined) {
      this.#seedTurns.hold(sets.seedUdid, lateEnded);
    }
    return this.checked(args, this.#createTimeoutMs, outcome);
  }

  async run(args: readonly string[], timeoutMs: number, set?: string): Promise<ProcessResult> {
    return this.checked(args, timeoutMs, await this.invoke(args, timeoutMs, set));
  }

  async runLegacy(args: readonly string[], timeoutMs: number): Promise<ProcessResult> {
    return this.checked(args, timeoutMs, await this.invokeLegacy(args, timeoutMs));
  }

  checked(args: readonly string[], timeoutMs: number, outcome: ProcessOutcome): ProcessResult {
    if (outcome.kind === "timed-out") {
      throw new DriverCrashError(`simctl ${args.join(" ")} timed out after ${timeoutMs}ms`);
    }

    this.assertSuccessful(args, outcome.result);
    return outcome.result;
  }

  scopedArgv(args: readonly string[], set?: string): string[] {
    if (set !== undefined) return ["simctl", "--set", set, ...args];
    // why: Xcode's own set is simctl's default, so a call there carries no `--set`.
    if (!this.#ownsDeviceSet) return ["simctl", ...args];
    return ["simctl", "--set", this.#deviceRoot, ...args];
  }

  async invoke(
    args: readonly string[],
    timeoutMs: number,
    set?: string,
    late?: LateAnswer,
  ): Promise<ProcessOutcome> {
    return this.invokeXcrun(this.scopedArgv(args, set), timeoutMs, late);
  }

  /**
   * why: Deliberately unscoped, and the only thing in Simlock that is: the pre-root devices
   * `findLegacy` / `destroyLegacy` deal with are in the machine's default set, which is
   * where a `--set` would stop reaching them. Only those two may call it, and only for a
   * UDID a registry record names -- registry-only destruction (safety rule 1) is satisfied
   * by that record, not by the root. The one other caller is `listComponents`, and only for
   * `simctl list`, which reads the default set and mutates nothing (ADR 0010 §8).
   */
  async invokeLegacy(args: readonly string[], timeoutMs: number): Promise<ProcessOutcome> {
    return this.invokeXcrun(["simctl", ...args], timeoutMs);
  }

  async invokeXcrun(
    argv: readonly string[],
    timeoutMs: number,
    late?: LateAnswer,
  ): Promise<ProcessOutcome> {
    return await runCommand(this.#processRunner, this.#clock, "xcrun", argv, timeoutMs, late);
  }

  assertSuccessful(args: readonly string[], result: ProcessResult): void {
    if (result.code !== 0) {
      const stderr = result.stderr.trim();
      const suffix = stderr === "" ? "" : `: ${stderr}`;
      throw new DriverCrashError(
        `simctl ${args.join(" ")} exited with code ${String(result.code)}${suffix}`,
      );
    }
  }
}

export const COMMAND_TIMEOUT_MS = 30_000;

/** why: a clone or create past its limit is left running; one still silent this long after is killed. */
const LATE_CREATE_KILL_MS = 300_000;

function alreadyShutdown(stderr: string): boolean {
  return /Unable to shutdown.*current state:\s*Shutdown/i.test(stderr);
}

export function unknownDevice(result: ProcessResult): boolean {
  return /^Invalid device:/m.test(result.stderr);
}

export function alreadyBooted(stderr: string): boolean {
  return /current state:\s*Booted|already booted/i.test(stderr);
}
