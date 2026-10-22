import { join } from "node:path";

import type { EventBus } from "../bus/index.js";
import type { UpdateFailure, UpdateState } from "../contract/index.js";
import type { Registry } from "../core/index.js";
import type { UpdateHold } from "../leasing/index.js";
import type { Clock, DaemonRole, NpmCli, UpdaterLauncher } from "../ports/index.js";

export interface UpdateInput {
  readonly version?: string | undefined;
  readonly force?: boolean | undefined;
  readonly query?: boolean | undefined;
}

export interface UpdateProgress {
  readonly update: UpdateState | null;
  readonly lastUpdateFailure: UpdateFailure | null;
  readonly latestVersion: string | null;
}

export interface UpdateOutcome extends UpdateProgress {
  readonly started: boolean;
  readonly upToDate: boolean;
  readonly resolved: string | null;
}

export interface UpdateCoordinator {
  request(input: UpdateInput): Promise<UpdateOutcome>;
  state(): UpdateProgress;
}

export interface UpdateCoordinatorOptions {
  readonly npm: NpmCli;
  readonly launcher: UpdaterLauncher;
  readonly leasing: UpdateHold;
  readonly registry: Pick<Registry, "snapshot">;
  readonly eventBus: Pick<EventBus, "emit" | "subscribe">;
  readonly clock: Clock;
  readonly version: string;
  readonly packageRoot: string;
  readonly simlockHome: string;
  readonly role: DaemonRole;
  readonly logPath: string;
  readonly pid: number;
}

interface Run {
  readonly from: string;
  readonly to: string;
  readonly startedAt: number;
  forced: boolean;
  stage: UpdateState["stage"];
  leases: number;
}

function stateOf(run: Run): UpdateState {
  const { from, to, startedAt, forced } = run;
  const base = { from, to, forced, startedAt };
  return run.stage === "waiting"
    ? { stage: "waiting", leases: run.leases, ...base }
    : { stage: run.stage, ...base };
}

class Coordinator implements UpdateCoordinator {
  #run: Run | undefined;
  #lastFailure: UpdateFailure | null = null;

  constructor(private readonly options: UpdateCoordinatorOptions) {
    const leaseEnded = (): void => {
      void this.#leaseEnded();
    };
    options.eventBus.subscribe("lease.released", leaseEnded);
    options.eventBus.subscribe("lease.expired", leaseEnded);
  }

  state(): UpdateProgress {
    return {
      update: this.#run === undefined ? null : stateOf(this.#run),
      lastUpdateFailure: this.#lastFailure,
      latestVersion: null,
    };
  }

  async request(input: UpdateInput): Promise<UpdateOutcome> {
    if (input.query === true) return this.#outcome(false, null);
    const run = this.#run;
    if (run !== undefined) {
      if (input.force === true && run.stage === "waiting") {
        run.forced = true;
        await this.#install(run);
      }
      return this.#outcome(false, null);
    }
    const spec = input.version ?? "latest";
    const viewed = await this.options.npm.view(`simlock@${spec}`);
    if (!viewed.ok) throw new Error(viewed.message);
    await this.#begin(viewed.output, input.force === true);
    return this.#outcome(true, viewed.output);
  }

  async #begin(to: string, forced: boolean): Promise<void> {
    const { clock, eventBus, version: from } = this.options;
    const leases = this.#leaseCount();
    const run: Run = { from, to, startedAt: clock.now(), forced, stage: "waiting", leases };
    this.#run = run;
    eventBus.emit("daemon.update-started", { from, to, forced }, "update-coordinator");
    if (forced || leases === 0) await this.#install(run);
  }

  #leaseCount(): number {
    return this.options.registry.snapshot.leases.length;
  }

  async #leaseEnded(): Promise<void> {
    const run = this.#run;
    if (run?.stage !== "waiting") return;
    run.leases = this.#leaseCount();
    if (run.leases === 0) await this.#install(run);
  }

  async #install(run: Run): Promise<void> {
    run.stage = "installing";
    await this.options.launcher.launch({
      entry: join(this.options.packageRoot, "dist", "updater", "main.js"),
      from: run.from,
      to: run.to,
      role: this.options.role,
      pid: this.options.pid,
      simlockHome: this.options.simlockHome,
      logPath: this.options.logPath,
    });
  }

  #outcome(started: boolean, resolved: string | null): UpdateOutcome {
    return { ...this.state(), started, upToDate: false, resolved };
  }
}

export function createUpdateCoordinator(options: UpdateCoordinatorOptions): UpdateCoordinator {
  return new Coordinator(options);
}
