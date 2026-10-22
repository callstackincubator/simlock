import {
  type Clock,
  type Filesystem,
  isMissingPathError,
  type Logger,
  type PathDetails,
  type ProcessHandle,
  type ProcessResult,
  type ProcessRunner,
  type ProcessSupervisor,
  type TcpProbe,
  type TimerHandle,
} from "../../ports/index.js";
import {
  AGENT_DEVICE_RPC_PROTOCOL_VERSION,
  isVersionAtLeast,
  MIN_AGENT_DEVICE_VERSION,
  MIN_NODE_VERSION,
} from "../shared/compatibility.js";
import {
  AGENT_DEVICE_POLICY,
  agentDeviceDaemonEnvironment,
  agentDeviceLeaseMaxTtlMs,
  NO_ANDROID_DEVICE_SERIAL,
} from "../shared/daemon-environment.js";
import type { AgentDeviceHealthProbe } from "./health.js";
import { findAgentDevice } from "./install.js";

export type AgentDevicePlatform = "ios" | "android";

type UnavailableReason =
  | "not-found"
  | "not-agent-device"
  | "wrong-version"
  | "state-dir"
  | "start-failed";

export type AgentDeviceAvailability =
  | { readonly state: "off" }
  | { readonly state: "starting" }
  | {
      readonly state: "running";
      readonly version: string;
      readonly baseUrl: string;
      readonly token: string;
      readonly generation: number;
      readonly leaseMaxTtlMs: number;
      readonly platforms: readonly AgentDevicePlatform[];
    }
  | {
      readonly state: "unavailable";
      readonly reason: UnavailableReason;
      readonly message: string;
      readonly remedy: string;
    };

/** why: which of the worker's two daemons a supervisor runs: the one over Simlock's simulator set, or the one that sees the host's phones. */
export type AgentDeviceRole = "simulators" | "phones";

export interface AgentDeviceIosSigning {
  readonly teamId?: string;
  readonly bundleId?: string;
  readonly provisioningProfile?: string;
  readonly signingIdentity?: string;
}

const IOS_SIGNING_ENVIRONMENT = {
  bundleId: "AGENT_DEVICE_IOS_BUNDLE_ID",
  provisioningProfile: "AGENT_DEVICE_IOS_PROVISIONING_PROFILE",
  signingIdentity: "AGENT_DEVICE_IOS_SIGNING_IDENTITY",
  teamId: "AGENT_DEVICE_IOS_TEAM_ID",
} as const satisfies Record<keyof AgentDeviceIosSigning, string>;

/** why: the adb server the physical Android driver uses, the host's default one. */
const DEFAULT_ADB_SERVER_PORT = "5037";

/** why: an operator shell that exported any of these would point the phone daemon at another adb server or device. */
const ADB_SELECTION_KEYS = new Set([
  "ANDROID_ADB_SERVER_PORT",
  "ANDROID_ADB_SERVER_ADDRESS",
  "ADB_SERVER_SOCKET",
  "ANDROID_SERIAL",
]);

export interface AgentDeviceSupervisorOptions {
  readonly baseEnvironment: NodeJS.ProcessEnv;
  readonly clock: Clock;
  readonly config: { readonly command: string };
  readonly driverEnvironment: Readonly<Record<string, string>>;
  readonly filesystem: Filesystem;
  readonly healthProbe: AgentDeviceHealthProbe;
  readonly home: string;
  readonly ios?: AgentDeviceIosSigning;
  readonly leaseMaxTtlMs: number;
  readonly logger: Logger;
  readonly nodePath: string;
  readonly nodeVersion: string;
  readonly platforms: readonly AgentDevicePlatform[];
  readonly processRunner: ProcessRunner;
  readonly processSupervisor: ProcessSupervisor;
  readonly role: AgentDeviceRole;
  readonly tcpProbe: TcpProbe;
}

const POLL_MS = 100;
const PS_TIMEOUT_MS = 5_000;
const VERSION_TIMEOUT_MS = 10_000;
const READY_TIMEOUT_MS = 15_000;
const TERM_GRACE_MS = 10_000;
const KILL_GRACE_MS = 2_000;
const RETRY_MS = 30_000;
const STABLE_AFTER_READY_MS = 60_000;
const MARKER = "--simlock-home=";
const PHONES_MARKER = "--simlock-role=phones";
const RESTART = "then restart the daemon (`simlock daemon stop`, then `simlock daemon start`)";

type RemedyKind = UnavailableReason | "node" | "protocol";

interface Child {
  readonly pid: number;
  exit: ProcessResult | undefined;
  readyAt: number;
}

interface PidRecord {
  readonly pid: number;
  readonly entry: string;
  readonly startedAt: number;
}

type Raced<T> = { readonly timedOut: false; readonly value: T } | { readonly timedOut: true };

type ReadyOutcome =
  | { readonly kind: "ready"; readonly baseUrl: string; readonly token: string }
  | { readonly kind: "exited" }
  | { readonly kind: "cancelled" }
  | { readonly kind: "refused"; readonly reason: UnavailableReason; readonly message: string };

type ReapOutcome = { readonly ok: true } | { readonly ok: false; readonly message: string };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeExit(result: ProcessResult): string {
  return result.code === null ? "after a signal" : `with code ${result.code}`;
}

function endpointOf(
  daemon: Record<string, unknown> | undefined,
  pid: number,
): { readonly httpPort: number; readonly token: string } | undefined {
  if (daemon === undefined || daemon["pid"] !== pid) return undefined;
  const { httpPort, token } = daemon;
  return typeof httpPort === "number" && typeof token === "string"
    ? { httpPort, token }
    : undefined;
}

function judgeHealth(body: unknown, version: string): ReadyOutcome | undefined {
  const health = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const protocol = health["rpcProtocolVersion"];
  if (health["service"] !== "agent-device-daemon" || typeof protocol !== "number") {
    return {
      kind: "refused",
      message: "/health did not answer as agent-device",
      reason: "not-agent-device",
    };
  }
  if (protocol === AGENT_DEVICE_RPC_PROTOCOL_VERSION) return undefined;
  return {
    kind: "refused",
    message: `agent-device ${version} speaks RPC protocol ${protocol}, need ${AGENT_DEVICE_RPC_PROTOCOL_VERSION}`,
    reason: "wrong-version",
  };
}

export class AgentDeviceSupervisor {
  readonly #o: AgentDeviceSupervisorOptions;
  #stateDir: string;
  #recordPath: string;
  #availability: AgentDeviceAvailability;
  #generation = 0;
  #stopped = false;
  #child: Child | undefined;
  #current: Promise<void> = Promise.resolve();
  #retry: TimerHandle | undefined;
  readonly #stopWaiters = new Set<() => void>();

  constructor(options: AgentDeviceSupervisorOptions) {
    this.#o = options;
    this.#stateDir = `${options.home}/${this.#stem}`;
    this.#recordPath = `${options.home}/${this.#stem}-daemon.json`;
    this.#availability = { state: "starting" };
  }

  get #stem(): string {
    return this.#o.role === "phones" ? "agent-device-phones" : "agent-device";
  }

  /** why: the words after the entry on the daemon's command line; a pid is signalled only when its line ends with them. */
  #markerArgs(realHome: string): readonly string[] {
    return this.#o.role === "phones"
      ? [`${MARKER}${realHome}`, PHONES_MARKER]
      : [`${MARKER}${realHome}`];
  }

  availability(): AgentDeviceAvailability {
    return this.#availability;
  }

  async start(): Promise<void> {
    await this.#begin();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    for (const wake of this.#stopWaiters) wake();
    this.#cancelRetry();
    await this.#current;
    const child = this.#child;
    this.#child = undefined;
    if (child !== undefined) {
      const gone = child.exit !== undefined || (await this.#terminate(child.pid));
      if (gone) {
        await this.#removeRecord();
      } else {
        this.#o.logger.warn(
          `agent-device (${this.#o.role}) daemon pid ${child.pid} is still alive after stop; its record is kept for the next start`,
        );
      }
    }
    this.#availability = { state: "off" };
  }

  #begin(): Promise<void> {
    this.#current = this.#run();
    return this.#current;
  }

  async #run(): Promise<void> {
    if (this.#stopped) return;
    try {
      await this.#startOnce();
    } catch (error: unknown) {
      this.#fail("start-failed", messageOf(error));
    }
    if (!this.#stopped && this.#availability.state === "unavailable") {
      if (this.#availability.reason === "start-failed") this.#scheduleRetry();
    }
  }

  #scheduleRetry(): void {
    this.#cancelRetry();
    this.#retry = this.#o.clock.setTimer(RETRY_MS, () => {
      this.#retry = undefined;
      void this.#begin();
    });
  }

  #cancelRetry(): void {
    if (this.#retry === undefined) return;
    this.#o.clock.cancel(this.#retry);
    this.#retry = undefined;
  }

  #remedy(kind: RemedyKind): string {
    switch (kind) {
      case "not-found":
        return `install agent-device ${MIN_AGENT_DEVICE_VERSION} or later, or set capabilities.agent-device.command to its path, ${RESTART}`;
      case "not-agent-device":
        return `point capabilities.agent-device.command at an agent-device install, ${RESTART}`;
      case "wrong-version":
        return `install agent-device ${MIN_AGENT_DEVICE_VERSION} or later, ${RESTART}`;
      case "node":
        return `run simlock on Node ${MIN_NODE_VERSION} or later, ${RESTART}`;
      case "protocol":
        return `install an agent-device that speaks RPC protocol ${AGENT_DEVICE_RPC_PROTOCOL_VERSION}, ${RESTART}`;
      case "state-dir":
        return `make ${this.#stateDir} a directory owned by the user simlock runs as, ${RESTART}`;
      case "start-failed":
        return "simlock tries again every 30 s; see the daemon log (`simlock daemon logs`)";
    }
  }

  #fail(reason: UnavailableReason, message: string, remedyKind?: RemedyKind): void {
    if (reason === "start-failed" && !this.#stopped)
      this.#o.logger.warn(`agent-device (${this.#o.role}) start failed: ${message}`);
    this.#availability = {
      state: "unavailable",
      reason,
      message,
      remedy: this.#remedy(remedyKind ?? reason),
    };
  }

  async #startOnce(): Promise<void> {
    const o = this.#o;
    const realHome = await o.filesystem.realpath(o.home);
    this.#stateDir = `${realHome}/${this.#stem}`;
    this.#recordPath = `${realHome}/${this.#stem}-daemon.json`;
    this.#availability = { state: "starting" };
    if (!(await this.#reapStep(realHome))) return;
    const found = await this.#checkInstall();
    if (found === undefined || this.#stopped) return;
    const env = await this.#prepareLaunch();
    if (env === undefined || this.#stopped) return;
    const child = await this.#launch(found.entry, realHome, env);
    if (child === undefined) return;
    await this.#awaitReady(child, found.version);
  }

  async #reapStep(realHome: string): Promise<boolean> {
    const reaped = await this.#reap(realHome);
    if (this.#stopped) return false;
    if (!reaped.ok) {
      this.#fail("start-failed", reaped.message);
      return false;
    }
    return true;
  }

  async #checkInstall(): Promise<{ readonly entry: string; readonly version: string } | undefined> {
    const o = this.#o;
    const install = await findAgentDevice(
      o.filesystem,
      o.config.command,
      o.baseEnvironment["PATH"],
    );
    if (!install.ok) {
      this.#fail(install.reason, install.message);
      return undefined;
    }
    if (this.#stopped) return undefined;
    const version = await this.#readVersion(install.realPath);
    if (typeof version !== "string") {
      this.#fail("not-agent-device", version.message);
      return undefined;
    }
    return this.#versionsAcceptable(version) ? { entry: install.entry, version } : undefined;
  }

  #versionsAcceptable(version: string): boolean {
    if (!isVersionAtLeast(version, MIN_AGENT_DEVICE_VERSION)) {
      this.#fail("wrong-version", `found ${version}, need ${MIN_AGENT_DEVICE_VERSION} or later`);
      return false;
    }
    if (!isVersionAtLeast(this.#o.nodeVersion, MIN_NODE_VERSION)) {
      this.#fail(
        "wrong-version",
        `agent-device needs Node ${MIN_NODE_VERSION} or later, simlock runs on Node ${this.#o.nodeVersion}`,
        "node",
      );
      return false;
    }
    return true;
  }

  async #prepareLaunch(): Promise<NodeJS.ProcessEnv | undefined> {
    const problem = await this.#prepareStateDir();
    if (problem !== undefined) {
      this.#fail("state-dir", problem);
      return undefined;
    }
    const policyPath = `${this.#stateDir}/policy.json`;
    await this.#o.filesystem.writeFileAtomic(policyPath, JSON.stringify(AGENT_DEVICE_POLICY));
    return this.#environment(policyPath);
  }

  async #launch(
    entry: string,
    realHome: string,
    env: NodeJS.ProcessEnv,
  ): Promise<Child | undefined> {
    const o = this.#o;
    let handle: ProcessHandle;
    try {
      handle = o.processRunner.spawn(o.nodePath, [entry, ...this.#markerArgs(realHome)], {
        env,
        stdio: "ignore",
      });
    } catch (error: unknown) {
      this.#fail("start-failed", `could not start agent-device: ${messageOf(error)}`);
      return undefined;
    }
    handle.unref();
    const child: Child = { exit: undefined, pid: handle.pid, readyAt: 0 };
    const exited = (result: ProcessResult) => {
      child.exit = result;
      this.#onChildExit(child);
    };
    handle.wait().then(exited, () => exited({ code: null, stderr: "", stdout: "" }));

    try {
      const record: PidRecord = { entry, pid: child.pid, startedAt: o.clock.now() };
      await o.filesystem.writeFileAtomic(this.#recordPath, JSON.stringify(record));
    } catch (error: unknown) {
      await this.#stopFailedChild(
        child,
        "start-failed",
        `could not write the pid record: ${messageOf(error)}`,
      );
      return undefined;
    }
    return child;
  }

  async #awaitReady(child: Child, version: string): Promise<void> {
    const signal = { aborted: false };
    const raced = await this.#race(this.#waitReady(child, version, signal), READY_TIMEOUT_MS);
    signal.aborted = true;
    if (raced.timedOut) {
      await this.#stopFailedChild(
        child,
        "start-failed",
        `agent-device was not ready within ${READY_TIMEOUT_MS / 1000} s (timed out)`,
      );
      return;
    }
    await this.#settle(child, version, raced.value);
  }

  async #settle(child: Child, version: string, outcome: ReadyOutcome): Promise<void> {
    switch (outcome.kind) {
      case "cancelled":
        await this.#stopFailedChild(child, "start-failed", "stopped");
        this.#availability = { state: "off" };
        return;
      case "exited":
        await this.#removeRecord();
        this.#fail(
          "start-failed",
          `agent-device exited ${describeExit(child.exit as ProcessResult)} before it was ready`,
        );
        return;
      case "refused":
        await this.#stopFailedChild(
          child,
          outcome.reason,
          outcome.message,
          outcome.reason === "wrong-version" ? "protocol" : undefined,
        );
        return;
      case "ready":
        this.#markRunning(child, version, outcome);
    }
  }

  #markRunning(
    child: Child,
    version: string,
    ready: { readonly baseUrl: string; readonly token: string },
  ): void {
    const o = this.#o;
    this.#generation += 1;
    child.readyAt = o.clock.now();
    this.#child = child;
    this.#availability = {
      baseUrl: ready.baseUrl,
      generation: this.#generation,
      leaseMaxTtlMs: agentDeviceLeaseMaxTtlMs(o.leaseMaxTtlMs),
      platforms: o.platforms,
      state: "running",
      token: ready.token,
      version,
    };
    if (child.exit !== undefined) this.#onChildExit(child);
  }

  #onChildExit(child: Child): void {
    if (this.#stopped || this.#child !== child) return;
    this.#child = undefined;
    const result = child.exit as ProcessResult;
    const elapsedMs = this.#o.clock.now() - child.readyAt;
    this.#o.logger.warn(
      `agent-device (${this.#o.role}) daemon pid ${child.pid} exited ${describeExit(result)}`,
    );
    if (elapsedMs >= STABLE_AFTER_READY_MS) {
      void this.#begin();
      return;
    }
    this.#fail(
      "start-failed",
      `agent-device exited ${describeExit(result)}, ${Math.floor(elapsedMs / 1000)} s after it was ready`,
    );
    this.#scheduleRetry();
  }

  async #readVersion(realPath: string): Promise<string | { readonly message: string }> {
    const o = this.#o;
    let raced: Raced<ProcessResult>;
    try {
      raced = await this.#race(
        o.processRunner.run(o.nodePath, [realPath, "--version"], { timeoutMs: VERSION_TIMEOUT_MS }),
        VERSION_TIMEOUT_MS,
      );
    } catch (error: unknown) {
      return { message: `agent-device --version failed: ${messageOf(error)}` };
    }
    if (raced.timedOut) {
      return { message: `agent-device --version timed out after ${VERSION_TIMEOUT_MS / 1000} s` };
    }
    if (raced.value.code !== 0) {
      return { message: `agent-device --version exited with code ${raced.value.code}` };
    }
    const version = raced.value.stdout.split("\n")[0]?.trim() ?? "";
    return version === "" ? { message: "agent-device --version printed nothing" } : version;
  }

  async #prepareStateDir(): Promise<string | undefined> {
    const path = this.#stateDir;
    let details;
    try {
      details = await this.#o.filesystem.lstat(path);
    } catch (error: unknown) {
      if (!isMissingPathError(error)) return `${path} cannot be inspected: ${messageOf(error)}`;
      return this.#createStateDir();
    }
    return this.#tightenStateDir(details);
  }

  async #createStateDir(): Promise<string | undefined> {
    try {
      await this.#o.filesystem.mkdir(this.#stateDir, { mode: 0o700 });
    } catch (error: unknown) {
      return `${this.#stateDir} cannot be created: ${messageOf(error)}`;
    }
    return undefined;
  }

  async #tightenStateDir(details: PathDetails): Promise<string | undefined> {
    const path = this.#stateDir;
    if (details.kind !== "directory") return `${path} is a ${details.kind}, not a directory`;
    const uid = process.getuid?.();
    if (uid !== undefined && details.uid !== uid) return `${path} is owned by another user`;
    if (details.mode === 0o700) return undefined;
    try {
      await this.#o.filesystem.chmod(path, 0o700);
    } catch (error: unknown) {
      return `${path} cannot be set to mode 0700: ${messageOf(error)}`;
    }
    return undefined;
  }

  async #environment(policyPath: string): Promise<NodeJS.ProcessEnv> {
    const o = this.#o;
    const phones = o.role === "phones";
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(o.baseEnvironment)) {
      if (key.startsWith("AGENT_DEVICE_") || (phones && ADB_SELECTION_KEYS.has(key))) continue;
      env[key] = value;
    }
    Object.assign(
      env,
      phones ? {} : o.driverEnvironment,
      agentDeviceDaemonEnvironment({
        leaseMaxTtlMs: o.leaseMaxTtlMs,
        policyPath,
        stateDir: this.#stateDir,
      }),
    );
    if (phones) Object.assign(env, this.#phoneEnvironment());
    await this.#hideUnusedPlatforms(env);
    return env;
  }

  #phoneEnvironment(): Record<string, string> {
    const signing: Record<string, string> = { ANDROID_ADB_SERVER_PORT: DEFAULT_ADB_SERVER_PORT };
    for (const [key, name] of Object.entries(IOS_SIGNING_ENVIRONMENT)) {
      const value = this.#o.ios?.[key as keyof AgentDeviceIosSigning];
      if (value !== undefined) signing[name] = value;
    }
    return signing;
  }

  async #hideUnusedPlatforms(env: NodeJS.ProcessEnv): Promise<void> {
    const o = this.#o;
    if (o.platforms.includes("ios")) {
      const deviceSet = o.driverEnvironment["SIMLOCK_IOS_DEVICE_SET"];
      if (o.role !== "phones" && deviceSet !== undefined) {
        env["AGENT_DEVICE_IOS_SIMULATOR_DEVICE_SET"] = deviceSet;
      }
    } else {
      const empty = `${this.#stateDir}/no-ios-devices`;
      try {
        await o.filesystem.mkdir(empty, { mode: 0o700 });
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await o.filesystem.chmod(empty, 0o700);
      }
      env["AGENT_DEVICE_IOS_SIMULATOR_DEVICE_SET"] = empty;
    }
    this.#hideAndroid(env);
  }

  #hideAndroid(env: NodeJS.ProcessEnv): void {
    if (!this.#o.platforms.includes("android")) {
      env["AGENT_DEVICE_ANDROID_DEVICE_ALLOWLIST"] = NO_ANDROID_DEVICE_SERIAL;
    }
  }

  async #waitReady(
    child: Child,
    version: string,
    signal: { aborted: boolean },
  ): Promise<ReadyOutcome> {
    for (;;) {
      await this.#untilStop(this.#sleep(POLL_MS));
      if (signal.aborted || this.#stopped) return { kind: "cancelled" };
      if (child.exit !== undefined) return { kind: "exited" };
      const outcome = await this.#probe(child, version);
      if (outcome !== undefined) return outcome;
    }
  }

  async #probe(child: Child, version: string): Promise<ReadyOutcome | undefined> {
    const o = this.#o;
    const endpoint = endpointOf(await this.#readDaemonJson(), child.pid);
    if (endpoint === undefined) return undefined;
    if (!(await o.tcpProbe.isListening(endpoint.httpPort))) return undefined;
    const baseUrl = `http://127.0.0.1:${endpoint.httpPort}`;
    let body: unknown;
    try {
      const read = await this.#untilStop(o.healthProbe.read(baseUrl));
      if (read === "stopped") return { kind: "cancelled" };
      body = read;
    } catch {
      return undefined;
    }
    return judgeHealth(body, version) ?? { baseUrl, kind: "ready", token: endpoint.token };
  }

  async #readDaemonJson(): Promise<Record<string, unknown> | undefined> {
    try {
      const parsed = JSON.parse(
        await this.#o.filesystem.readFile(`${this.#stateDir}/daemon.json`),
      ) as unknown;
      return typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  }

  async #stopFailedChild(
    child: Child,
    reason: UnavailableReason,
    message: string,
    remedyKind?: RemedyKind,
  ): Promise<void> {
    const gone = child.exit !== undefined || (await this.#terminate(child.pid));
    if (gone) {
      await this.#removeRecord();
      this.#fail(reason, message, remedyKind);
      return;
    }
    this.#o.logger.warn(
      `agent-device (${this.#o.role}) daemon pid ${child.pid} is still alive after SIGKILL; its record is kept for the next start`,
    );
    this.#fail(
      reason,
      `${message}; pid ${child.pid} is still alive and its record is kept`,
      remedyKind,
    );
  }

  async #terminate(pid: number): Promise<boolean> {
    const supervisor = this.#o.processSupervisor;
    supervisor.signal(pid, "SIGTERM");
    if (await this.#waitGone(pid, TERM_GRACE_MS)) return true;
    supervisor.signal(pid, "SIGKILL");
    return this.#waitGone(pid, KILL_GRACE_MS);
  }

  async #waitGone(pid: number, ms: number): Promise<boolean> {
    const deadline = this.#o.clock.now() + ms;
    while (this.#o.processSupervisor.isAlive(pid)) {
      if (this.#o.clock.now() >= deadline) return false;
      await this.#sleep(POLL_MS);
    }
    return true;
  }

  async #reap(realHome: string): Promise<ReapOutcome> {
    const record = await this.#readRecord();
    if (record !== undefined) {
      if (!this.#o.processSupervisor.isAlive(record.pid)) {
        await this.#removeRecord();
        return { ok: true };
      }
      return this.#reapPid(record.pid, realHome, record.entry);
    }
    if (!(await this.#stateDirIsOurs())) return { ok: true };
    const pid = (await this.#readDaemonJson())?.["pid"];
    if (typeof pid !== "number" || !this.#o.processSupervisor.isAlive(pid)) return { ok: true };
    return this.#reapPid(pid, realHome, undefined);
  }

  async #reapPid(pid: number, realHome: string, entry: string | undefined): Promise<ReapOutcome> {
    const supervisor = this.#o.processSupervisor;
    const inconclusive = (why: string): ReapOutcome => ({
      message: `the agent-device daemon a previous simlock left (pid ${pid}) ${why}`,
      ok: false,
    });

    const first = await this.#identify(pid, realHome, entry);
    if (first === "other") {
      await this.#removeRecord();
      return { ok: true };
    }
    if (first === "unknown")
      return inconclusive("could not be identified, so it was not signalled");

    supervisor.signal(pid, "SIGTERM");
    if (await this.#waitGone(pid, TERM_GRACE_MS)) {
      await this.#removeRecord();
      return { ok: true };
    }
    const second = await this.#identify(pid, realHome, entry);
    if (second === "other") {
      await this.#removeRecord();
      return { ok: true };
    }
    if (second === "unknown")
      return inconclusive("could not be identified again, so it was not killed");

    supervisor.signal(pid, "SIGKILL");
    if (await this.#waitGone(pid, KILL_GRACE_MS)) {
      await this.#removeRecord();
      return { ok: true };
    }
    return inconclusive("is still alive after SIGKILL");
  }

  async #identify(
    pid: number,
    realHome: string,
    entry: string | undefined,
  ): Promise<"own" | "other" | "unknown"> {
    const line = await this.#psLine(pid);
    if (line === undefined) return "unknown";
    if (!line.endsWith(` ${this.#markerArgs(realHome).join(" ")}`)) return "other";
    if (entry !== undefined && !line.includes(entry)) return "other";
    if (await this.#stateDirIsOurs()) {
      const named = (await this.#readDaemonJson())?.["pid"];
      if (named !== undefined && named !== pid) return "other";
    }
    return "own";
  }

  async #psLine(pid: number): Promise<string | undefined> {
    try {
      const raced = await this.#race(
        this.#o.processRunner.run("ps", ["-ww", "-o", "args=", "-p", String(pid)], {
          timeoutMs: PS_TIMEOUT_MS,
        }),
        PS_TIMEOUT_MS,
      );
      if (raced.timedOut || raced.value.code !== 0) return undefined;
      const line = raced.value.stdout.split("\n")[0]?.trim() ?? "";
      return line === "" ? undefined : line;
    } catch {
      return undefined;
    }
  }

  async #stateDirIsOurs(): Promise<boolean> {
    try {
      const details = await this.#o.filesystem.lstat(this.#stateDir);
      const uid = process.getuid?.();
      return details.kind === "directory" && (uid === undefined || details.uid === uid);
    } catch {
      return false;
    }
  }

  async #readRecord(): Promise<PidRecord | undefined> {
    try {
      const parsed = JSON.parse(
        await this.#o.filesystem.readFile(this.#recordPath),
      ) as Partial<PidRecord>;
      return typeof parsed.pid === "number" && typeof parsed.entry === "string"
        ? { entry: parsed.entry, pid: parsed.pid, startedAt: parsed.startedAt ?? 0 }
        : undefined;
    } catch {
      return undefined;
    }
  }

  async #removeRecord(): Promise<void> {
    await this.#o.filesystem.rm(this.#recordPath);
  }

  // why: a waiter per poll on one never-settling promise would pile up reactions across retries.
  async #untilStop<T>(work: Promise<T>): Promise<T | "stopped"> {
    if (this.#stopped) {
      work.catch(() => undefined);
      return "stopped";
    }
    let wake!: () => void;
    const stopped = new Promise<"stopped">((resolve) => {
      wake = () => resolve("stopped");
    });
    this.#stopWaiters.add(wake);
    try {
      return await Promise.race([work, stopped]);
    } finally {
      this.#stopWaiters.delete(wake);
    }
  }

  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.#o.clock.setTimer(ms, resolve);
    });
  }

  async #race<T>(work: Promise<T>, ms: number): Promise<Raced<T>> {
    let timer: TimerHandle | undefined;
    const limit = new Promise<Raced<T>>((resolve) => {
      timer = this.#o.clock.setTimer(ms, () => resolve({ timedOut: true }));
    });
    try {
      return await Promise.race([
        work.then((value): Raced<T> => ({ timedOut: false, value })),
        limit,
      ]);
    } finally {
      if (timer !== undefined) this.#o.clock.cancel(timer);
    }
  }
}
