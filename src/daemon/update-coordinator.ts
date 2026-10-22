import { join } from "node:path";

import { z } from "zod";

import type { EventBus } from "../bus/index.js";
import {
  isNewerVersion,
  updateFailureSchema,
  type UpdateFailure,
  type UpdateState,
} from "../contract/index.js";
import type { UpdateHold } from "../leasing/index.js";
import { checkInstall } from "../updater/index.js";
import { DispatchError } from "./dispatch.js";
import {
  isMissingPathError,
  type Clock,
  type DaemonRole,
  type Filesystem,
  type LaunchedUpdater,
  type NpmCli,
  type UpdaterLauncher,
} from "../ports/index.js";

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
  readResultFile(): Promise<void>;
  announceResultFile(): void;
}

export interface UpdateCoordinatorOptions {
  readonly npm: NpmCli;
  readonly latestVersion: () => string | null;
  readonly launcher: UpdaterLauncher;
  readonly leasing: UpdateHold;
  readonly registry: { readonly snapshot: { readonly leases: readonly unknown[] } };
  readonly eventBus: Pick<EventBus, "emit" | "subscribe">;
  readonly clock: Clock;
  readonly filesystem: Filesystem;
  readonly otherRoleRunning: () => Promise<boolean>;
  readonly version: string;
  readonly packageRoot: string;
  readonly simlockHome: string;
  readonly dataDirectory: string;
  readonly role: DaemonRole;
  readonly logPath: string;
  readonly pid: number;
}

const MESSAGE_MAX = 2000;
const RESULT_FILE = "update-result.json";

// why: a line on the updater's pipe is wire input, so only these two shapes are read and anything else is dropped.
const updaterLineSchema = z.union([
  z.object({ stage: z.enum(["installing", "restarting"]) }),
  z.object({
    failed: z.object({ stage: z.enum(["installing", "restarting"]), message: z.string() }),
  }),
]);

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseUpdaterLine(line: string): z.infer<typeof updaterLineSchema> | undefined {
  try {
    const parsed = updaterLineSchema.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
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
  #unannounced: UpdateFailure | undefined;
  #calls: Promise<unknown> = Promise.resolve();

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
      latestVersion: this.options.latestVersion(),
    };
  }

  // why: a call that arrives while another resolves the version waits for it, so two calls never start two updates; a query never waits.
  request(input: UpdateInput): Promise<UpdateOutcome> {
    if (input.query === true) return Promise.resolve(this.#outcome(false, null));
    const result = this.#calls.then(() => this.#update(input));
    this.#calls = result.catch(() => undefined);
    return result;
  }

  async #update(input: UpdateInput): Promise<UpdateOutcome> {
    const run = this.#run;
    if (run !== undefined) {
      if (input.force === true && run.stage === "waiting") {
        run.forced = true;
        await this.#install(run);
      }
      return this.#outcome(false, null);
    }
    const to = await this.#resolve(input.version ?? "latest");
    const { version } = this.options;
    if (to === version || (input.version === undefined && !isNewerVersion(to, version))) {
      return { ...this.#outcome(false, to), upToDate: true };
    }
    await this.#requireNpmInstall();
    await this.#begin(to, input.force === true);
    return this.#outcome(true, to);
  }

  async #resolve(spec: string): Promise<string> {
    const viewed = await this.options.npm.view(`simlock@${spec}`);
    if (!viewed.ok) {
      throw new DispatchError(
        "UPDATE_RESOLVE_FAILED",
        `could not resolve simlock@${spec}: ${viewed.message}`,
      );
    }
    return viewed.output;
  }

  async #requireNpmInstall(): Promise<void> {
    const { npm, filesystem, packageRoot, role, otherRoleRunning } = this.options;
    const install = await checkInstall({ npm, filesystem, packageRoot });
    if (!install.ok) {
      throw new DispatchError(
        "UPDATE_UNSUPPORTED_INSTALL",
        `simlock was not installed with npm i -g (found ${install.foundPath}). Update it by hand.`,
      );
    }
    if (await otherRoleRunning()) {
      const other = role === "worker" ? "gateway" : "worker";
      const flag = role === "worker" ? "--gateway " : "";
      throw new DispatchError(
        "UPDATE_SHARED_INSTALL",
        `the ${other} daemon of this user runs from the same install; stop it first with simlock ${flag}daemon stop`,
      );
    }
  }

  async #begin(to: string, forced: boolean): Promise<void> {
    const { clock, eventBus, version: from } = this.options;
    const leases = this.#leaseCount();
    const run: Run = { from, to, startedAt: clock.now(), forced, stage: "waiting", leases };
    this.#run = run;
    this.#lastFailure = null;
    await this.options.leasing.holdForUpdate();
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
    let updater: LaunchedUpdater;
    try {
      updater = await this.options.launcher.launch({
        entry: join(this.options.packageRoot, "dist", "updater", "main.js"),
        from: run.from,
        to: run.to,
        role: this.options.role,
        pid: this.options.pid,
        simlockHome: this.options.simlockHome,
        logPath: this.options.logPath,
      });
    } catch (error: unknown) {
      await this.#fail(run, "installing", describe(error));
      return;
    }
    void this.#follow(run, updater).catch((error: unknown) =>
      this.#fail(run, run.stage === "restarting" ? "restarting" : "installing", describe(error)),
    );
  }

  async #follow(run: Run, updater: LaunchedUpdater): Promise<void> {
    for await (const text of updater.lines) {
      const line = parseUpdaterLine(text);
      if (line === undefined) continue;
      if ("failed" in line) {
        await this.#fail(run, line.failed.stage, line.failed.message);
      } else if (this.#run === run) {
        run.stage = line.stage;
      }
    }
    const code = await updater.exited;
    if (code !== 0) {
      const stage = run.stage === "restarting" ? "restarting" : "installing";
      await this.#fail(run, stage, `the updater exited with code ${code ?? "none"}`);
    }
  }

  // why: the first failure of a run wins; a failed line is followed by the non-zero exit that reports the same failure.
  async #fail(run: Run, stage: UpdateFailure["stage"], message: string): Promise<void> {
    if (this.#run !== run) return;
    const { from, to } = run;
    this.#run = undefined;
    this.#lastFailure = {
      stage,
      from,
      to,
      message: message.slice(0, MESSAGE_MAX),
      at: this.options.clock.now(),
    };
    await this.options.leasing.releaseUpdateHold();
    this.options.eventBus.emit(
      "daemon.update-failed",
      { stage, from, to, message: this.#lastFailure.message },
      "update-coordinator",
    );
  }

  async readResultFile(): Promise<void> {
    const { filesystem, dataDirectory } = this.options;
    const path = join(dataDirectory, RESULT_FILE);
    let contents: string;
    try {
      contents = await filesystem.readFile(path);
    } catch (error: unknown) {
      if (isMissingPathError(error)) return;
      throw error;
    }
    await filesystem.rm(path);
    const failure = parseResultFile(contents);
    if (failure === undefined) return;
    this.#lastFailure = failure;
    this.#unannounced = failure;
  }

  // why: the failure is set while the daemon converges but announced only once the daemon serves, because a subscriber's `events.subscribe` is parked until then and would miss it.
  announceResultFile(): void {
    const failure = this.#unannounced;
    if (failure === undefined) return;
    this.#unannounced = undefined;
    const { stage, from, to, message } = failure;
    this.options.eventBus.emit(
      "daemon.update-failed",
      { stage, from, to, message },
      "update-coordinator",
    );
  }

  #outcome(started: boolean, resolved: string | null): UpdateOutcome {
    return { ...this.state(), started, upToDate: false, resolved };
  }
}

// why: the file is on disk and the updater wrote it, but a stale or damaged one must not stop the daemon from starting, so it is read as untrusted and the message cut to the bound.
function parseResultFile(contents: string): UpdateFailure | undefined {
  try {
    const value = JSON.parse(contents) as Record<string, unknown>;
    if (typeof value.message === "string") value.message = value.message.slice(0, MESSAGE_MAX);
    const parsed = updateFailureSchema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function createUpdateCoordinator(options: UpdateCoordinatorOptions): UpdateCoordinator {
  return new Coordinator(options);
}
