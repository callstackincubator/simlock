import { execFile } from "node:child_process";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach } from "vitest";

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
import { mcpClient, type McpClientHandle, type McpClientOptions } from "./mcp.js";
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
   * "fake" (default) wires `SIMLOCK_DRIVERS_MODULE` at the scriptable out-of-process
   * fake driver. "real" leaves driver discovery alone -- the daemon finds the real
   * iOS/Android drivers exactly as it would in production -- for the slow, real-SDK
   * lane; `driverScript`/`driverLog` are inert in that mode (nothing reads them).
   * "none" wires no driver and seeds no driver-shaped config at all: what a
   * `mode: "gateway"` daemon needs, since it starts no drivers and warns about every
   * worker-only key it is given (ADR 0005 §2).
   */
  readonly driver?: "fake" | "real" | "none";
}

export interface TestEnv {
  readonly home: string;
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
  events(since?: string): Promise<RecordedEvent[]>;
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
  const home = await mkdtemp(join(tmpdir(), "simlock-e2e-"));
  const socketPath = join(home, "daemon.sock");
  const logPath = join(home, "daemon.log");
  const configPath = join(home, "config.json");
  const scriptPath = join(home, "fake-driver-script.json");
  const logCallPath = join(home, "fake-driver-calls.jsonl");

  const useFakeDriver = options.driver === undefined || options.driver === "fake";
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SIMLOCK_HOME: home,
    ...(useFakeDriver
      ? {
          SIMLOCK_DRIVERS_MODULE: FAKE_DRIVER_MODULE,
          SIMLOCK_FAKE_DRIVER_SCRIPT: scriptPath,
          SIMLOCK_FAKE_DRIVER_LOG: logCallPath,
        }
      : {}),
    ...(options.agentId === undefined ? {} : { SIMLOCK_AGENT_ID: options.agentId }),
  };

  const adbServerPort = options.driver === "real" ? await freeLoopbackPort() : undefined;
  const seededConfig = useFakeDriver
    ? mergeDeep(FAKE_LANE_BASE_CONFIG, options.configOverrides ?? {})
    : options.driver === "real"
      ? mergeDeep({ drivers: { android: { adbServerPort } } }, options.configOverrides ?? {})
      : (options.configOverrides ?? {});
  if (seededConfig !== undefined) {
    await writeFile(configPath, `${JSON.stringify(seededConfig, null, 2)}\n`, "utf8");
  }

  const backgroundProcesses = new Set<CliBackgroundHandle>();
  const mcpClients = new Set<McpClientHandle>();

  const testEnv: TestEnv = {
    adbServerPort,
    home,
    socketPath,
    logPath,
    configPath,
    env,
    driverScript: driverScriptControl(scriptPath),
    driverLog: driverLogControl(logCallPath),
    cli: (args, cliOptions) => cli(args, env, cliOptions),
    cliBackground: (args, cliOptions) => {
      const handle = cliBackground(args, env, cliOptions);
      backgroundProcesses.add(handle);
      return handle;
    },
    mcpClient: async (mcpOptions) => {
      const handle = await mcpClient(env, mcpOptions);
      mcpClients.add(handle);
      return handle;
    },
    events: (since) => events(env, since),
    expectEvents: (names, expectOptions) => expectEvents(env, names, expectOptions),
    async startDaemon() {
      return cli(["daemon", "start"], env);
    },
    async restartDaemon() {
      // Wait for the *process* to actually exit, not just its socket file to
      // disappear -- `daemon.stop()` unlinks the socket as part of shutdown, which
      // can land slightly before the process fully drains its event loop. Starting
      // a new daemon while the old one is still mid-exit was a real, reproduced
      // source of leaked daemon processes (see the module doc above `activeEnvs`).
      const pidsBeforeStop = await pidsHoldingSocket(socketPath);
      await cli(["daemon", "stop"], env);
      await waitFor(() => !existsSync(socketPath), {
        timeout: 10_000,
        label: "daemon socket removed",
      });
      // Best-effort: under heavy system load a still-exiting process can
      // legitimately take a while, and `teardown()`'s own grace-period check is the
      // real backstop for a genuine leak -- this just reduces (not guarantees
      // against) the ordinary-case race, so a timeout here must not abort the
      // restart itself.
      await waitFor(
        async () => {
          const stillAlive = await Promise.all(pidsBeforeStop.map((pid) => isProcessAlive(pid)));
          return !stillAlive.some(Boolean);
        },
        { timeout: 10_000, label: "previous daemon process actually exited" },
      ).catch(() => undefined);
      await cli(["daemon", "start"], env);
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

  if (options.mode !== "auto") {
    await testEnv.startDaemon();
  }

  activeEnvs.add({ backgroundProcesses, env, home, mcpClients, socketPath });
  return testEnv;
}

interface TeardownState {
  readonly backgroundProcesses: ReadonlySet<CliBackgroundHandle>;
  readonly env: NodeJS.ProcessEnv;
  readonly home: string;
  readonly mcpClients: ReadonlySet<McpClientHandle>;
  readonly socketPath: string;
}

async function teardown(state: TeardownState): Promise<void> {
  const { backgroundProcesses, env, home, mcpClients, socketPath } = state;
  for (const client of mcpClients) {
    await client.close().catch(() => undefined);
  }
  for (const handle of backgroundProcesses) {
    handle.kill("SIGKILL");
  }
  await Promise.all(
    [...backgroundProcesses].map((handle) => handle.waitForExit(10_000).catch(() => undefined)),
  );

  // Capture who (if anyone) is holding the socket *before* the graceful stop, so
  // we can verify those specific pids actually exit -- checking only "is the
  // socket file still there" after `daemon stop` would miss a process that
  // unlinked its socket on the way out but never actually terminated.
  const pidsBeforeStop = await pidsHoldingSocket(socketPath);
  await cli(["daemon", "stop"], env).catch(() => undefined);
  await waitFor(() => !existsSync(socketPath), { timeout: 5_000 }).catch(() => undefined);

  // A process can keep running for a little while after its socket is unlinked
  // (event-loop drain, especially under load) -- give `pidsBeforeStop` a real grace
  // window rather than a single point-in-time check, so a merely-slow exit is not
  // mistaken for a genuine leak.
  await waitFor(
    async () => {
      const alive = await Promise.all(pidsBeforeStop.map((pid) => isProcessAlive(pid)));
      return !alive.some(Boolean);
    },
    { timeout: 20_000, interval: 100 },
  ).catch(() => undefined);

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

  await rm(home, { force: true, recursive: true });

  if (strayPids.length > 0) {
    throw new Error(
      `withDaemon teardown found stray daemon process(es) that outlived \`daemon stop\` for ${socketPath}: ${strayPids.join(", ")}`,
    );
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
  } catch {
    // lsof exits non-zero when nothing holds the file, or may be unavailable.
    return [];
  }
}

async function readFileIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Binds an ephemeral loopback port and immediately releases it. Inherently racy -- nothing
 * stops another process taking it in between -- but it is the only way to pick a port no
 * other test env on this machine is already using, and the alternative (a fixed port) fails
 * every parallel run rather than an unlucky one.
 */
export async function freeLoopbackPort(): Promise<number> {
  const server = createServer();
  try {
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        resolve(typeof address === "object" && address !== null ? address.port : 0);
      });
    });
    return port;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
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
