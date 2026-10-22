import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach } from "vitest";

import type { FakeDriverScript } from "../fake-driver/types.js";
import {
  cli,
  cliBackground,
  type CliBackgroundHandle,
  type CliOptions,
  type CliResult,
} from "./cli.js";
import {
  driverLogControl,
  driverScriptControl,
  type DriverLogControl,
  type DriverScriptControl,
} from "./driver-script.js";
import { events, expectEvents, type RecordedEvent } from "./events.js";
import { emptyDeviceSet, iosDeviceSet } from "./ios-device-set.js";
import { mcpClient, type McpClientHandle, type McpClientOptions } from "./mcp.js";
import { freeLoopbackPort } from "./port.js";
import { REPO_ROOT } from "./repo-root.js";
import { waitFor } from "./wait.js";

const execFileAsync = promisify(execFile);

const FAKE_DRIVER_MODULE = join(REPO_ROOT, "dist/e2e/index.js");

/**
 * Envs created by `withDaemon()` during the *currently running* test, torn down by
 * the single `afterEach` below.
 *
 * Why a module-level registry instead of each `withDaemon()` call registering its
 * own `afterEach`: vitest resolves hooks from the synchronous call stack active
 * during test *collection*, not test *execution*. `withDaemon()` is only ever called
 * from inside a running `it()` body (after collection has already finished), so an
 * `afterEach()` call made there never attaches to anything -- confirmed directly: it
 * silently never fires, for a hook registered synchronously as literally the first
 * statement of an async function just as much as one registered after several
 * `await`s. (This cost real debugging time: dozens of "green" runs were quietly
 * leaking daemon processes because teardown was never actually running -- passing a
 * test never depended on it.) Registering `afterEach` once here, at module top
 * level, happens during collection (this module is imported at each test file's own
 * top level), so it is a real, firing hook; it just needs to know which envs to tear
 * down, which is what this registry is for.
 */
const activeEnvs = new Set<TeardownState>();

afterEach(async () => {
  const states = [...activeEnvs];
  activeEnvs.clear();
  const results = await Promise.allSettled(states.map((state) => teardown(state)));
  const failures = results.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failures.length > 0) {
    throw new Error(failures.map((failure) => errorMessage(failure.reason)).join("; "));
  }
});

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Capacity inputs the fake-driver lane pins so a flow's device budget comes from the
 * flow, never from the machine running it. `defaultConfig` derives the per-platform
 * device limits from `availableParallelism()` (a 2-core runner yields exactly one iOS
 * device), and the `resource` capacity strategy independently gates on `totalmem()`
 * minus a 4 GiB OS reserve at 1.5 GiB per iOS device (a 7 GiB runner therefore admits
 * two, whatever `limits` says). A flow needing more concurrent devices than that passes on a dev
 * machine and wedges on a small CI runner -- the extra lease simply queues until the
 * test's own timeout, which reads as a hang rather than as "capacity refused".
 *
 * Fake devices are JSON in a file and consume no real RAM, so the per-device budget is
 * pinned to a nominal 1 MiB, which keeps the RAM gate from binding while leaving it
 * wired. Flows that exercise capacity itself override `limits` on top of this. The real
 * -SDK lane deliberately does not get this treatment: there the host's RAM is a real
 * constraint and the production defaults are what should apply.
 *
 * These are deliberately written in the pre-`capacity.strategy` spelling: the whole e2e
 * lane then doubles as end-to-end coverage that a config file written against an older
 * Simlock still configures the `resource` strategy correctly.
 */
const FAKE_LANE_BASE_CONFIG: Record<string, unknown> = {
  limits: {
    maxRunning: 8,
    ios: { maxDevices: 8, maxRunning: 8 },
    android: { maxDevices: 8, maxRunning: 8 },
  },
  ramBudget: { iosBytesPerDevice: 1024 * 1024, androidBytesPerDevice: 1024 * 1024 },
};

export interface WithDaemonOptions {
  /**
   * "running" (default) starts the daemon explicitly before returning, so the
   * first test action talks to an already-live daemon. "auto" leaves the daemon
   * unstarted so the test can exercise CLI/MCP auto-start and stale-socket
   * recovery itself.
   */
  readonly mode?: "running" | "auto";
  /** Seeded into config.json before the daemon (if any) starts. */
  readonly configOverrides?: Record<string, unknown>;
  readonly agentId?: string;
  /**
   * why: "fake" (default) wires `SIMLOCK_DRIVERS_MODULE` at the scriptable out-of-process
   * fake driver. "real" leaves driver discovery alone -- the daemon finds the real
   * iOS/Android drivers exactly as it would in production -- for the slow, real-SDK
   * lane; `driverScript`/`driverLog` are inert in that mode (nothing reads them).
   * "none" wires no driver and seeds no driver-shaped config at all: what a
   * gateway needs, since it starts no drivers and warns about every
   * worker-only key it is given (ADR 0005 §2).
   */
  readonly driver?: "fake" | "real" | "none";
  /**
   * why: "gateway" makes this env's daemon the gateway of its home: it lives in `<home>/gateway`,
   * and every CLI call the env makes puts `--gateway` first (ADR 0034). Omitted, the daemon is
   * the home's worker.
   */
  readonly role?: "gateway";
  /**
   * Written to the fake driver's script file before the daemon starts, so the daemon's very
   * first driver calls already see it. Setting `driverScript` after `withDaemon()` returns is
   * fine for anything the test asks for afterwards, but not for what the daemon read on its own
   * at startup: a worker joining a gateway reports its catalog the moment its uplink opens, and
   * a script written later only reaches the gateway on its 30s periodic refresh.
   */
  readonly driverScript?: FakeDriverScript;
  /** The platforms the fake registers a driver for; omitted registers both. Only with the fake
   * driver. A worker without a platform's driver lists no catalog for it. */
  readonly fakeDriverPlatforms?: readonly ("ios" | "android")[];
}

export interface TestEnv {
  readonly home: string;
  readonly dataDirectory: string;
  /**
   * The port this env's Simlock runs its own adb server on, in the real-SDK lane. A TCP
   * port is machine-global, so `SIMLOCK_HOME` alone no longer isolates two Simlocks and a
   * test that shares one with the developer's own daemon would fail closed on `occupied`.
   * `undefined` in the fake-driver lane, which has no adb server at all.
   */
  readonly adbServerPort: number | undefined;
  readonly socketPath: string;
  readonly logPath: string;
  readonly configPath: string;
  /** Environment to pass to any spawned simlock process (CLI, MCP, or the daemon). */
  readonly env: NodeJS.ProcessEnv;
  readonly driverScript: DriverScriptControl;
  readonly driverLog: DriverLogControl;
  cli(args: readonly string[], options?: CliOptions): Promise<CliResult>;
  cliBackground(args: readonly string[], options?: CliOptions): CliBackgroundHandle;
  mcpClient(options?: McpClientOptions): Promise<McpClientHandle>;
  events(since?: string, timeout?: number): Promise<RecordedEvent[]>;
  expectEvents(
    names: readonly string[],
    options?: { readonly since?: string; readonly timeout?: number },
  ): Promise<RecordedEvent[]>;
  /** Starts the daemon explicitly (`simlock daemon start`); a no-op if already running. */
  startDaemon(): Promise<CliResult>;
  /** Stops the daemon gracefully (`simlock daemon stop`), then restarts it explicitly. */
  restartDaemon(): Promise<void>;
  /** Sends the given signal directly to the daemon process (default SIGKILL), for
   *  stale-socket-recovery and orphan-sweep tests. Resolves once the process is gone. */
  killDaemon(signal?: NodeJS.Signals): Promise<void>;
  /** Writes config.json keys, restarts the daemon, runs `fn`, then restores the
   *  original config.json and restarts again. */
  withConfig<T>(overrides: Record<string, unknown>, fn: () => Promise<T>): Promise<T>;
}

/**
 * Allocates an isolated `SIMLOCK_HOME`, wires the fake driver in, and returns a
 * `TestEnv`. Registers itself with the module-level `activeEnvs` registry so the one
 * real `afterEach` above tears it down at the end of the current test: kills any
 * backgrounded CLI/MCP processes this env spawned, gracefully stops the daemon, then
 * verifies the pids that were observed holding the socket before that stop actually
 * exited (not just that the socket file is gone -- see `isProcessAlive`),
 * force-killing and failing the test if any survived. It does not independently
 * assert lease/device state is clean on exit; a flow that cares about that asserts
 * it itself (e.g. `waitForLeaseCount(env, 0)`).
 */
export async function withDaemon(options: WithDaemonOptions = {}): Promise<TestEnv> {
  const { testEnv, state } = await buildEnv(options);
  activeEnvs.add(state);
  return testEnv;
}

function processEnv(
  options: WithDaemonOptions,
  home: string,
  scriptPath: string,
  logCallPath: string,
): NodeJS.ProcessEnv {
  const useFakeDriver = options.driver === undefined || options.driver === "fake";
  return {
    ...process.env,
    SIMLOCK_HOME: home,
    ...(useFakeDriver
      ? {
          SIMLOCK_DRIVERS_MODULE: FAKE_DRIVER_MODULE,
          SIMLOCK_FAKE_DRIVER_SCRIPT: scriptPath,
          SIMLOCK_FAKE_DRIVER_LOG: logCallPath,
          ...(options.fakeDriverPlatforms === undefined
            ? {}
            : { SIMLOCK_FAKE_DRIVER_PLATFORMS: options.fakeDriverPlatforms.join(",") }),
        }
      : {}),
    ...(options.agentId === undefined ? {} : { SIMLOCK_AGENT_ID: options.agentId }),
  };
}

function seedConfig(
  options: WithDaemonOptions,
  adbServerPort: number | undefined,
): Record<string, unknown> | undefined {
  if (options.driver === undefined || options.driver === "fake") {
    return mergeDeep(FAKE_LANE_BASE_CONFIG, options.configOverrides ?? {});
  }
  if (options.driver === "real") {
    return mergeDeep({ drivers: { android: { adbServerPort } } }, options.configOverrides ?? {});
  }
  return options.configOverrides;
}

async function buildEnv(
  options: WithDaemonOptions,
): Promise<{ testEnv: TestEnv; state: TeardownState }> {
  const home = await mkdtemp(join(tmpdir(), "simlock-e2e-"));
  const gatewayFlag: readonly string[] = options.role === "gateway" ? ["--gateway"] : [];
  const dataDirectory = options.role === "gateway" ? join(home, "gateway") : home;
  const socketPath = join(dataDirectory, "daemon.sock");
  const logPath = join(dataDirectory, "daemon.log");
  const configPath = join(dataDirectory, "config.json");
  const scriptPath = join(home, "fake-driver-script.json");
  const logCallPath = join(home, "fake-driver-calls.jsonl");

  const env = processEnv(options, home, scriptPath, logCallPath);

  const adbServerPort = options.driver === "real" ? await freeLoopbackPort() : undefined;
  const seededConfig = seedConfig(options, adbServerPort);
  if (seededConfig !== undefined) {
    await mkdir(dataDirectory, { recursive: true });
    await writeFile(configPath, `${JSON.stringify(seededConfig, null, 2)}\n`, "utf8");
  }

  const backgroundProcesses = new Set<CliBackgroundHandle>();
  const mcpClients = new Set<McpClientHandle>();

  const testEnv: TestEnv = {
    adbServerPort,
    home,
    dataDirectory,
    socketPath,
    logPath,
    configPath,
    env,
    driverScript: driverScriptControl(scriptPath),
    driverLog: driverLogControl(logCallPath),
    cli: (args, cliOptions) => cli([...gatewayFlag, ...args], env, cliOptions),
    cliBackground: (args, cliOptions) => {
      const handle = cliBackground([...gatewayFlag, ...args], env, cliOptions);
      backgroundProcesses.add(handle);
      return handle;
    },
    mcpClient: async (mcpOptions) => {
      const handle = await mcpClient(env, {
        ...mcpOptions,
        ...(options.role === "gateway" ? { gateway: true } : {}),
      });
      mcpClients.add(handle);
      return handle;
    },
    events: (since, timeout) => events(env, since, timeout, gatewayFlag),
    expectEvents: (names, expectOptions) => expectEvents(env, names, expectOptions, gatewayFlag),
    async startDaemon() {
      const started = await cli([...gatewayFlag, "daemon", "start"], env);
      // why: `daemon start` exits once the daemon answers `status.get`, which it does from its socket
      // claim on, but the daemon writes `admin.token` only after that claim (ADR 0003 §5). A CLI
      // that reads the file before it lands connects as agent, so an admin command run next
      // (`token create`, the teardown's `daemon stop`) fails FORBIDDEN. After a first start,
      // waiting for the file orders later CLI calls after the write; after a restart the previous
      // run's file may still be there and passes the wait at once. A daemon that stops right after
      // its claim (its HTTP port taken, `withHttpDaemon`) removes the file with its socket
      // (`AdminSecretManager#remove`) before this poll can see it, so a gone socket ends the wait too.
      if (started.code === 0) {
        await waitFor(
          () => existsSync(join(dataDirectory, "admin.token")) || !existsSync(socketPath),
          {
            label: "admin.token written",
          },
        );
      }
      return started;
    },
    async restartDaemon() {
      // Wait for the *process* to actually exit, not just its socket file to
      // disappear -- `daemon.stop()` unlinks the socket as part of shutdown, which
      // can land slightly before the process fully drains its event loop. Starting
      // a new daemon while the old one is still mid-exit leaks daemon processes.
      const pidsBeforeStop = await pidsHoldingSocket(socketPath);
      await cli([...gatewayFlag, "daemon", "stop"], env);
      await waitFor(() => !existsSync(socketPath), {
        timeout: 10_000,
        label: "daemon socket removed",
      });
      // Best-effort: under heavy system load a still-exiting process can
      // legitimately take a while. This only reduces the ordinary-case race, so a
      // timeout here must not abort the restart itself.
      await waitFor(
        async () => {
          const stillAlive = await Promise.all(pidsBeforeStop.map((pid) => isProcessAlive(pid)));
          return !stillAlive.some(Boolean);
        },
        { timeout: 10_000, label: "previous daemon process actually exited" },
      ).catch(() => undefined);
      await testEnv.startDaemon();
    },
    async killDaemon(signal: NodeJS.Signals = "SIGKILL") {
      const pids = await pidsHoldingSocket(socketPath);
      for (const pid of pids) {
        try {
          process.kill(pid, signal);
        } catch {
          // Already gone.
        }
      }
      await waitFor(async () => (await pidsHoldingSocket(socketPath)).length === 0, {
        timeout: 10_000,
        label: "daemon process exited after signal",
      });
    },
    async withConfig(overrides, fn) {
      const previous = existsSync(configPath) ? await readFileIfExists(configPath) : undefined;
      const merged = mergeDeep(
        previous === undefined ? {} : (JSON.parse(previous) as Record<string, unknown>),
        overrides,
      );
      await writeFile(configPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
      await testEnv.restartDaemon();
      try {
        return await fn();
      } finally {
        if (previous === undefined) await rm(configPath, { force: true });
        else await writeFile(configPath, previous, "utf8");
        await testEnv.restartDaemon();
      }
    },
  };

  if (options.driverScript !== undefined) {
    await testEnv.driverScript.set(options.driverScript);
  }

  try {
    if (options.mode !== "auto") await testEnv.startDaemon();
  } catch (error: unknown) {
    await teardown({
      backgroundProcesses,
      dataDirectory,
      env,
      gatewayFlag,
      home,
      mcpClients,
      realDrivers: options.driver === "real",
      socketPath,
    });
    throw error;
  }

  return {
    testEnv,
    state: {
      backgroundProcesses,
      dataDirectory,
      env,
      gatewayFlag,
      home,
      mcpClients,
      realDrivers: options.driver === "real",
      socketPath,
    },
  };
}

export interface SharedTestEnv extends TestEnv {
  readonly httpPort: number;
  teardown(): Promise<void>;
  restart(): Promise<void>;
}

export async function withSharedDaemon(options: WithDaemonOptions = {}): Promise<SharedTestEnv> {
  const port = (options.configOverrides?.http as { port?: unknown } | undefined)?.port;
  if (typeof port !== "number") {
    throw new Error("withSharedDaemon needs configOverrides.http.port");
  }
  const { testEnv, state } = await buildEnv(options);
  const restartSteps = async (): Promise<void> => {
    const pids = await pidsHoldingSocket(state.socketPath);
    await cli([...state.gatewayFlag, "daemon", "stop"], state.env, { timeout: 30_000 });
    await waitFor(
      async () => !(await Promise.all(pids.map((pid) => isProcessAlive(pid)))).some(Boolean),
      { timeout: 30_000, label: "previous daemon process exited" },
    );
    await testEnv.startDaemon();
  };
  const restart = async (): Promise<void> => {
    let timer: NodeJS.Timeout | undefined;
    const limit = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("shared daemon restart exceeded 90 s")), 90_000);
    });
    try {
      await Promise.race([restartSteps(), limit]);
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    ...testEnv,
    httpPort: port,
    restart,
    async withConfig(overrides, fn) {
      const previous = await readFileIfExists(testEnv.configPath);
      const merged = mergeDeep(
        previous === undefined ? {} : (JSON.parse(previous) as Record<string, unknown>),
        overrides,
      );
      await writeFile(testEnv.configPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
      await restart();
      try {
        return await fn();
      } finally {
        if (previous === undefined) await rm(testEnv.configPath, { force: true });
        else await writeFile(testEnv.configPath, previous, "utf8");
        await restart();
      }
    },
    async teardown() {
      // why: read before teardown deletes the home.
      const simulatorsPid = await readAgentDevicePid(state.dataDirectory, "agent-device");
      const phonesPid = await readAgentDevicePid(state.dataDirectory, "agent-device-phones");
      const resolved = await realpath(state.dataDirectory).catch(() => state.dataDirectory);
      try {
        await teardown(state);
      } finally {
        await killLeftoverAgentDevice(resolved, simulatorsPid, "");
        await killLeftoverAgentDevice(resolved, phonesPid, " --simlock-role=phones");
      }
    },
  };
}

interface TeardownState {
  readonly backgroundProcesses: ReadonlySet<CliBackgroundHandle>;
  readonly dataDirectory: string;
  readonly env: NodeJS.ProcessEnv;
  readonly gatewayFlag: readonly string[];
  readonly home: string;
  readonly mcpClients: ReadonlySet<McpClientHandle>;
  /**
   * The real-SDK lane: the home may hold a real iOS device set, which must be emptied before
   * the home is removed. An Android-only or non-macOS run has none; emptying it is a no-op.
   */
  readonly realDrivers: boolean;
  readonly socketPath: string;
}

interface DaemonStopResult {
  readonly pidDiscoveryFailed?: boolean;
  readonly pidsBeforeStop: readonly number[];
  readonly stopError?: unknown;
}

interface PidDiscoveryResult {
  readonly error?: unknown;
  readonly pids: number[];
}

async function teardown(state: TeardownState): Promise<void> {
  const { backgroundProcesses, env, gatewayFlag, home, mcpClients, realDrivers, socketPath } =
    state;
  for (const client of mcpClients) {
    await client.close().catch(() => undefined);
  }
  for (const handle of backgroundProcesses) {
    handle.kill("SIGKILL");
  }
  await Promise.all([...backgroundProcesses].map((handle) => handle.waitForExit(10_000)));

  const stopResult = await stopDaemonForTeardown(socketPath, env, gatewayFlag);
  const strayPids = await killAndVerifyDaemonPids(socketPath, stopResult.pidsBeforeStop);

  if (stopResult.pidDiscoveryFailed) {
    throw (
      stopResult.stopError ??
      new Error(`could not verify daemon process ownership for ${socketPath}`)
    );
  }

  // why: a timed-out test may still be running and writing into its simulator home
  if (realDrivers) await emptyDeviceSet(iosDeviceSet(home));
  await rm(home, { force: true, recursive: true });

  if (stopResult.stopError !== undefined) throw stopResult.stopError;
  if (strayPids.length > 0) {
    throw new Error(
      `withDaemon teardown found stray daemon process(es) that outlived \`daemon stop\` for ${socketPath}: ${strayPids.join(", ")}`,
    );
  }
}

async function stopDaemonForTeardown(
  socketPath: string,
  env: NodeJS.ProcessEnv,
  gatewayFlag: readonly string[],
): Promise<DaemonStopResult> {
  // Capture who (if anyone) is holding the socket *before* the graceful stop, so
  // we can verify those specific pids actually exit -- checking only "is the
  // socket file still there" after `daemon stop` would miss a process that
  // unlinked its socket on the way out but never actually terminated.
  const discovery = await discoverDaemonPids(socketPath);
  const stopError = await requestDaemonStop(socketPath, env, gatewayFlag, discovery);
  const socketError = await waitForDaemonSocketRemoval(socketPath, discovery);
  return {
    pidDiscoveryFailed: discovery.error !== undefined,
    pidsBeforeStop: discovery.pids,
    stopError: discovery.error ?? stopError ?? socketError,
  };
}

async function discoverDaemonPids(socketPath: string): Promise<PidDiscoveryResult> {
  try {
    return { pids: await pidsHoldingSocket(socketPath) };
  } catch (error: unknown) {
    return { error, pids: [] };
  }
}

async function requestDaemonStop(
  socketPath: string,
  env: NodeJS.ProcessEnv,
  gatewayFlag: readonly string[],
  discovery: PidDiscoveryResult,
): Promise<unknown> {
  if (!existsSync(socketPath) || (discovery.pids.length === 0 && discovery.error === undefined)) {
    return undefined;
  }
  try {
    const stopped = await cli([...gatewayFlag, "daemon", "stop"], env);
    return stopped.code === 0
      ? undefined
      : new Error(`daemon stop failed before teardown of ${socketPath}: ${stopped.stderr}`);
  } catch (error: unknown) {
    return error;
  }
}

async function waitForDaemonSocketRemoval(
  socketPath: string,
  discovery: PidDiscoveryResult,
): Promise<unknown> {
  if (discovery.pids.length === 0 && discovery.error === undefined) return undefined;
  try {
    await waitFor(() => !existsSync(socketPath), {
      timeout: 5_000,
      label: "daemon socket removed during teardown",
    });
    return undefined;
  } catch (error: unknown) {
    return error;
  }
}

async function killAndVerifyDaemonPids(
  socketPath: string,
  pidsBeforeStop: readonly number[],
): Promise<number[]> {
  // A process can keep running for a little while after its socket is unlinked
  // (event-loop drain, especially under load) -- give `pidsBeforeStop` a real grace
  // window rather than a single point-in-time check, so a merely-slow exit is not
  // mistaken for a genuine leak.
  try {
    await waitFor(
      async () => {
        const alive = await Promise.all(pidsBeforeStop.map((pid) => isProcessAlive(pid)));
        return !alive.some(Boolean);
      },
      { timeout: 20_000, interval: 100 },
    );
  } catch (error: unknown) {
    if (!(error instanceof Error && error.message.startsWith("waitFor timed out after 20000ms"))) {
      throw error;
    }
  }

  const stillHoldingSocket = await pidsHoldingSocket(socketPath);
  const stillAlive = (
    await Promise.all(
      pidsBeforeStop.map(async (pid) => ((await isProcessAlive(pid)) ? pid : undefined)),
    )
  ).filter((pid): pid is number => pid !== undefined);
  const strayPids = [...new Set([...stillHoldingSocket, ...stillAlive])];
  for (const pid of strayPids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  await waitFor(
    async () => !(await Promise.all(strayPids.map((pid) => isProcessAlive(pid)))).some(Boolean),
    { timeout: 10_000, interval: 100, label: "stray daemon processes exited" },
  );

  return strayPids;
}

async function readAgentDevicePid(home: string, stem: string): Promise<number | undefined> {
  const text = await readFileIfExists(join(home, `${stem}-daemon.json`));
  if (text === undefined) return undefined;
  try {
    const record = JSON.parse(text) as { pid?: unknown };
    return typeof record.pid === "number" ? record.pid : undefined;
  } catch {
    return undefined;
  }
}

async function killLeftoverAgentDevice(
  home: string,
  pid: number | undefined,
  roleSuffix: string,
): Promise<void> {
  if (pid === undefined || !(await isProcessAlive(pid))) return;
  const { stdout } = await execFileAsync("ps", ["-ww", "-o", "args=", "-p", String(pid)]).catch(
    () => ({ stdout: "" }),
  );
  // why: the supervisor puts the resolved home in the marker; the caller resolved it before the home was removed.
  const marker = `--simlock-home=${home}${roleSuffix}`;
  if (!stdout.trim().endsWith(marker)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // why: the process may have exited since the check.
  }
}

/**
 * Signal-0 liveness probe: sends no actual signal, just asks the kernel whether
 * `pid` exists and is ours to signal. Throws ESRCH (gone) or EPERM (exists, not
 * ours -- treated as alive since it did not exit) otherwise.
 */
async function isProcessAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Finds pids with an open file descriptor on `socketPath` (macOS/Linux via lsof). */
async function pidsHoldingSocket(socketPath: string): Promise<number[]> {
  if (!existsSync(socketPath)) return [];
  try {
    const { stdout } = await execFileAsync("lsof", ["-t", socketPath]);
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .map(Number)
      .filter((pid) => Number.isInteger(pid));
  } catch (error: unknown) {
    const failure = error as NodeJS.ErrnoException & { stderr?: string };
    if (
      String(failure.code) === "1" &&
      (!failure.stderr?.trim() || failure.stderr.includes("No such file or directory"))
    ) {
      return [];
    }
    throw error;
  }
}

async function readFileIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

function mergeDeep(
  base: Record<string, unknown>,
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    const existing = result[key];
    result[key] =
      isPlainObject(value) && isPlainObject(existing) ? mergeDeep(existing, value) : value;
  }
  return result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
