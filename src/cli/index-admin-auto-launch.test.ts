import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  FakeClock,
  FakeDaemonLauncher,
  IpcError,
  MemoryFilesystem,
  MemoryIpcTransport,
  FakeSystemStats,
} from "../ports/index.js";
import { runCli, type CliEnvironmentPorts } from "./index.js";
import {
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

describe("CLI: auto-launch's startup deadline (#663)", () => {
  /**
   * why: the launcher hands back a daemon that claims its socket only `bootMs` later, the way
   * `NodeDaemonLauncher` returns while the detached process it spawned is still booting; what
   * the CLI can see is how long the socket stays absent, not how long `launch` itself blocks.
   */
  function slowBootPorts(bootMs: number): {
    readonly ports: CliEnvironmentPorts;
    readonly clock: FakeClock;
  } {
    const filesystem = new MemoryFilesystem();
    const clock = new FakeClock(0);
    const ipcTransport = new MemoryIpcTransport();
    const ports: CliEnvironmentPorts = {
      filesystem,
      clock,
      systemStats: new FakeSystemStats({ cpuCount: 8, totalRamBytes: 32 * gibibyte }),
      ipc: ipcTransport,
      launcher: new FakeDaemonLauncher(() => {
        clock.setTimer(bootMs, () => {
          void startInMemoryDaemon({
            adminTokenPath: "/simlock/admin.token",
            filesystem,
            ipcTransport,
            socketPath: "/simlock/daemon.sock",
          });
        });
      }),
      daemonHome: { role: "worker", dataDirectory: "/simlock", gatewayPresent: false },
      homeDirectory: "/home/operator",
      workingDirectory: "/work/project",
      hostPlatform: "linux",
      runTool: async () => ({ outcome: "not-found" }),
    };
    return { clock, ports };
  }

  /**
   * why: turns the clock at the auto-launch poll's own 50 ms step, with room to run past the
   * startup deadline and keep pumping the boot the CLI abandoned; the clock is fake, so the
   * extra ticks cost nothing. The `settled` guard makes a hang fail on a named assertion
   * instead of on a test timeout.
   */
  async function runWithTicks(
    command: readonly string[],
    ports: CliEnvironmentPorts,
    clock: FakeClock,
    runOnMs: number,
  ): Promise<{ readonly exitCode: number; readonly output: ReturnType<typeof outputCapture> }> {
    const output = outputCapture(ports);
    let settled = false;
    const exitCode = runCli(command, output.environmentWith()).then((code) => {
      settled = true;
      return code;
    });
    for (let tick = 0; tick < 500 && (!settled || clock.now() < runOnMs); tick += 1) {
      clock.advance(50);
      await settle();
      await settle();
    }
    expect(
      settled,
      `simlock ${command.join(" ")} still had not settled at ${String(clock.now())}ms`,
    ).toBe(true);
    return { exitCode: await exitCode, output };
  }

  it("waits 20 s for a daemon it auto-launched: within the deadline it reports as running, past it the command reports a failed start", async () => {
    const cases = [
      { bootMs: 19_900, label: "19.9 s" },
      { bootMs: 20_100, label: "20.1 s" },
    ];

    // why: every case runs before anything is asserted, so the case that passes cannot hide
    // what the case that fails did to the daemon it launched.
    const outcomes = await Promise.all(
      cases.map(async (testCase) => {
        const { clock, ports } = slowBootPorts(testCase.bootMs);
        const { exitCode, output } = await runWithTicks(
          ["daemon", "start", "--json"],
          ports,
          clock,
          testCase.bootMs + 1_000,
        );
        const after = outputCapture(ports);
        const statusExit = await runCli(["daemon", "status", "--json"], after.environmentWith());
        const status = JSON.parse(after.stdout || "{}") as { daemon?: { health?: string } };
        return {
          exitCode,
          label: testCase.label,
          timedOutStarting: output.stderr.includes("Timed out starting simlock daemon"),
          stdout: output.stdout,
          statusHealth: status.daemon?.health ?? after.stdout,
          statusExit,
        };
      }),
    );

    expect(
      outcomes.map((outcome) => ({
        exitCode: outcome.exitCode,
        label: outcome.label,
        // why: the failed start is asserted as the timeout's wording, not the whole line or
        // its error code, so what the code reports can change without moving this test.
        timedOutStarting: outcome.timedOutStarting,
        stdout: outcome.stdout,
      })),
    ).toEqual([
      {
        exitCode: 0,
        label: "19.9 s",
        timedOutStarting: false,
        stdout: '{"status":"running"}\n',
      },
      {
        exitCode: 1,
        label: "20.1 s",
        timedOutStarting: true,
        stdout: "",
      },
    ]);

    // why: asserted apart from the exit code so a fix that only softens the timeout message
    // fails here -- `daemon status` never launches one, so what it reaches is the daemon this
    // command launched and then gave up on.
    for (const outcome of outcomes) {
      expect(outcome.statusExit, `${outcome.label}: status stderr`).toBe(0);
      expect(
        ["starting", "running"].includes(outcome.statusHealth as string),
        `${outcome.label}: status says ${JSON.stringify(outcome.statusHealth)}`,
      ).toBe(true);
    }
  });
});

describe("CLI: auto-launch's failed start (#672)", () => {
  it("reports a daemon it launched but never reached as DAEMON_STARTUP_FAILED, exit 1", async () => {
    // why: nothing ever claims the socket, which is what a daemon still booting past the
    // deadline looks like to the CLI. The run goes well past any deadline the loop could hold,
    // so the code asserted here is the one the CLI chose for giving up, never one a clock reached.
    const clock = new FakeClock(0);
    const launcher = new FakeDaemonLauncher();
    const output = outputCapture({
      filesystem: new MemoryFilesystem(),
      clock,
      systemStats: new FakeSystemStats({ cpuCount: 8, totalRamBytes: 32 * gibibyte }),
      ipc: new MemoryIpcTransport(),
      launcher,
      daemonHome: { role: "worker", dataDirectory: "/simlock", gatewayPresent: false },
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
    for (let tick = 0; tick < 700 && !settled; tick += 1) {
      clock.advance(50);
      await settle();
      await settle();
    }
    expect(settled, `simlock daemon start still had not settled at ${String(clock.now())}ms`).toBe(
      true,
    );
    expect(await exitCode).toBe(1);
    expect(output.stdout).toBe("");
    expect(JSON.parse(output.stderr)).toMatchObject({
      error: {
        code: "DAEMON_STARTUP_FAILED",
        message: expect.stringContaining("Timed out starting simlock daemon"),
      },
    });
    expect(launcher.launches).toBe(1);
  });
});

describe("CLI: auto-launch's daemon that lost the socket to another daemon (#760)", () => {
  it("status goes on with the daemon that holds the socket when the launched daemon exits already running", async () => {
    const filesystem = new MemoryFilesystem();
    const clock = new FakeClock(0);
    // why: the winner is not listening yet at the first poll after the launch, so the loop reaches
    // the launched daemon's exit before it finds the winner.
    class LateWinnerTransport extends MemoryIpcTransport {
      connects = 0;
      override async connect(endpoint: string): ReturnType<MemoryIpcTransport["connect"]> {
        this.connects += 1;
        if (this.connects === 2) {
          throw new IpcError("endpoint-not-found", `No IPC endpoint at ${endpoint}`, undefined);
        }
        return super.connect(endpoint);
      }
    }
    const ipcTransport = new LateWinnerTransport();
    const launcher = new FakeDaemonLauncher(
      async () => {
        await startInMemoryDaemon({
          adminTokenPath: "/simlock/admin.token",
          filesystem,
          ipcTransport,
          socketPath: "/simlock/daemon.sock",
        });
      },
      {
        exit: { code: 1, signal: null },
        output: `${JSON.stringify({
          message: "Daemon failed to start",
          fields: { message: "Simlock daemon is already running at /simlock/daemon.sock" },
        })}\n`,
      },
    );
    const output = outputCapture({
      filesystem,
      clock,
      systemStats: new FakeSystemStats({ cpuCount: 8, totalRamBytes: 32 * gibibyte }),
      ipc: ipcTransport,
      launcher,
      daemonHome: { role: "worker", dataDirectory: "/simlock", gatewayPresent: false },
      homeDirectory: "/home/operator",
      workingDirectory: "/work/project",
      hostPlatform: "linux",
      runTool: async () => ({ outcome: "not-found" }),
    });
    let settled = false;
    const exitCode = runCli(["status"], output.environmentWith()).then((code) => {
      settled = true;
      return code;
    });
    for (let tick = 0; tick < 100 && !settled; tick += 1) {
      clock.advance(50);
      await settle();
      await settle();
    }
    expect(settled, "status had not settled by 5 s").toBe(true);
    expect(await exitCode).toBe(0);
    expect(output.stderr).not.toContain("DAEMON_STARTUP_FAILED");
    expect(ipcTransport.connects).toBeGreaterThanOrEqual(3);
  });
});
