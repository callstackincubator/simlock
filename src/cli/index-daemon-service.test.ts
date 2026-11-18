import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FakeClock,
  FakeDaemonLauncher,
  FakeServiceManager,
  IpcError,
  launcherFor,
  LaunchdServiceManager,
  ScriptedProcessRunner,
  MemoryFilesystem,
  MemoryIpcTransport,
  resolveDaemonSocketPath,
  serviceDefinition,
  type ServiceState,
  FakeSystemStats,
} from "../ports/index.js";
import { SimlockError } from "../contract/index.js";
import { runCli, type CliEnvironment, type CliEnvironmentPorts } from "./index.js";
import {
  fakeClient,
  gibibyte,
  outputCapture,
  runningDaemons,
  settle,
  startInMemoryDaemon,
  temporaryDirectories,
} from "./test-index.js";

afterEach(async () => {
  await Promise.all(runningDaemons.splice(0).map((daemon) => daemon.stop("test")));
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("CLI: daemon install (#830)", () => {
  const home = "/Users/me";
  const nodePath = "/opt/node/bin/node";
  const mainPath = "/opt/simlock/dist/daemon/main.js";

  async function install(options: {
    readonly argv: readonly string[];
    readonly role: "worker" | "gateway";
    readonly root: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly linux?: boolean;
    readonly user?: () => string;
  }): Promise<{
    readonly exitCode: number;
    readonly output: ReturnType<typeof outputCapture>;
    readonly serviceManager: FakeServiceManager;
  }> {
    const { root } = options;
    const dataDirectory = options.role === "gateway" ? join(root, "gateway") : root;
    const filesystem = new MemoryFilesystem();
    const ipcTransport = new MemoryIpcTransport();
    const serviceManager = new FakeServiceManager({
      ...(options.linux === true ? { manager: "systemd" as const } : {}),
      onInstall: async () => {
        await startInMemoryDaemon({
          adminTokenPath: join(dataDirectory, "admin.token"),
          filesystem,
          ipcTransport,
          socketPath: resolveDaemonSocketPath(dataDirectory),
        });
      },
    });
    const output = outputCapture(
      {
        filesystem,
        clock: new FakeClock(0),
        systemStats: new FakeSystemStats({ cpuCount: 8, totalRamBytes: 32 * gibibyte }),
        ipc: ipcTransport,
        launcher: new FakeDaemonLauncher(),
        daemonHome: { role: options.role, dataDirectory, gatewayPresent: false },
        homeDirectory: "/home/operator",
        workingDirectory: "/work/project",
        // why: the CLI looks for the daemon at the endpoint of its host platform, and this daemon listens on the one the host gives (a pipe on Windows).
        hostPlatform: process.platform,
        runTool: async () => ({ outcome: "not-found" }),
        service: {
          manager: serviceManager,
          platform: options.linux === true ? "linux" : "darwin",
          home: options.linux === true ? "/home/me" : home,
          user: options.user ?? (() => "me"),
          root,
          nodePath,
          mainPath,
        },
      },
      options.env,
    );
    const exitCode = await runCli(options.argv, output.environmentWith());
    return { exitCode, output, serviceManager };
  }

  it("an operator runs daemon install on macOS: the service is installed, the daemon answers, install prints the name, Daemon running and the hint, and --json prints the status and service", async () => {
    const cases = [
      {
        label: "worker, default home",
        argv: ["daemon", "install"],
        role: "worker" as const,
        root: join(home, ".simlock"),
        name: "com.callstack.simlock.worker",
        args: [mainPath],
        logPath: join(home, ".simlock", "daemon.log"),
      },
      {
        label: "gateway on a host with no gateway folder yet",
        argv: ["--gateway", "daemon", "install"],
        role: "gateway" as const,
        root: join(home, ".simlock"),
        name: "com.callstack.simlock.gateway",
        args: [mainPath, "--gateway"],
        logPath: join(home, ".simlock", "gateway", "daemon.log"),
      },
      {
        label: "another SIMLOCK_HOME",
        argv: ["daemon", "install"],
        role: "worker" as const,
        root: "/tmp/x",
        name: "com.callstack.simlock.worker.2e56aa",
        args: [mainPath],
        logPath: join("/tmp/x", "daemon.log"),
      },
    ];

    for (const testCase of cases) {
      const { exitCode, output, serviceManager } = await install(testCase);
      const label = testCase.label;
      expect(output.stderr, label).toBe("");
      expect(exitCode, label).toBe(0);
      expect(serviceManager.installs, label).toHaveLength(1);
      expect(serviceManager.installs[0], label).toMatchObject({
        name: testCase.name,
        path: join(home, "Library", "LaunchAgents", `${testCase.name}.plist`),
        command: nodePath,
        args: testCase.args,
        logPath: testCase.logPath,
      });
      expect(output.stdout.split("\n").slice(0, 2), label).toEqual([
        `Service installed: ${testCase.name} (launchd)`,
        "Daemon running",
      ]);
      expect(output.stdout.trimEnd().split("\n").at(-1), label).toBe(
        "To start after a reboot, turn on automatic login for this user.",
      );
    }

    const withShell = await install({
      argv: ["daemon", "install"],
      role: "worker",
      root: join(home, ".simlock"),
      env: { PATH: "/opt/bin:/usr/bin", JAVA_HOME: "/jdk", SIMLOCK_ADMIN_TOKEN: "secret" },
    });
    expect(withShell.exitCode, withShell.output.stderr).toBe(0);
    expect(withShell.serviceManager.installs[0]?.environment).toEqual({
      SIMLOCK_HOME: join(home, ".simlock"),
      PATH: "/opt/bin:/usr/bin",
      JAVA_HOME: "/jdk",
    });

    const json = await install({
      argv: ["daemon", "install", "--json"],
      role: "worker",
      root: join(home, ".simlock"),
    });
    expect(json.exitCode).toBe(0);
    expect(JSON.parse(json.output.stdout)).toEqual({
      status: "installed",
      service: {
        state: "installed",
        manager: "launchd",
        name: "com.callstack.simlock.worker",
        path: join(home, "Library", "LaunchAgents", "com.callstack.simlock.worker.plist"),
      },
    });
  });

  it("an operator on Linux runs daemon install: the unit lands in the user config directory, and install prints systemd and the linger hint", async () => {
    const cases = [
      {
        label: "default config directory",
        env: {},
        unit: join(
          "/home/me",
          ".config",
          "systemd",
          "user",
          "com.callstack.simlock.worker.service",
        ),
      },
      {
        label: "absolute XDG_CONFIG_HOME",
        env: { XDG_CONFIG_HOME: "/xdg" },
        unit: join("/xdg", "systemd", "user", "com.callstack.simlock.worker.service"),
      },
    ];
    for (const { label, env, unit } of cases) {
      const { exitCode, output, serviceManager } = await install({
        argv: ["daemon", "install"],
        role: "worker",
        root: join("/home/me", ".simlock"),
        env,
        linux: true,
      });

      expect(output.stderr, label).toBe("");
      expect(exitCode, label).toBe(0);
      expect(serviceManager.installs[0]?.path, label).toBe(unit);
      expect(output.stdout.split("\n").slice(0, 2), label).toEqual([
        "Service installed: com.callstack.simlock.worker (systemd)",
        "Daemon running",
      ]);
      expect(output.stdout.trimEnd().split("\n").at(-1), label).toBe(
        "To start after a reboot without logging in, run: loginctl enable-linger me",
      );
    }

    // why: a uid with no passwd entry makes the user lookup throw; install must still succeed.
    const unknownUser = (): string => {
      throw new Error("ENOENT: no passwd entry for uid 1234");
    };
    const lookupFails = await install({
      argv: ["daemon", "install"],
      role: "worker",
      root: join("/home/me", ".simlock"),
      linux: true,
      user: unknownUser,
    });
    expect(lookupFails.output.stderr).toBe("");
    expect(lookupFails.exitCode).toBe(0);
    expect(lookupFails.output.stdout.trimEnd().split("\n").at(-1)).toBe(
      "To start after a reboot without logging in, run: loginctl enable-linger <user>",
    );
  });

  async function runWithService(options: {
    readonly argv: readonly string[];
    readonly running: boolean;
    readonly socketHeldPolls: number;
    readonly state?: ServiceState;
    readonly refuse?: boolean;
  }): Promise<{
    readonly exitCode: number;
    readonly output: ReturnType<typeof outputCapture>;
    readonly stops: number;
    readonly serviceManager: FakeServiceManager;
    readonly clock: FakeClock;
  }> {
    const root = join(home, ".simlock");
    const clock = new FakeClock(0);
    const serviceManager = new FakeServiceManager(
      options.state === undefined ? {} : { state: options.state },
    );
    let stops = 0;
    let polls = 0;
    const connectExistingAdmin: CliEnvironment["connectExistingAdmin"] = async (
      resolveCredential,
    ) => {
      await resolveCredential();
      if (!options.running)
        throw new IpcError("endpoint-not-found", "No IPC endpoint yet", undefined);
      if (options.refuse === true) {
        throw new SimlockError("FORBIDDEN", "protocol", "The admin token was rejected", {});
      }
      // why: a stopping daemon refuses new connections while it still holds its socket.
      if (stops > 0) throw new IpcError("connection-refused", "Connection refused", undefined);
      return fakeClient({
        stopDaemon: async () => {
          stops += 1;
          return { stopping: true };
        },
      });
    };
    const output = outputCapture();
    const environment = output.environmentWith({
      clock,
      daemonHome: { role: "worker", dataDirectory: root, gatewayPresent: false },
      connectExistingAdmin,
      daemonEndpointPresent: async () => {
        if (stops === 0) return options.running;
        polls += 1;
        return polls <= options.socketHeldPolls;
      },
      readAdminTokenFile: async () => "admin-token",
      sleep: async (milliseconds) => {
        clock.advance(milliseconds);
      },
      service: {
        manager: serviceManager,
        platform: "darwin",
        user: () => "me",
        definition: async () =>
          serviceDefinition({
            role: "worker",
            root,
            dataDirectory: root,
            home,
            nodePath,
            mainPath,
            env: {},
          }),
      },
    });
    const exitCode = await runCli(options.argv, environment);
    return { exitCode, output, stops, serviceManager, clock };
  }

  it('daemon stop with no socket exits 0 and prints Daemon not running; with --json it prints {"status":"not-running"}', async () => {
    const text = await runWithService({
      argv: ["daemon", "stop"],
      running: false,
      socketHeldPolls: 0,
    });
    expect(text.output.stderr).toBe("");
    expect(text.exitCode).toBe(0);
    expect(text.output.stdout).toBe("Daemon not running\n");

    const json = await runWithService({
      argv: ["daemon", "stop", "--json"],
      running: false,
      socketHeldPolls: 0,
    });
    expect(json.output.stderr).toBe("");
    expect(json.exitCode).toBe(0);
    expect(JSON.parse(json.output.stdout)).toEqual({ status: "not-running" });
  });

  it("daemon uninstall removes the service", async () => {
    const installedState: ServiceState = {
      state: "installed",
      path: "/Users/me/Library/LaunchAgents/com.callstack.simlock.worker.plist",
    };
    const name = "com.callstack.simlock.worker";
    const cases = [
      {
        label: "installed",
        argv: ["daemon", "uninstall"],
        state: installedState,
        stdout: `Service removed: ${name} (launchd)\n`,
        removed: 1,
      },
      {
        label: "installed, --json",
        argv: ["daemon", "uninstall", "--json"],
        state: installedState,
        json: { status: "removed", service: { state: "not-installed", manager: "launchd", name } },
        removed: 1,
      },
      {
        label: "installed, a daemon running, --json",
        argv: ["daemon", "uninstall", "--json"],
        state: installedState,
        running: true,
        json: {
          status: "removed",
          stopped: true,
          service: { state: "not-installed", manager: "launchd", name },
        },
        removed: 1,
      },
      {
        label: "installed, gateway flag, no gateway folder",
        argv: ["--gateway", "daemon", "uninstall"],
        state: installedState,
        stdout: `Service removed: ${name} (launchd)\n`,
        removed: 1,
      },
      {
        label: "not installed",
        argv: ["daemon", "uninstall"],
        state: { state: "not-installed" } as ServiceState,
        stdout: `Service not installed: ${name}\n`,
        removed: 0,
      },
      {
        label: "not installed, --json",
        argv: ["daemon", "uninstall", "--json"],
        state: { state: "not-installed" } as ServiceState,
        json: {
          status: "not-installed",
          service: { state: "not-installed", manager: "launchd", name },
        },
        removed: 0,
      },
    ];
    for (const testCase of cases) {
      const result = await runWithService({
        argv: testCase.argv,
        running: testCase.running ?? false,
        socketHeldPolls: 0,
        state: testCase.state,
      });
      expect(result.output.stderr, testCase.label).toBe("");
      expect(result.exitCode, testCase.label).toBe(0);
      expect(result.serviceManager.uninstalls, testCase.label).toHaveLength(testCase.removed);
      if (testCase.json === undefined)
        expect(result.output.stdout, testCase.label).toBe(testCase.stdout);
      else expect(JSON.parse(result.output.stdout), testCase.label).toEqual(testCase.json);
    }
  });

  it("daemon install stops a running daemon first and waits until its socket is released, even while it refuses connections", async () => {
    const none = await runWithService({
      argv: ["daemon", "install"],
      running: false,
      socketHeldPolls: 0,
    });
    expect(none.exitCode).toBe(0);
    expect(none.stops).toBe(0);
    expect(none.output.stdout).not.toContain("Stopped");

    const running = await runWithService({
      argv: ["daemon", "install"],
      running: true,
      socketHeldPolls: 3,
    });
    expect(running.exitCode).toBe(0);
    expect(running.stops).toBe(1);
    expect(running.output.stdout.split("\n").slice(0, 2)).toEqual([
      "Stopped the running daemon; leases are kept.",
      "Service installed: com.callstack.simlock.worker (launchd)",
    ]);

    const json = await runWithService({
      argv: ["daemon", "install", "--json"],
      running: true,
      socketHeldPolls: 0,
    });
    expect(JSON.parse(json.output.stdout)).toMatchObject({ status: "installed", stopped: true });

    const stubborn = await runWithService({
      argv: ["daemon", "install"],
      running: true,
      socketHeldPolls: Number.POSITIVE_INFINITY,
    });
    expect(stubborn.exitCode).toBe(1);
    expect(JSON.parse(stubborn.output.stderr)).toEqual({
      error: {
        code: "SERVICE_FAILED",
        message: "The running daemon did not stop within 300 s.",
      },
    });
    expect(stubborn.serviceManager.installs).toEqual([]);
    expect(stubborn.clock.now()).toBeGreaterThanOrEqual(300_000);
    expect(stubborn.clock.now()).toBeLessThan(301_000);

    const refused = await runWithService({
      argv: ["daemon", "install"],
      running: true,
      socketHeldPolls: 0,
      refuse: true,
    });
    expect(refused.exitCode).toBe(1);
    expect(JSON.parse(refused.output.stderr)).toEqual({
      error: { code: "FORBIDDEN", message: "The admin token was rejected" },
    });
    expect(refused.serviceManager.installs).toEqual([]);

    const uninstall = await runWithService({
      argv: ["daemon", "uninstall"],
      running: true,
      socketHeldPolls: 3,
      state: { state: "installed", path: "/Users/me/Library/LaunchAgents/x.plist" },
    });
    expect(uninstall.exitCode).toBe(0);
    expect(uninstall.stops).toBe(1);
    expect(uninstall.output.stdout.split("\n").slice(0, 2)).toEqual([
      "Daemon stopping",
      "Service removed: com.callstack.simlock.worker (launchd)",
    ]);
  });
});

describe("CLI: a start goes through the service (#830)", () => {
  it("daemon start and a command's auto-start ask a loaded service to start the daemon and spawn nothing", async () => {
    const home = "/Users/me";
    const root = join(home, ".simlock");
    const cases = [
      { label: "daemon start", argv: ["daemon", "start", "--json"] },
      { label: "a command's auto-start", argv: ["status", "--json"] },
    ];
    for (const testCase of cases) {
      const filesystem = new MemoryFilesystem();
      const ipcTransport = new MemoryIpcTransport();
      const serviceManager = new FakeServiceManager({
        state: { state: "installed", path: "/Users/me/Library/LaunchAgents/x.plist" },
        onStart: async () => {
          await startInMemoryDaemon({
            adminTokenPath: join(root, "admin.token"),
            filesystem,
            ipcTransport,
            socketPath: resolveDaemonSocketPath(root),
          });
        },
      });
      const spawner = new FakeDaemonLauncher(() => undefined, {
        exit: { code: 1, signal: null },
      });
      const notices: string[] = [];
      const output = outputCapture({
        filesystem,
        clock: new FakeClock(0),
        systemStats: new FakeSystemStats({ cpuCount: 8, totalRamBytes: 32 * gibibyte }),
        ipc: ipcTransport,
        launcher: launcherFor({
          role: "worker",
          root,
          dataDirectory: root,
          mainPath: "/opt/simlock/dist/daemon/main.js",
          nodePath: "/opt/node/bin/node",
          home,
          env: {},
          serviceManager,
          notify: (line) => notices.push(line),
          spawner,
        }),
        daemonHome: { role: "worker", dataDirectory: root, gatewayPresent: false },
        homeDirectory: "/home/operator",
        workingDirectory: "/work/project",
        // why: the CLI looks for the daemon at the endpoint of its host platform, and this daemon listens on the one the host gives (a pipe on Windows).
        hostPlatform: process.platform,
        runTool: async () => ({ outcome: "not-found" }),
      });

      const exitCode = await runCli(testCase.argv, output.environmentWith());

      expect(exitCode, testCase.label).toBe(0);
      expect(serviceManager.starts, testCase.label).toHaveLength(1);
      expect(serviceManager.starts[0]?.name, testCase.label).toBe("com.callstack.simlock.worker");
      expect(spawner.launches, testCase.label).toBe(0);
      expect(notices, testCase.label).toEqual([]);
    }
  });
});

describe("CLI: a start through a service that fails (#830)", () => {
  it("fails at the 20 s deadline with DAEMON_STARTUP_FAILED and the daemon.log lines written since the start", async () => {
    const startError =
      '{"message":"Daemon failed to start","fields":{"message":"EADDRINUSE: socket taken"}}\n';
    const cases = [
      { label: "the log holds the start error", written: startError, expected: "EADDRINUSE" },
      { label: "empty log", written: "", expected: undefined },
      {
        label: "25 lines: the last 20 are kept",
        written: Array.from({ length: 25 }, (_, index) => `line ${String(index + 1)}\n`).join(""),
        expected: "line 6\n",
        notExpected: "line 5\n",
      },
    ];
    for (const testCase of cases) {
      const directory = await mkdtemp(join(tmpdir(), "simlock-service-start-"));
      try {
        const logPath = join(directory, "daemon.log");
        await writeFile(logPath, "older line\n");
        const clock = new FakeClock(0);
        const serviceManager = new FakeServiceManager({
          state: { state: "installed", path: "/Users/me/Library/LaunchAgents/x.plist" },
          onStart: async () => {
            await appendFile(logPath, testCase.written);
          },
        });
        const output = outputCapture({
          filesystem: new MemoryFilesystem(),
          clock,
          systemStats: new FakeSystemStats({ cpuCount: 8, totalRamBytes: 32 * gibibyte }),
          ipc: new MemoryIpcTransport(),
          launcher: launcherFor({
            role: "worker",
            root: directory,
            dataDirectory: directory,
            mainPath: "/opt/simlock/dist/daemon/main.js",
            nodePath: "/opt/node/bin/node",
            home: "/Users/me",
            env: {},
            serviceManager,
            notify: () => undefined,
            spawner: new FakeDaemonLauncher(),
          }),
          daemonHome: { role: "worker", dataDirectory: directory, gatewayPresent: false },
          homeDirectory: "/home/operator",
          workingDirectory: "/work/project",
          hostPlatform: "linux",
          runTool: async () => ({ outcome: "not-found" }),
        });
        let settled = false;
        const exitCode = runCli(["daemon", "start", "--json"], output.environmentWith()).then(
          (code) => {
            settled = true;
            return code;
          },
        );
        // why: `settle` waits one timer tick, about 15 ms on Windows, so the clock moves in whole seconds to keep the 20 s deadline within a few hundred ticks.
        for (let tick = 0; tick < 40 && !settled; tick += 1) {
          clock.advance(1_000);
          await settle();
          await settle();
        }
        expect(settled, `${testCase.label}: not settled at ${String(clock.now())}ms`).toBe(true);
        expect(await exitCode, testCase.label).toBe(1);
        const error = (
          JSON.parse(output.stderr.trim().split("\n").at(-1) ?? "") as {
            error: { code: string; message: string };
          }
        ).error;
        expect(error.code, testCase.label).toBe("DAEMON_STARTUP_FAILED");
        expect(error.message, testCase.label).toContain("Timed out starting simlock daemon");
        expect(error.message, testCase.label).not.toContain("older line");
        if (testCase.expected === undefined) {
          expect(error.message, testCase.label).not.toContain("\n");
        } else {
          expect(error.message, testCase.label).toContain(testCase.expected);
        }
        if (testCase.notExpected !== undefined) {
          expect(error.message, testCase.label).not.toContain(testCase.notExpected);
        }
      } finally {
        await rm(directory, { force: true, recursive: true });
      }
    }
  });
});

describe("CLI: a service manager call fails, or the platform has none (#830)", () => {
  const home = "/Users/me";
  const root = join(home, ".simlock");
  const name = "com.callstack.simlock.worker";
  const plist = join(home, "Library", "LaunchAgents", `${name}.plist`);
  const nodePath = "/opt/node/bin/node";
  const mainPath = "/opt/simlock/dist/daemon/main.js";
  const done = (code: number | null, stderr = "") => ({ code, stdout: "", stderr });

  async function run(options: {
    readonly argv: readonly string[];
    readonly platform?: NodeJS.Platform;
    readonly script?: ConstructorParameters<typeof ScriptedProcessRunner>[0];
    readonly present?: readonly string[];
  }): Promise<{
    readonly exitCode: number;
    readonly stderr: string;
    readonly filesystem: MemoryFilesystem;
  }> {
    const filesystem = new MemoryFilesystem();
    for (const path of options.present ?? []) {
      await filesystem.mkdirp(dirname(path));
      await filesystem.writeFileAtomic(path, "");
    }
    const manager =
      options.script === undefined
        ? undefined
        : new LaunchdServiceManager({
            runner: new ScriptedProcessRunner(options.script),
            filesystem,
            uid: 501,
          });
    const ipc = new MemoryIpcTransport();
    const ports: CliEnvironmentPorts = {
      filesystem,
      clock: new FakeClock(0),
      systemStats: new FakeSystemStats({ cpuCount: 8, totalRamBytes: 32 * gibibyte }),
      ipc,
      launcher: launcherFor({
        role: "worker",
        root,
        dataDirectory: root,
        mainPath,
        nodePath,
        home,
        env: {},
        serviceManager: manager,
        notify: () => undefined,
        spawner: new FakeDaemonLauncher(() => undefined, { exit: { code: 1, signal: null } }),
      }),
      daemonHome: { role: "worker", dataDirectory: root, gatewayPresent: false },
      homeDirectory: "/home/operator",
      workingDirectory: "/work/project",
      hostPlatform: "linux",
      runTool: async () => ({ outcome: "not-found" }),
      service: {
        manager,
        platform: options.platform ?? "darwin",
        user: () => "me",
        home,
        root,
        nodePath,
        mainPath,
      },
    };
    const output = outputCapture(ports);
    const exitCode = await runCli(options.argv, output.environmentWith());
    return { exitCode, stderr: output.stderr, filesystem };
  }

  const errorOf = (stderr: string): { code: string; message: string } =>
    (
      JSON.parse(stderr.trim().split("\n").at(-1) ?? "") as {
        error: { code: string; message: string };
      }
    ).error;

  it("a failed or stuck launchctl call is SERVICE_FAILED, a failed load removes the plist, and a platform without a service manager is a usage error", async () => {
    for (const command of ["install", "uninstall"]) {
      const result = await run({ argv: ["daemon", command], platform: "win32" });
      expect(result.exitCode, `win32 ${command}`).toBe(2);
      expect(errorOf(result.stderr), `win32 ${command}`).toEqual({
        code: "USAGE",
        message: `daemon ${command} is supported on macOS and Linux only`,
      });
    }

    const bootout = {
      match: { command: "launchctl", args: ["bootout", `gui/501/${name}`] },
      result: done(113),
    };
    const bootstrap = { command: "launchctl", args: ["bootstrap", "gui/501", plist] };
    const failedLoad = await run({
      argv: ["daemon", "install"],
      script: [
        bootout,
        {
          match: bootstrap,
          result: done(5, "Bootstrap failed: 5: Input/output error\nsecond line"),
        },
      ],
    });
    expect(failedLoad.exitCode).toBe(1);
    expect(errorOf(failedLoad.stderr)).toEqual({
      code: "SERVICE_FAILED",
      message: `launchctl bootstrap gui/501 ${plist} failed: Bootstrap failed: 5: Input/output error`,
    });
    expect(await failedLoad.filesystem.exists(plist)).toBe(false);

    const stuckLoad = await run({
      argv: ["daemon", "install"],
      script: [bootout, { match: bootstrap, result: done(null) }],
    });
    expect(stuckLoad.exitCode).toBe(1);
    expect(errorOf(stuckLoad.stderr)).toEqual({
      code: "SERVICE_FAILED",
      message: `launchctl bootstrap gui/501 ${plist} did not finish within 10 s`,
    });
    expect(await stuckLoad.filesystem.exists(plist)).toBe(false);

    const failedKickstart = await run({
      argv: ["daemon", "start"],
      present: [plist, nodePath, mainPath],
      script: [
        {
          match: { command: "plutil", args: ["-convert", "json", "-o", "-", plist] },
          result: {
            code: 0,
            stdout: JSON.stringify({ ProgramArguments: [nodePath, mainPath] }),
            stderr: "",
          },
        },
        { match: { command: "launchctl", args: ["print", `gui/501/${name}`] }, result: done(0) },
        {
          match: { command: "launchctl", args: ["kickstart", `gui/501/${name}`] },
          result: done(1, "Could not find service"),
        },
      ],
    });
    expect(failedKickstart.exitCode).toBe(1);
    expect(errorOf(failedKickstart.stderr)).toEqual({
      code: "SERVICE_FAILED",
      message: `launchctl kickstart gui/501/${name} failed: Could not find service`,
    });
  });
});
