import { BootTimeoutError } from "../../core/index.js";
import type { Clock } from "../../ports/index.js";

import { COMMAND_TIMEOUT_MS, Simctl, alreadyBooted } from "./simctl.js";

const INSTALLER_POLL_MS = 1_000;

interface SimulatorBootOptions {
  readonly clock: Clock;
  readonly ownsDeviceSet: boolean;
  readonly simctl: Simctl;
}

/** why: the part of IosSimctlDriver (ADR 0063) that boots a simulator and waits until it is ready to take requests, on one deadline. */
export class SimulatorBoot {
  readonly #clock: Clock;
  readonly #ownsDeviceSet: boolean;
  readonly #simctl: Simctl;

  constructor(options: SimulatorBootOptions) {
    this.#clock = options.clock;
    this.#ownsDeviceSet = options.ownsDeviceSet;
    this.#simctl = options.simctl;
  }

  async bootAndWait(
    udid: string,
    deviceId: string,
    bootstatusTimeoutMs: number,
    set?: string,
    refreshBooted = false,
  ): Promise<void> {
    const deadline = this.#clock.now() + bootstatusTimeoutMs;
    const boot = await this.#boot(udid, deadline, set, refreshBooted);
    if (boot.kind === "timed-out") {
      throw new BootTimeoutError(deviceId);
    }
    if (boot.result.code !== 0 && !alreadyBooted(boot.result.stderr)) {
      this.#simctl.assertSuccessful(["boot", udid], boot.result);
    }
    const outcome = await this.#simctl.invoke(
      ["bootstatus", udid, "-b"],
      this.#left(deadline),
      set,
    );
    if (outcome.kind === "finished") {
      this.#simctl.assertSuccessful(["bootstatus", udid, "-b"], outcome.result);
      if (await this.#waitForInstaller(udid, deadline, set)) return;
    }

    await this.#simctl.bestEffortShutdown(udid, set);
    throw new BootTimeoutError(deviceId);
  }

  // why: a booted simulator keeps the clipboard sync it booted with, so a lease's device that is
  // already up is shut down and booted again once DeviceHub's preference is set.
  async #boot(udid: string, deadline: number, set: string | undefined, refreshBooted: boolean) {
    const boot = await this.#simctl.invoke(["boot", udid], this.#left(deadline), set);
    const refresh =
      refreshBooted &&
      !this.#ownsDeviceSet &&
      set === undefined &&
      boot.kind === "finished" &&
      boot.result.code !== 0 &&
      alreadyBooted(boot.result.stderr);
    if (!refresh) return boot;
    await this.#simctl.shutdown(udid);
    return await this.#simctl.invoke(["boot", udid], this.#left(deadline));
  }

  #left(deadline: number): number {
    return Math.max(0, deadline - this.#clock.now());
  }

  async #waitForInstaller(udid: string, deadline: number, set?: string): Promise<boolean> {
    // why: bootstatus can finish before the installer accepts requests after an erase (#547).
    while (this.#clock.now() < deadline) {
      const outcome = await this.#simctl.invoke(
        ["listapps", udid],
        Math.min(COMMAND_TIMEOUT_MS, deadline - this.#clock.now()),
        set,
      );
      if (outcome.kind === "finished" && outcome.result.code === 0) {
        return this.#clock.now() < deadline;
      }
      const remainingMs = deadline - this.#clock.now();
      if (remainingMs <= 0) break;
      await new Promise<void>((resolve) => {
        this.#clock.setTimer(Math.min(INSTALLER_POLL_MS, remainingMs), resolve);
      });
    }
    return false;
  }
}
