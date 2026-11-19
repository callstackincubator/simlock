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
  serviceDefinition,
  type ProcessResult,
  type ServiceManager,
  type ServiceState,
  TaskSchedulerServiceManager,
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
          socketPath: join(dataDirectory, "daemon.sock"),
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
        hostPlatform: "linux",
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
        logPath: "/Users/me/.simlock/daemon.log",
      },
      {
        label: "gateway on a host with no gateway folder yet",
        argv: ["--gateway", "daemon", "install"],
        role: "gateway" as const,
        root: join(home, ".simlock"),
        name: "com.callstack.simlock.gateway",
        args: [mainPath, "--gateway"],
        logPath: "/Users/me/.simlock/gateway/daemon.log",
      },
      {
        label: "another SIMLOCK_HOME",
        argv: ["daemon", "install"],
        role: "worker" as const,
        root: "/tmp/x",
        name: "com.callstack.simlock.worker.2e56aa",
        args: [mainPath],
        logPath: "/tmp/x/daemon.log",
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
        path: `/Users/me/Library/LaunchAgents/${testCase.name}.plist`,
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
        path: "/Users/me/Library/LaunchAgents/com.callstack.simlock.worker.plist",
      },
    });
  });

  it("an operator on Linux runs daemon install: the unit lands in the user config directory, and install prints systemd and the linger hint", async () => {
    const cases = [
      {
        label: "default config directory",
        env: {},
        unit: "/home/me/.config/systemd/user/com.callstack.simlock.worker.service",
      },
      {
        label: "absolute XDG_CONFIG_HOME",
        env: { XDG_CONFIG_HOME: "/xdg" },
        unit: "/xdg/systemd/user/com.callstack.simlock.worker.service",
      },
    ];
    for (const { label, env, unit } of cases) {
      const { exitCode, output, serviceManager } = await install({
        argv: ["daemon", "install"],
        role: "worker",
        root: "/home/me/.simlock",
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
      root: "/home/me/.simlock",
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

describe("CLI: daemon install with a config the CLI refuses (#1760)", () => {
  it("daemon install with a config.json the CLI refuses exits 2 with the config error and installs no service, on launchd, systemd and Task Scheduler", async () => {
    const managers = [
      { manager: "launchd", platform: "darwin" },
      { manager: "systemd", platform: "linux" },
      { manager: "task-scheduler", platform: "win32" },
    ] as const;
    const configs = [
      { label: "accepted", maxDevices: 2 },
      { label: "refused", maxDevices: 0 },
    ];
    for (const { manager, platform } of managers) {
      for (const { label: configLabel, maxDevices } of configs) {
        const label = `${manager}, ${configLabel} config`;
        const root = "/Users/me/.simlock";
        const filesystem = new MemoryFilesystem();
        await filesystem.mkdirp(root);
        await filesystem.writeFileAtomic(
          join(root, "config.json"),
          JSON.stringify({ capacity: { config: { limits: { android: { maxDevices } } } } }),
        );
        const ipcTransport = new MemoryIpcTransport();
        // why: a daemon the service starts on a config it refuses exits at once and never answers.
        const serviceManager = new FakeServiceManager({
          manager,
          onInstall: async () => {
            if (maxDevices === 0) return;
            await startInMemoryDaemon({
              adminTokenPath: join(root, "admin.token"),
              filesystem,
              ipcTransport,
              socketPath: join(root, "daemon.sock"),
            });
          },
        });
        const output = outputCapture({
          filesystem,
          clock: new FakeClock(0),
          systemStats: new FakeSystemStats({ cpuCount: 8, totalRamBytes: 32 * gibibyte }),
          ipc: ipcTransport,
          launcher: new FakeDaemonLauncher(),
          daemonHome: { role: "worker", dataDirectory: root, gatewayPresent: false },
          homeDirectory: "/Users/me",
          workingDirectory: "/work/project",
          hostPlatform: "linux",
          runTool: async () => ({ outcome: "not-found" }),
          service: {
            manager: serviceManager,
            platform,
            home: "/Users/me",
            user: () => "me",
            root,
            nodePath: "/opt/node/bin/node",
            mainPath: "/opt/simlock/dist/daemon/main.js",
          },
        });

        const exitCode = await runCli(["daemon", "install"], output.environmentWith());

        if (maxDevices === 0) {
          expect(JSON.parse(output.stderr.trim()), label).toEqual({
            error: {
              code: "USAGE",
              message:
                'Invalid config value for "capacity.config.limits.android.maxDevices": expected a positive integer',
            },
          });
          expect(exitCode, label).toBe(2);
          expect(serviceManager.installs, label).toEqual([]);
        } else {
          expect(output.stderr, label).toBe("");
          expect(exitCode, label).toBe(0);
          expect(serviceManager.installs, label).toHaveLength(1);
        }
      }
    }
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
            socketPath: join(root, "daemon.sock"),
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
        hostPlatform: "linux",
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
        for (let tick = 0; tick < 500 && !settled; tick += 1) {
          clock.advance(50);
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
  const plist = `${home}/Library/LaunchAgents/${name}.plist`;
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
      const result = await run({ argv: ["daemon", command], platform: "freebsd" });
      expect(result.exitCode, `freebsd ${command}`).toBe(2);
      expect(errorOf(result.stderr), `freebsd ${command}`).toEqual({
        code: "USAGE",
        message: `daemon ${command} is supported on macOS, Linux and Windows only`,
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

describe("CLI: daemon service on Windows (#1698)", () => {
  const root = "/Users/me/.simlock";
  const nodePath = "/opt/node/node.exe";
  const mainPath = "/opt/simlock/dist/daemon/main.js";
  const sid = "S-1-5-21-1-2-3-1001";
  const done = { code: 0, stdout: "", stderr: "" };

  async function runWindowsCli(options: {
    readonly argv: readonly string[];
    readonly role: "worker" | "gateway";
    readonly runner: ScriptedProcessRunner;
    readonly filesystem: MemoryFilesystem;
    readonly startAfterInstall?: boolean;
    readonly daemonRunning?: boolean;
    readonly state?: ServiceState;
    readonly files?: readonly string[];
  }): Promise<{ readonly exitCode: number; readonly output: ReturnType<typeof outputCapture> }> {
    const { role, runner, filesystem } = options;
    const dataDirectory = role === "gateway" ? join(root, "gateway") : root;
    const ipcTransport = new MemoryIpcTransport();
    for (const file of options.files ?? []) {
      await filesystem.mkdirp(dirname(file));
      await filesystem.writeFileAtomic(file, "");
    }
    const startDaemon = async (): Promise<void> => {
      await startInMemoryDaemon({
        adminTokenPath: join(dataDirectory, "admin.token"),
        filesystem,
        ipcTransport,
        socketPath: join(dataDirectory, "daemon.sock"),
      });
    };
    if (options.daemonRunning === true) await startDaemon();
    const tasks = new TaskSchedulerServiceManager({
      runner,
      filesystem,
      systemRoot: "C:\\Windows",
    });
    const { state } = options;
    const serviceManager: ServiceManager = {
      manager: "task-scheduler",
      state: (definition) =>
        state === undefined ? tasks.state(definition) : Promise.resolve(state),
      uninstall: (definition) => tasks.uninstall(definition),
      start: (definition) => tasks.start(definition),
      install: async (definition) => {
        await tasks.install(definition);
        if (options.startAfterInstall === true) await startDaemon();
      },
    };
    const output = outputCapture(
      {
        filesystem,
        clock: new FakeClock(0),
        systemStats: new FakeSystemStats({ cpuCount: 8, totalRamBytes: 32 * gibibyte }),
        ipc: ipcTransport,
        launcher: new FakeDaemonLauncher(),
        daemonHome: { role, dataDirectory, gatewayPresent: false },
        homeDirectory: "/Users/me",
        workingDirectory: "C:\\work",
        hostPlatform: "linux",
        runTool: async () => ({ outcome: "not-found" }),
        service: {
          manager: serviceManager,
          platform: "win32",
          home: "/Users/me",
          user: () => "me",
          root,
          nodePath,
          mainPath,
        },
      },
      { PATH: "C:\\bin" },
    );
    const exitCode = await runCli(options.argv, output.environmentWith());
    return { exitCode, output };
  }

  async function installOnWindows(options: {
    readonly argv: readonly string[];
    readonly role?: "worker" | "gateway";
    readonly whoami?: ProcessResult;
    readonly create?: ProcessResult;
  }): Promise<{
    readonly exitCode: number;
    readonly output: ReturnType<typeof outputCapture>;
    readonly runner: ScriptedProcessRunner;
    readonly filesystem: MemoryFilesystem;
    readonly name: string;
    readonly xmlPath: string;
    readonly written: { readonly text: string; readonly encoding: string } | undefined;
  }> {
    const role = options.role ?? "worker";
    const dataDirectory = role === "gateway" ? join(root, "gateway") : root;
    const name = `com.callstack.simlock.${role}`;
    const xmlPath = join(dataDirectory, "service-task.xml");
    const filesystem = new MemoryFilesystem();
    let written: { readonly text: string; readonly encoding: string } | undefined;
    const runner = new ScriptedProcessRunner([
      {
        match: { command: "whoami", args: ["/user", "/fo", "csv", "/nh"] },
        result: options.whoami ?? { ...done, stdout: `"desktop\\me","${sid}"\r\n` },
      },
      ...(options.whoami === undefined || options.whoami.code === 0
        ? [
            {
              match: { command: "schtasks", args: ["/end", "/tn", name] },
              result: { code: 1, stdout: "", stderr: "ERROR: There are no running instances." },
            },
            {
              match: {
                command: "schtasks",
                args: ["/create", "/tn", name, "/xml", xmlPath, "/f"],
              },
              result: options.create ?? done,
              onSpawn: () => {
                const encoding = filesystem.encodingOf(xmlPath);
                void filesystem.readFile(xmlPath).then((text) => {
                  written = { text, encoding };
                });
              },
            },
          ]
        : []),
    ]);
    const { exitCode, output } = await runWindowsCli({
      argv: options.argv,
      role,
      runner,
      filesystem,
      startAfterInstall: true,
    });
    return { exitCode, output, runner, filesystem, name, xmlPath, written };
  }

  function supervisorArguments(xml: string): RegExpExecArray | null {
    const args = /<Arguments>(.*)<\/Arguments>/.exec(xml)?.[1] ?? "";
    return /^--headless "([^"]*)" "([^"]*)"( --gateway)? --task (\S+) --install-id ([0-9a-f-]{36}) --environment (\S+)$/.exec(
      args,
    );
  }

  async function expectGatewayAndJsonInstalls(): Promise<void> {
    const gateway = await installOnWindows({
      argv: ["--gateway", "daemon", "install"],
      role: "gateway",
    });
    expect(gateway.output.stderr).toBe("");
    expect(gateway.output.stdout.split("\n")[0]).toBe(
      "Service installed: com.callstack.simlock.gateway (task-scheduler)",
    );
    const gatewayParts = supervisorArguments(gateway.written?.text ?? "");
    expect(gatewayParts?.[3], "the supervisor gets --gateway").toBe(" --gateway");
    expect(gatewayParts?.[4]).toBe("com.callstack.simlock.gateway");

    const json = await installOnWindows({ argv: ["daemon", "install", "--json"] });
    expect(JSON.parse(json.output.stdout)).toEqual({
      status: "installed",
      service: {
        state: "installed",
        manager: "task-scheduler",
        name: "com.callstack.simlock.worker",
        path: "\\com.callstack.simlock.worker",
      },
    });
  }

  it("an operator runs daemon install on Windows: the user's SID goes into a UTF-16 logon task that runs the supervisor hidden with the saved variables, the daemon answers, and install prints the name, Daemon running and the login hint; --gateway names the gateway task and passes --gateway to the supervisor, and --json answers the task-scheduler manager", async () => {
    const { exitCode, output, runner, filesystem, name, xmlPath, written } = await installOnWindows(
      { argv: ["daemon", "install"] },
    );

    expect(output.stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(runner.calls.map((call) => [call.command, call.args[0]])).toEqual([
      ["whoami", "/user"],
      ["schtasks", "/end"],
      ["schtasks", "/create"],
    ]);
    expect(output.stdout.split("\n").slice(0, 2)).toEqual([
      `Service installed: ${name} (task-scheduler)`,
      "Daemon running",
    ]);
    expect(output.stdout.trimEnd().split("\n").at(-1)).toBe(
      "To start after a reboot, turn on automatic login for this user.",
    );
    expect(written?.encoding).toBe("utf16le");
    const xml = written?.text ?? "";
    expect(xml.startsWith('\uFEFF<?xml version="1.0" encoding="UTF-16"?>')).toBe(true);
    for (const element of [
      `<LogonTrigger><Enabled>true</Enabled><UserId>${sid}</UserId></LogonTrigger>`,
      `<UserId>${sid}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel>`,
      "<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
      "<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
      "<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
      "<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
      "<Priority>5</Priority>",
      "<Enabled>true</Enabled>",
      "<Description>simlock worker daemon</Description>",
      "<Command>C:\\Windows\\System32\\conhost.exe</Command>",
    ]) {
      expect(xml, element).toContain(element);
    }
    const parts = supervisorArguments(xml);
    expect(parts?.slice(1, 5)).toEqual([
      nodePath,
      "/opt/simlock/dist/daemon/service-main.js",
      undefined,
      name,
    ]);
    expect(JSON.parse(Buffer.from(parts?.[6] ?? "", "base64url").toString("utf8"))).toEqual({
      SIMLOCK_HOME: root,
      PATH: "C:\\bin",
    });
    expect(await filesystem.exists(xmlPath), "the XML file is deleted after create").toBe(false);
    await expectGatewayAndJsonInstalls();
  });

  it("an install whose registration fails is SERVICE_FAILED with the command's first stderr line, and leaves no task XML", async () => {
    const name = "com.callstack.simlock.worker";
    const xmlPath = join(root, "service-task.xml");
    const cases = [
      {
        label: "schtasks /create exits 1",
        create: { code: 1, stdout: "", stderr: "ERROR: Access is denied.\nsecond line" },
        message: `schtasks /create /tn ${name} /xml ${xmlPath} /f failed: ERROR: Access is denied.`,
      },
      {
        label: "whoami exits 1",
        whoami: { code: 1, stdout: "", stderr: "ERROR: no user" },
        message: "whoami /user /fo csv /nh failed: ERROR: no user",
      },
      {
        label: "whoami prints no SID",
        whoami: { code: 0, stdout: '"desktop\\me"\r\n', stderr: "" },
        message: "whoami /user printed no SID",
      },
      {
        label: "a call past 10 s",
        create: { code: null, stdout: "", stderr: "" },
        message: `schtasks /create /tn ${name} /xml ${xmlPath} /f did not finish within 10 s`,
      },
    ];
    for (const { label, message, ...results } of cases) {
      const failed = await installOnWindows({ argv: ["daemon", "install"], ...results });
      expect(failed.exitCode, label).toBe(1);
      expect(JSON.parse(failed.output.stderr.trim()), label).toEqual({
        error: { code: "SERVICE_FAILED", message },
      });
      expect(await failed.filesystem.exists(xmlPath), label).toBe(false);
      expect(
        failed.runner.calls.every((call) => call.options.timeoutMs === 10_000),
        label,
      ).toBe(true);
    }
  });

  it("an operator runs daemon uninstall on Windows: the daemon is stopped, the task is deleted, and no task or a failed delete is reported", async () => {
    const name = "com.callstack.simlock.worker";
    const taskState: ServiceState = { state: "installed", path: `\\${name}` };
    const deleteArgs = ["/delete", "/tn", name, "/f"];
    const cases = [
      {
        label: "task installed and daemon running",
        argv: ["daemon", "uninstall"],
        state: taskState,
        daemonRunning: true,
        script: [{ match: { command: "schtasks", args: deleteArgs }, result: done }],
        stdout: `Daemon stopping\nService removed: ${name} (task-scheduler)\n`,
      },
      {
        label: "task installed, no daemon",
        argv: ["daemon", "uninstall"],
        state: taskState,
        script: [{ match: { command: "schtasks", args: deleteArgs }, result: done }],
        stdout: `Service removed: ${name} (task-scheduler)\n`,
      },
      {
        label: "no task: schtasks /delete is not run",
        argv: ["daemon", "uninstall"],
        state: { state: "not-installed" } as ServiceState,
        script: [],
        stdout: `Service not installed: ${name}\n`,
      },
    ];
    for (const { label, script, stdout, ...rest } of cases) {
      const runner = new ScriptedProcessRunner(script);
      const { exitCode, output } = await runWindowsCli({
        ...rest,
        role: "worker",
        runner,
        filesystem: new MemoryFilesystem(),
      });
      expect(output.stderr, label).toBe("");
      expect(exitCode, label).toBe(0);
      expect(output.stdout, label).toBe(stdout);
      expect(runner.calls.length, label).toBe(script.length);
    }

    const failed = await runWindowsCli({
      argv: ["daemon", "uninstall"],
      role: "worker",
      runner: new ScriptedProcessRunner([
        {
          match: { command: "schtasks", args: deleteArgs },
          result: { code: 1, stdout: "", stderr: "ERROR: The system cannot find the file." },
        },
      ]),
      filesystem: new MemoryFilesystem(),
      state: taskState,
    });
    expect(failed.exitCode).toBe(1);
    expect(JSON.parse(failed.output.stderr.trim())).toEqual({
      error: {
        code: "SERVICE_FAILED",
        message: `schtasks /delete /tn ${name} /f failed: ERROR: The system cannot find the file.`,
      },
    });
  });

  it("daemon status on Windows prints one Service: line from the task and the user's desktop session, and --json carries the same state", async () => {
    const name = "com.callstack.simlock.worker";
    const supervisor = "/opt/simlock/dist/daemon/service-main.js";
    const query = {
      command: "cmd.exe",
      args: ["/d", "/c", `chcp 65001 >nul && schtasks /query /tn ${name} /xml`],
    };
    const whoami = {
      command: "cmd.exe",
      args: ["/d", "/c", "chcp 65001 >nul && whoami /user /fo csv /nh"],
    };
    const tasklist = {
      command: "tasklist",
      args: ["/fi", "USERNAME eq desktop\\me", "/fi", "SESSION ne 0", "/fo", "csv", "/nh"],
    };
    const taskXml = (options: {
      readonly node?: string;
      readonly supervisor?: string;
      readonly arguments?: string;
      readonly enabled?: boolean;
    }): string => {
      const args =
        options.arguments ??
        `--headless "${options.node ?? nodePath}" "${options.supervisor ?? supervisor}" --task ${name} --install-id 1 --environment e30`;
      return `<Task><Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers><Settings><Enabled>${String(options.enabled ?? true)}</Enabled></Settings><Actions><Exec><Command>C:\\Windows\\System32\\conhost.exe</Command><Arguments>${args}</Arguments></Exec></Actions></Task>`;
    };
    const ok = (stdout: string): ProcessResult => ({ code: 0, stdout, stderr: "" });
    const session = [{ match: whoami, result: ok('"desktop\\me","S-1-5-21-1"\r\n') }];
    const present = [nodePath, supervisor];
    const info = "INFO: No tasks are running which match the specified criteria.\r\n";
    const cases = [
      {
        label: "no task",
        files: [],
        script: [{ match: query, result: { code: 1, stdout: "", stderr: "ERROR" } }],
        line: "Service: not installed",
      },
      {
        label: "task, user at the screen",
        files: present,
        script: [
          { match: query, result: ok(taskXml({})) },
          ...session,
          { match: tasklist, result: ok('"sihost.exe","4242","Console","1","20,000 K"\r\n') },
        ],
        line: `Service: installed (task-scheduler, ${name})`,
      },
      {
        label: "no desktop session: tasklist prints only its INFO line",
        files: present,
        script: [
          { match: query, result: ok(taskXml({})) },
          ...session,
          { match: tasklist, result: ok(info) },
        ],
        line: `Service: not loaded (task-scheduler, ${name}): commands start the daemon without it`,
      },
      {
        label: "tasklist fails",
        files: present,
        script: [
          { match: query, result: ok(taskXml({})) },
          ...session,
          { match: tasklist, result: { code: 1, stdout: "", stderr: "ERROR" } },
        ],
        line: `Service: not loaded (task-scheduler, ${name}): commands start the daemon without it`,
      },
      {
        label: "tasklist takes more than 10 s",
        files: present,
        script: [
          { match: query, result: ok(taskXml({})) },
          ...session,
          { match: tasklist, result: { code: null, stdout: "", stderr: "" } },
        ],
        line: `Service: not loaded (task-scheduler, ${name}): commands start the daemon without it`,
      },
      {
        label: "task disabled by hand",
        files: present,
        script: [{ match: query, result: ok(taskXml({ enabled: false })) }],
        line: `Service: not loaded (task-scheduler, ${name}): commands start the daemon without it`,
      },
      {
        label: "Node path gone",
        files: [supervisor],
        script: [{ match: query, result: ok(taskXml({})) }],
        line: `Service: broken (task-scheduler, ${name}): ${nodePath} is gone; run simlock daemon install`,
      },
      {
        label: "supervisor path gone",
        files: [nodePath],
        script: [{ match: query, result: ok(taskXml({})) }],
        line: `Service: broken (task-scheduler, ${name}): ${supervisor} is gone; run simlock daemon install`,
      },
      {
        label: "arguments without two quoted paths after --headless",
        files: present,
        script: [{ match: query, result: ok(taskXml({ arguments: "--headless node" })) }],
        line: `Service: broken (task-scheduler, ${name}): \\${name} is gone; run simlock daemon install`,
      },
      {
        label: "whoami prints no account name",
        files: present,
        script: [
          { match: query, result: ok(taskXml({})) },
          { match: whoami, result: ok("\r\n") },
        ],
        line: `Service: not loaded (task-scheduler, ${name}): commands start the daemon without it`,
      },
      {
        label: "a non-ASCII account name is read as UTF-8 and filtered by whole",
        files: present,
        script: [
          { match: query, result: ok(taskXml({})) },
          { match: whoami, result: ok('"desktop\\józef","S-1-5-21-1"\r\n') },
          {
            match: {
              command: "tasklist",
              args: [
                "/fi",
                "USERNAME eq desktop\\józef",
                "/fi",
                "SESSION ne 0",
                "/fo",
                "csv",
                "/nh",
              ],
            },
            result: ok('"sihost.exe","4242","Console","1","20,000 K"\r\n'),
          },
        ],
        line: `Service: installed (task-scheduler, ${name})`,
      },
      {
        label: "a path with an ampersand is read as the task XML escapes it",
        files: [nodePath, supervisor, "/opt/R&D/node.exe"],
        script: [
          { match: query, result: ok(taskXml({ node: "/opt/R&amp;D/node.exe" })) },
          ...session,
          { match: tasklist, result: ok('"sihost.exe","4242","Console","1","20,000 K"\r\n') },
        ],
        line: `Service: installed (task-scheduler, ${name})`,
      },
      {
        label: "a path with a non-ASCII character is read whole",
        files: [nodePath, "/opt/simlock-ü/dist/daemon/service-main.js"],
        script: [
          {
            match: query,
            result: ok(taskXml({ supervisor: "/opt/simlock-ü/dist/daemon/service-main.js" })),
          },
          ...session,
          { match: tasklist, result: ok('"sihost.exe","4242","Console","1","20,000 K"\r\n') },
        ],
        line: `Service: installed (task-scheduler, ${name})`,
      },
    ];
    for (const { label, files, script, line } of cases) {
      const runner = new ScriptedProcessRunner(script);
      const { exitCode, output } = await runWindowsCli({
        argv: ["daemon", "status"],
        role: "worker",
        runner,
        filesystem: new MemoryFilesystem(),
        files,
      });
      expect(output.stderr, label).toBe("");
      expect(exitCode, label).toBe(0);
      expect(output.stdout, label).toBe(`Daemon stopped\n${line}\n`);
      expect(runner.calls.length, label).toBe(script.length);
      expect(
        runner.calls.every((call) => call.options.timeoutMs === 10_000),
        label,
      ).toBe(true);
    }

    const json = await runWindowsCli({
      argv: ["daemon", "status", "--json"],
      role: "worker",
      runner: new ScriptedProcessRunner([
        { match: query, result: ok(taskXml({ enabled: false })) },
      ]),
      filesystem: new MemoryFilesystem(),
      files: present,
    });
    expect(JSON.parse(json.output.stdout)).toEqual({
      status: "stopped",
      service: { state: "not-loaded", manager: "task-scheduler", name, path: `\\${name}` },
    });
  });
});
