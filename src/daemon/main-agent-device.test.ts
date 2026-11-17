import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentDeviceModule } from "../agent-device/definition.js";
import { agentDeviceModuleWith, FakeAgentDeviceHealth } from "../agent-device/testing.js";
import { FakeDriver, fakeDeviceDataTables } from "../core/testing.js";
import { fakeModule, type FakeModule } from "../modules/testing.js";
import {
  FakeClock,
  FakeHostInfo,
  FakeProcessSupervisor,
  FakeTcpProbe,
  JsonLinesLogger,
  MemoryFilesystem,
  MemoryLogSink,
  ScriptedProcessRunner,
} from "../ports/index.js";
import { startDaemon, type StartDaemonOptions } from "./main.js";
import type { OptionalModuleDefinition } from "../modules/index.js";
import { pollUntil, runningDaemons, stopDaemons, temporaryDirectories } from "./test-main.js";
import { startOnFreePort } from "../test-support/loopback-port.js";

afterEach(stopDaemons);

describe("startDaemon with the agent-device edge", () => {
  const packageRoot = "/opt/ad/node_modules/agent-device";
  const realCli = `${packageRoot}/bin/agent-device.mjs`;
  const entry = `${packageRoot}/dist/src/internal/daemon.js`;
  const command = "/opt/ad/bin/agent-device";
  const lease = {
    model: "iPhone 16",
    osVersion: "26.5",
    platform: "ios",
    requesterId: "agent-1",
  } as const;
  const agent = {
    manageEventSubscription: () => undefined,
    via: "socket",
    principal: "agent",
    role: "agent",
  } as const;

  class KillingSupervisor extends FakeProcessSupervisor {
    readonly kills = new Map<number, () => void>();

    override signal(pid: number, signal: NodeJS.Signals): void {
      super.signal(pid, signal);
      this.markDead(pid);
      this.kills.get(pid)?.();
    }
  }

  async function setUp(
    config: unknown,
    options: { readonly directory?: string; readonly record?: { readonly pid: number } } = {},
  ) {
    const directory = options.directory ?? (await mkdtemp(join(tmpdir(), "simlock-main-ad-")));
    temporaryDirectories.push(directory);
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp(directory);
    await filesystem.mkdirp("/opt/ad/bin");
    await filesystem.mkdirp(`${packageRoot}/bin`);
    await filesystem.mkdirp(`${packageRoot}/dist/src/internal`);
    await filesystem.writeFileAtomic(realCli, "#!/usr/bin/env node\n");
    filesystem.defineAttributes(realCli, { mode: 0o755 });
    await filesystem.writeFileAtomic(`${packageRoot}/package.json`, '{"name":"agent-device"}');
    await filesystem.writeFileAtomic(entry, "");
    filesystem.defineSymlink(command, realCli);
    // why: HTTP and agent-device are on by default for a standalone worker (ADR 0046); a test here asks for agent-device and never for HTTP, and two daemons would clash on 4701.
    await filesystem.writeFileAtomic(
      join(directory, "config.json"),
      JSON.stringify({ http: { enabled: false }, ...(config as Record<string, unknown>) }),
    );
    if (options.record !== undefined) {
      await filesystem.writeFileAtomic(
        join(directory, "agent-device-daemon.json"),
        JSON.stringify({ entry, pid: options.record.pid, startedAt: 1 }),
      );
    }
    return { directory, filesystem };
  }

  /** why: pid 900 answers as this home's own agent-device daemon, so a supervisor that ran would read its command line and SIGTERM it. */
  function recordedDaemonAlive(directory: string): FakeProcessSupervisor {
    const processSupervisor = new FakeProcessSupervisor([900]);
    processSupervisor.answerCommandLine(
      900,
      `${process.execPath} ${entry} --simlock-home=${directory}`,
    );
    return processSupervisor;
  }

  function versionAndDaemon(directory: string, role?: "phones"): ScriptedProcessRunner {
    const version = {
      match: { args: [realCli, "--version"], command: process.execPath },
      result: { code: 0, stderr: "", stdout: "0.21.28\n" },
    };
    const daemon = (marker: readonly string[]) => ({
      hangs: true,
      match: { args: [entry, ...marker], command: process.execPath },
    });
    const simulators = daemon([`--simlock-home=${directory}`]);
    if (role === undefined) return new ScriptedProcessRunner([version, simulators]);
    return new ScriptedProcessRunner([
      version,
      simulators,
      version,
      daemon([`--simlock-home=${directory}`, "--simlock-role=phones"]),
    ]);
  }

  async function startEdge(
    setup: Awaited<ReturnType<typeof setUp>>,
    ports: {
      readonly agentDevice?: OptionalModuleDefinition<unknown>;
      readonly clock?: FakeClock;
      readonly drivers?: StartDaemonOptions["drivers"];
      readonly modules?: readonly FakeModule[];
      readonly processRunner: ScriptedProcessRunner;
      readonly processSupervisor: FakeProcessSupervisor;
      readonly role?: "gateway";
      readonly tcpProbe?: FakeTcpProbe;
    },
  ) {
    const clock = ports.clock ?? new FakeClock(1_000);
    const sink = new MemoryLogSink();
    const daemon = await startDaemon({
      clock,
      dataDirectory: setup.directory,
      ...(ports.role === undefined ? {} : { role: ports.role }),
      deviceDataTables: fakeDeviceDataTables,
      drivers: ports.drivers ?? [
        new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" }),
      ],
      filesystem: setup.filesystem,
      hostInfo: new FakeHostInfo({ arch: "arm64", os: "macOS", osVersion: "15.5" }),
      logger: new JsonLinesLogger({ clock, level: "debug", sink }),
      optionalModules: [
        ports.agentDevice ?? agentDeviceModuleWith({ health: new FakeAgentDeviceHealth() }),
        ...(ports.modules ?? []).map(
          (module) => module.definition as OptionalModuleDefinition<unknown>,
        ),
      ],
      processRunner: ports.processRunner,
      processSupervisor: ports.processSupervisor,
      tcpProbe: ports.tcpProbe ?? new FakeTcpProbe(),
      version: "1.2.3",
    });
    runningDaemons.push(daemon);
    return { clock, daemon, sink };
  }

  it("runs a module's beforeDriversDispose and stops agent-device's child, both before the drivers are disposed", async () => {
    const setup = await setUp({
      capabilities: { "agent-device": { command, enabled: true }, alpha: { enabled: true } },
    });
    const events: string[] = [];
    const processSupervisor = new KillingSupervisor();
    const runner = versionAndDaemon(setup.directory);
    const spawn = runner.spawn.bind(runner);
    vi.spyOn(runner, "spawn").mockImplementation((spawned, args, options) => {
      const handle = spawn(spawned, args, options);
      if (args[0] === entry) {
        processSupervisor.markAlive(handle.pid);
        processSupervisor.kills.set(handle.pid, () => handle.kill());
        void handle.wait().then(() => events.push("agent-device exited"));
      }
      return handle;
    });
    const clock = new FakeClock(1_000);
    class DisposingDriver extends FakeDriver {
      async dispose(): Promise<void> {
        events.push("driver disposed");
      }
    }
    const { daemon } = await startEdge(setup, {
      drivers: [new DisposingDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" })],
      modules: [
        fakeModule({
          hooks: {
            beforeDriversDispose: () => {
              events.push("module beforeDriversDispose");
              return Promise.resolve();
            },
          },
          name: "alpha",
        }),
      ],
      processRunner: runner,
      processSupervisor,
    });
    await pollUntil(() => runner.calls.length === 2);

    await daemon.stop("test");

    expect(events.at(-1)).toBe("driver disposed");
    expect(events.slice(0, -1).sort()).toEqual([
      "agent-device exited",
      "module beforeDriversDispose",
    ]);
  });

  it("stops both agent-device daemons when the worker stops, the phone daemon and the simulator daemon each by its own pid", async () => {
    const setup = await setUp({ capabilities: { "agent-device": { command, enabled: true } } });
    const health = new FakeAgentDeviceHealth();
    health.respondWith({ rpcProtocolVersion: 2, service: "agent-device-daemon" });
    const tcpProbe = new FakeTcpProbe();
    const processSupervisor = new KillingSupervisor();
    const version = {
      match: { args: [realCli, "--version"], command: process.execPath },
      result: { code: 0, stderr: "", stdout: "0.21.28\n" },
    };
    const daemonAt = (stateDirName: string, pid: number, port: number, marker: string[]) => ({
      hangs: true,
      match: {
        args: [entry, `--simlock-home=${setup.directory}`, ...marker],
        command: process.execPath,
      },
      onSpawn: async () => {
        processSupervisor.markAlive(pid);
        await setup.filesystem.writeFileAtomic(
          join(setup.directory, stateDirName, "daemon.json"),
          JSON.stringify({ httpPort: port, pid, token: "t" }),
        );
        tcpProbe.startListening(port);
      },
    });
    const runner = new ScriptedProcessRunner([
      version,
      daemonAt("agent-device", 2, 4310, []),
      version,
      daemonAt("agent-device-phones", 4, 4311, ["--simlock-role=phones"]),
    ]);
    const spawn = runner.spawn.bind(runner);
    vi.spyOn(runner, "spawn").mockImplementation((spawned, args, options) => {
      const handle = spawn(spawned, args, options);
      if (args[0] === entry) processSupervisor.kills.set(handle.pid, () => handle.kill());
      return handle;
    });
    const { clock, daemon } = await startEdge(setup, {
      agentDevice: agentDeviceModuleWith({ health }),
      clock: new FakeClock(1_000),
      processRunner: runner,
      processSupervisor,
      tcpProbe,
    });
    for (let tick = 0; tick < 400 && runner.calls.length < 4; tick += 1) {
      await new Promise((resolve) => setImmediate(resolve));
      clock.advance(100);
    }
    for (let tick = 0; tick < 20; tick += 1) {
      await new Promise((resolve) => setImmediate(resolve));
      clock.advance(100);
    }

    const stopping = daemon.stop("test");
    for (let tick = 0; tick < 100; tick += 1) {
      await new Promise((resolve) => setImmediate(resolve));
      clock.advance(100);
    }
    await stopping;

    expect(processSupervisor.signals.map((signal) => signal.pid).sort()).toEqual([2, 4]);
  });

  it("resolves and grants a lease to an ordinary client while agent-device's /health never answers", async () => {
    const setup = await setUp({ capabilities: { "agent-device": { command, enabled: true } } });
    const processSupervisor = new KillingSupervisor();
    const runner = versionAndDaemon(setup.directory);
    const spawn = runner.spawn.bind(runner);
    vi.spyOn(runner, "spawn").mockImplementation((spawned, args, options) => {
      const handle = spawn(spawned, args, options);
      if (args[0] === entry) {
        processSupervisor.markAlive(handle.pid);
        processSupervisor.kills.set(handle.pid, () => handle.kill());
      }
      return handle;
    });
    const clock = new FakeClock(1_000);

    const { daemon } = await startEdge(setup, {
      drivers: [new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" })],
      processRunner: runner,
      processSupervisor,
    });
    await pollUntil(() => runner.calls.length === 2);

    expect(runner.calls.map((call) => call.args[0])).toEqual([realCli, entry]);
    await expect(daemon.dispatch("lease.request", lease, agent)).resolves.toMatchObject({
      lease: { id: expect.any(String) },
    });

    await daemon.stop("test");
  });

  async function spawnedEnvironment(drivers: (clock: FakeClock) => StartDaemonOptions["drivers"]) {
    const setup = await setUp({ capabilities: { "agent-device": { command, enabled: true } } });
    const runner = versionAndDaemon(setup.directory);
    await startEdge(setup, {
      drivers: drivers(new FakeClock(1_000)),
      processRunner: runner,
      processSupervisor: new FakeProcessSupervisor(),
    });
    await pollUntil(() => runner.calls.length === 2);
    return runner.calls[1]?.options.env ?? {};
  }

  it.each([
    ["teamId", "AGENT_DEVICE_IOS_TEAM_ID", "ABCDE12345"],
    ["bundleId", "AGENT_DEVICE_IOS_BUNDLE_ID", "com.example.runner"],
    ["provisioningProfile", "AGENT_DEVICE_IOS_PROVISIONING_PROFILE", "Simlock Runner Profile"],
    ["signingIdentity", "AGENT_DEVICE_IOS_SIGNING_IDENTITY", "Apple Development: Ada (XYZ)"],
  ])(
    "a capabilities.agent-device.ios.%s the operator sets reaches the phone daemon's spawn environment as %s",
    async (key, envName, value) => {
      const setup = await setUp({
        capabilities: { "agent-device": { command, enabled: true, ios: { [key]: value } } },
      });
      const runner = versionAndDaemon(setup.directory, "phones");
      const clock = new FakeClock(1_000);
      await startEdge(setup, {
        clock,
        processRunner: runner,
        processSupervisor: new FakeProcessSupervisor(),
      });
      // why: the simulator daemon's /health never answers, so the phone daemon starts when its ready window runs out.
      for (let tick = 0; tick < 400 && runner.calls.length < 4; tick += 1) {
        await new Promise((resolve) => setImmediate(resolve));
        clock.advance(100);
      }

      expect(runner.calls[3]?.args).toEqual([
        entry,
        `--simlock-home=${setup.directory}`,
        "--simlock-role=phones",
      ]);
      expect(runner.calls[3]?.options.env?.[envName]).toBe(value);
      expect(runner.calls[1]?.options.env?.[envName]).toBeUndefined();
    },
  );

  it("hands the drivers' lease environment to the agent-device daemon", async () => {
    const env = await spawnedEnvironment((clock) => [
      new FakeDriver({
        availableOsVersions: ["26.5"],
        clock,
        leaseEnvironment: { SIMLOCK_IOS_DEVICE_SET: "/sets/ios", SIMLOCK_TEST_MARKER: "kept" },
        platform: "ios",
      }),
    ]);

    expect(env["SIMLOCK_TEST_MARKER"]).toBe("kept");
    expect(env["AGENT_DEVICE_IOS_SIMULATOR_DEVICE_SET"]).toBe("/sets/ios");
  });

  it("hides a platform whose driver is off from the agent-device daemon, and only that one", async () => {
    const iosOnly = await spawnedEnvironment((clock) => [
      new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" }),
    ]);
    const both = await spawnedEnvironment((clock) => [
      new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" }),
      new FakeDriver({ availableOsVersions: ["14"], clock, platform: "android" }),
    ]);

    expect(iosOnly["AGENT_DEVICE_ANDROID_DEVICE_ALLOWLIST"]).toBe("simlock-no-android-device");
    expect(both["AGENT_DEVICE_ANDROID_DEVICE_ALLOWLIST"]).toBeUndefined();
  });

  it("still starts and grants a lease when agent-device is not found", async () => {
    const setup = await setUp({
      capabilities: { "agent-device": { command: "/opt/missing/agent-device", enabled: true } },
    });
    const runner = new ScriptedProcessRunner([]);

    const { daemon } = await startEdge(setup, {
      processRunner: runner,
      processSupervisor: new FakeProcessSupervisor(),
    });
    await pollUntil(() => false, 100);

    await expect(daemon.dispatch("lease.request", lease, agent)).resolves.toMatchObject({
      lease: { id: expect.any(String) },
    });
    expect(runner.calls).toEqual([]);
  });

  // why: the supervisor retries on clock timers, so a ps it would defer never runs under real time; the fake clock is moved past its retry.
  const SUPERVISOR_RETRY_MS = 30_000;

  it.each([
    {
      role: "gateway",
      config: (port: number) => ({
        capabilities: { "agent-device": { command, enabled: true } },
        http: { enabled: true, host: "127.0.0.1", port },
      }),
      drivers: [],
    },
    {
      role: "worker",
      config: () => ({ capabilities: { "agent-device": { command, enabled: false } } }),
      drivers: undefined,
    },
  ] as const)(
    "a $role with no agent-device supervisor reads no command line, runs no ps and sends no signal, even with a recorded daemon on disk",
    async ({ role, config, drivers }) => {
      const { started } = await startOnFreePort(async (port) => {
        const setup = await setUp(config(port), { record: { pid: 900 } });
        const runner = new ScriptedProcessRunner([]);
        const processSupervisor = recordedDaemonAlive(setup.directory);
        const { clock } = await startEdge(setup, {
          ...(drivers === undefined ? {} : { drivers: [...drivers] }),
          processRunner: runner,
          processSupervisor,
          ...(role === "gateway" ? { role } : {}),
        });
        return { clock, processSupervisor, runner };
      });
      const { clock, processSupervisor, runner } = started;
      clock.advance(SUPERVISOR_RETRY_MS);
      await pollUntil(() => false, 100);

      expect(processSupervisor.commandLineReads).toEqual([]);
      expect(runner.calls).toEqual([]);
      expect(processSupervisor.signals).toEqual([]);
    },
  );

  it('a worker with no capabilities["agent-device"] section, one with enabled false, and one with only the old agentDevice key answer status.get with { name: agent-device, state: off }', async () => {
    const admin = {
      manageEventSubscription: () => undefined,
      via: "socket",
      principal: "op",
      role: "admin",
    } as const;
    for (const config of [
      {},
      { capabilities: { "agent-device": { enabled: false } } },
      { agentDevice: { command, enabled: true } },
    ]) {
      const setup = await setUp(config);
      const { daemon } = await startEdge(setup, {
        processRunner: new ScriptedProcessRunner([]),
        processSupervisor: new FakeProcessSupervisor(),
      });

      const status = await daemon.dispatch("status.get", {}, admin);

      expect(status.capabilities).toEqual([{ name: "agent-device", state: "off" }]);
    }
  });

  it("a worker with agent-device off never calls agent-device's loadWorker", async () => {
    let loads = 0;
    const spying: OptionalModuleDefinition<unknown> = {
      ...agentDeviceModule,
      loadWorker: () => {
        loads += 1;
        return agentDeviceModule.loadWorker();
      },
    } as OptionalModuleDefinition<unknown>;
    const setup = await setUp({ capabilities: { "agent-device": { enabled: false } } });
    const { daemon } = await startEdge(setup, {
      agentDevice: spying,
      processRunner: new ScriptedProcessRunner([]),
      processSupervisor: new FakeProcessSupervisor(),
    });
    await daemon.stop("test");

    expect(loads).toBe(0);

    const on = await setUp({ capabilities: { "agent-device": { command, enabled: true } } });
    await startEdge(on, {
      agentDevice: spying,
      processRunner: versionAndDaemon(on.directory),
      processSupervisor: new FakeProcessSupervisor(),
    });
    expect(loads).toBe(1);
  });

  it("reads no command line and sends no signal in a second daemon on the same home that loses the socket claim", async () => {
    const first = await setUp({ capabilities: { "agent-device": { enabled: false } } });
    await startEdge(first, {
      processRunner: new ScriptedProcessRunner([]),
      processSupervisor: new FakeProcessSupervisor(),
    });
    const second = await setUp(
      { capabilities: { "agent-device": { command, enabled: true } } },
      { directory: first.directory, record: { pid: 900 } },
    );
    const runner = new ScriptedProcessRunner([]);
    const processSupervisor = recordedDaemonAlive(second.directory);
    const clock = new FakeClock(1_000);

    await expect(
      startEdge(second, { clock, processRunner: runner, processSupervisor }),
    ).rejects.toMatchObject({ name: "DaemonAlreadyRunningError" });
    clock.advance(SUPERVISOR_RETRY_MS);
    await pollUntil(() => false, 100);

    expect(processSupervisor.commandLineReads).toEqual([]);
    expect(runner.calls).toEqual([]);
    expect(processSupervisor.signals).toEqual([]);
  });

  describe("doctor.run", () => {
    const operator = {
      manageEventSubscription: () => undefined,
      via: "socket",
      principal: "operator",
      role: "admin",
    } as const;

    type Report = {
      readonly findings: readonly { readonly kind: string; readonly message?: string }[];
    };

    const agentDeviceFinding = (report: Report) =>
      report.findings.find((finding) => finding.kind === "module-unavailable");

    it("reports module-unavailable for agent-device, naming the found and needed versions, and an ordinary client is still granted a lease", async () => {
      const setup = await setUp({ capabilities: { "agent-device": { command, enabled: true } } });
      const runner = new ScriptedProcessRunner([
        {
          match: { args: [realCli, "--version"], command: process.execPath },
          result: { code: 0, stderr: "", stdout: "0.20.3\n" },
        },
      ]);
      const { daemon } = await startEdge(setup, {
        processRunner: runner,
        processSupervisor: new FakeProcessSupervisor(),
      });

      await expect
        .poll(
          async () =>
            agentDeviceFinding((await daemon.dispatch("doctor.run", {}, operator)) as Report),
          {
            timeout: 5_000,
          },
        )
        .toMatchObject({
          kind: "module-unavailable",
          module: "agent-device",
          message: expect.stringContaining("found 0.20.3, need 0.21.28 or later"),
          remedy: expect.any(String),
        });
      await expect(daemon.dispatch("lease.request", lease, agent)).resolves.toMatchObject({
        lease: { id: expect.any(String) },
      });
    }, 10_000);

    const version = (stdout: string) => ({
      match: { args: [realCli, "--version"], command: process.execPath },
      result: { code: 0, stderr: "", stdout },
    });

    // why: the simulator daemon's version answer is the row's own text when it is not the running one, and the phone daemon's follows `phones`.
    function scriptedDaemons(
      setup: Awaited<ReturnType<typeof setUp>>,
      tcpProbe: FakeTcpProbe,
      simulator: string,
      phones: string | undefined,
    ): ScriptedProcessRunner {
      if (simulator === "missing") return new ScriptedProcessRunner([]);
      return new ScriptedProcessRunner([
        version(simulator === "running" ? "0.21.28\n" : simulator),
        {
          hangs: true,
          match: { args: [entry, `--simlock-home=${setup.directory}`], command: process.execPath },
          onSpawn: async () => {
            await setup.filesystem.writeFileAtomic(
              join(setup.directory, "agent-device", "daemon.json"),
              JSON.stringify({ httpPort: 4310, pid: 2, token: "t" }),
            );
            tcpProbe.startListening(4310);
          },
        },
        version(phones === undefined || phones === "unstartable" ? "0.21.28\n" : phones),
      ]);
    }

    const findingLabel = (finding: { readonly module?: string; readonly message?: string }) => {
      if (finding.module === "alpha") return "alpha";
      return finding.message?.startsWith("phone daemon: ") === true ? "phones" : "simulator";
    };

    it.each([
      {
        name: "both daemons down: agent-device is found nowhere",
        simulator: "missing",
        phones: undefined,
        findings: ["simulator", "phones", "alpha"],
        capability: "unavailable",
      },
      {
        name: "not found, and capabilities.agent-device.enabled never set: it is on only by default",
        simulator: "missing",
        phones: undefined,
        enabled: undefined,
        findings: ["alpha"],
        capability: "off",
      },
      {
        name: "a wrong version, and capabilities.agent-device.enabled never set",
        simulator: "0.20.3\n",
        phones: undefined,
        enabled: undefined,
        findings: ["simulator", "phones", "alpha"],
        capability: "unavailable",
      },
      {
        name: "the phone daemon finds a wrong version",
        simulator: "running",
        phones: "0.20.3\n",
        findings: ["phones", "alpha"],
        capability: "available",
      },
      {
        name: "the phone daemon cannot start",
        simulator: "running",
        phones: "unstartable",
        findings: ["phones", "alpha"],
        capability: "available",
      },
    ] as const)(
      "lists a phone daemon finding that starts with `phone daemon: ` after the simulator daemon's and before another module's, while the capability follows the simulator daemon, and says nothing of a command never found while agent-device is on only by default: $name",
      async ({ capability, findings, phones, simulator, ...row }) => {
        const setup = await setUp({
          capabilities: {
            "agent-device": {
              command: simulator === "missing" ? "/opt/missing/agent-device" : command,
              ...("enabled" in row ? {} : { enabled: true }),
            },
            alpha: { enabled: true },
          },
        });
        const health = new FakeAgentDeviceHealth();
        health.respondWith({ rpcProtocolVersion: 2, service: "agent-device-daemon" });
        const tcpProbe = new FakeTcpProbe();
        const runner = scriptedDaemons(setup, tcpProbe, simulator, phones);
        const { clock, daemon } = await startEdge(setup, {
          agentDevice: agentDeviceModuleWith({ health }),
          clock: new FakeClock(1_000),
          modules: [
            fakeModule({
              findings: () => [{ message: "it is down", remedy: "bring it up" }],
              name: "alpha",
            }),
          ],
          processRunner: runner,
          processSupervisor: new FakeProcessSupervisor(),
          tcpProbe,
        });
        const unavailable = async () =>
          (
            (await daemon.dispatch("doctor.run", {}, operator)) as {
              readonly findings: readonly {
                readonly kind: string;
                readonly module?: string;
                readonly message?: string;
              }[];
            }
          ).findings.filter((finding) => finding.kind === "module-unavailable");
        const labelled = async () => (await unavailable()).map(findingLabel);
        // why: the simulator daemon's polls sleep on the fake clock, so the test advances it until the findings settle.
        for (let tick = 0; tick < 400; tick += 1) {
          if (JSON.stringify(await labelled()) === JSON.stringify(findings)) break;
          await new Promise((resolve) => setImmediate(resolve));
          clock.advance(100);
        }

        expect(await labelled()).toEqual(findings);
        expect(
          (await unavailable())
            .filter((finding) => finding.module !== "alpha")
            .map((f) => f.module),
        ).toEqual(findings.filter((label) => label !== "alpha").map(() => "agent-device"));
        const status = await daemon.dispatch("status.get", {}, operator);
        expect(status.capabilities?.find((entry) => entry.name === "agent-device")?.state).toBe(
          capability,
        );
      },
      20_000,
    );

    it("reports module-unavailable for agent-device, naming the command when capabilities.agent-device.command is found nowhere", async () => {
      const setup = await setUp({
        capabilities: { "agent-device": { command: "/opt/missing/agent-device", enabled: true } },
      });
      const { daemon } = await startEdge(setup, {
        processRunner: new ScriptedProcessRunner([]),
        processSupervisor: new FakeProcessSupervisor(),
      });

      await expect
        .poll(
          async () =>
            agentDeviceFinding((await daemon.dispatch("doctor.run", {}, operator)) as Report),
          {
            timeout: 5_000,
          },
        )
        .toMatchObject({
          kind: "module-unavailable",
          module: "agent-device",
          message: expect.stringContaining("/opt/missing/agent-device"),
        });
    }, 10_000);

    it("reports no module-unavailable finding with capabilities.agent-device.enabled false", async () => {
      const setup = await setUp({ capabilities: { "agent-device": { enabled: false } } });
      const { daemon } = await startEdge(setup, {
        processRunner: new ScriptedProcessRunner([]),
        processSupervisor: new FakeProcessSupervisor(),
      });

      const report = (await daemon.dispatch("doctor.run", {}, operator)) as Report;

      expect(agentDeviceFinding(report)).toBeUndefined();
    });

    it("reports no module-unavailable finding while agent-device's /health never answers and the readiness budget has not run out", async () => {
      const setup = await setUp({ capabilities: { "agent-device": { command, enabled: true } } });
      const runner = versionAndDaemon(setup.directory);
      const { daemon } = await startEdge(setup, {
        processRunner: runner,
        processSupervisor: new FakeProcessSupervisor(),
      });
      await expect
        .poll(() => runner.calls.some((call) => call.args[0] === entry), { timeout: 5_000 })
        .toBe(true);

      const report = (await daemon.dispatch("doctor.run", {}, operator)) as Report;

      expect(agentDeviceFinding(report)).toBeUndefined();
    });
  });
});
