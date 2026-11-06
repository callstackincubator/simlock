import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeDriver, fakeDeviceDataTables } from "../core/testing.js";
import { DAEMON_PROTOCOL_VERSION } from "../daemon-protocol/index.js";
import {
  FakeClock,
  FakeNpmCli,
  FakeUpdaterLauncher,
  type NpmCli,
  type NpmOutcome,
  IpcError,
  JsonLinesLogger,
  MemoryFilesystem,
  MemoryIpcTransport,
  MemoryLogSink,
  NoopLogger,
} from "../ports/index.js";
import { startDaemon, type StartDaemonOptions } from "./main.js";
import type { DaemonServer } from "./server.js";
import {
  STANDALONE_OFF,
  runningDaemons,
  start,
  stopDaemons,
  temporaryDirectories,
} from "./test-main.js";
import { freeLoopbackPort } from "./test-relay-support.js";

afterEach(stopDaemons);

describe("startDaemon version check", () => {
  const operator = {
    manageEventSubscription: () => undefined,
    via: "socket",
    principal: "test-operator",
    role: "admin",
  } as const;

  async function startChecked(npm: NpmCli, overrides: Partial<StartDaemonOptions> = {}) {
    const directory = await mkdtemp(join(tmpdir(), "simlock-main-version-"));
    temporaryDirectories.push(directory);
    const clock = new FakeClock(1_000);
    const sink = new MemoryLogSink();
    const daemon = await startDaemon({
      clock,
      configOverrides: overrides.role === "gateway" ? {} : STANDALONE_OFF,
      dataDirectory: directory,
      drivers: [],
      filesystem: new MemoryFilesystem(),
      hostLoadProbe: null,
      logger: new JsonLinesLogger({ clock, level: "debug", sink }),
      npm,
      version: "0.3.0",
      ...overrides,
    } as StartDaemonOptions);
    runningDaemons.push(daemon);
    return { clock, daemon, sink };
  }

  const latestOf = async (daemon: DaemonServer) =>
    ((await daemon.dispatch("status.get", {}, operator)) as { daemon: { latestVersion: unknown } })
      .daemon.latestVersion;

  it("a start of either role that fails at the socket claim or the admin.token write leaves no timer and asks npm no more", async () => {
    class SecretRefusingFilesystem extends MemoryFilesystem {
      override async writeFileAtomic(
        ...arguments_: Parameters<MemoryFilesystem["writeFileAtomic"]>
      ): Promise<void> {
        if (arguments_[0].endsWith("admin.token")) throw new Error("disk is read-only");
        return super.writeFileAtomic(...arguments_);
      }
    }
    class ListenRefusingTransport extends MemoryIpcTransport {
      override async listen(endpoint: string): Promise<never> {
        throw new IpcError("unknown", `listen EACCES: permission denied ${endpoint}`, undefined);
      }
    }
    const failedStart = async (role: "worker" | "gateway", refused: "listen" | "admin.token") => {
      const npm = new FakeNpmCli({ view: [{ ok: true, output: "0.4.0\n" }] });
      const directory = await mkdtemp(join(tmpdir(), "simlock-main-version-fail-"));
      temporaryDirectories.push(directory);
      const clock = new FakeClock(1_000);
      await expect(
        startDaemon({
          clock,
          configOverrides: role === "gateway" ? {} : STANDALONE_OFF,
          dataDirectory: directory,
          drivers: [],
          filesystem:
            refused === "admin.token" ? new SecretRefusingFilesystem() : new MemoryFilesystem(),
          hostLoadProbe: null,
          ipc: refused === "listen" ? new ListenRefusingTransport() : new MemoryIpcTransport(),
          logger: new NoopLogger(),
          npm,
          role,
          socketPath: join(directory, "daemon.sock"),
          version: "0.3.0",
        } as StartDaemonOptions),
      ).rejects.toThrow(refused === "listen" ? "listen EACCES" : "disk is read-only");
      // why: the answer is processed after the call; wait it out so a leaked next-check timer exists before it is counted.
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      const pending = clock.pendingTimerCount;
      clock.advance(2 * 24 * 60 * 60 * 1000);
      return { role, refused, calls: npm.calls.length, pending };
    };

    const outcomes = [];
    for (const role of ["worker", "gateway"] as const) {
      for (const refused of ["listen", "admin.token"] as const) {
        outcomes.push(await failedStart(role, refused));
      }
    }

    expect(outcomes).toEqual([
      { role: "worker", refused: "listen", calls: 1, pending: 0 },
      { role: "worker", refused: "admin.token", calls: 1, pending: 0 },
      { role: "gateway", refused: "listen", calls: 1, pending: 0 },
      { role: "gateway", refused: "admin.token", calls: 1, pending: 0 },
    ]);
  });

  it("a worker whose socket claim is refused disposes its drivers, and one that loses the claim to a live daemon leaves them to that daemon", async () => {
    class ListenFailingTransport extends MemoryIpcTransport {
      constructor(readonly code: "address-in-use" | "unknown") {
        super();
      }
      override async listen(endpoint: string): Promise<never> {
        throw new IpcError(this.code, `listen failed: ${endpoint}`, undefined);
      }
    }
    const failedStart = async (code: "address-in-use" | "unknown") => {
      const directory = await mkdtemp(join(tmpdir(), "simlock-main-claim-drivers-"));
      temporaryDirectories.push(directory);
      const clock = new FakeClock(1_000);
      const disposed: string[] = [];
      const driver = Object.assign(
        new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" }),
        {
          dispose: async () => {
            disposed.push("ios");
          },
        },
      );
      const error: unknown = await startDaemon({
        clock,
        configOverrides: STANDALONE_OFF,
        dataDirectory: directory,
        deviceDataTables: fakeDeviceDataTables,
        drivers: [driver],
        filesystem: new MemoryFilesystem(),
        hostLoadProbe: null,
        ipc: new ListenFailingTransport(code),
        logger: new NoopLogger(),
        npm: new FakeNpmCli({ view: [{ ok: true, output: "0.3.0\n" }] }),
        socketPath: join(directory, "daemon.sock"),
        version: "0.3.0",
      } as StartDaemonOptions).then(
        () => undefined,
        (rejection: unknown) => rejection,
      );
      return { name: (error as Error | undefined)?.name, disposed };
    };

    expect(await failedStart("unknown")).toEqual({ name: "IpcError", disposed: ["ios"] });
    expect(await failedStart("address-in-use")).toEqual({
      name: "DaemonAlreadyRunningError",
      disposed: [],
    });
  });

  it("a start of either role whose admin.token write fails after a daemon.stop was accepted rejects with the write's error, and only once that stop has run its one teardown", async () => {
    const failedStart = async (role: "worker" | "gateway") => {
      let seen!: (secret: string) => void;
      const secretSeen = new Promise<string>((resolve) => {
        seen = resolve;
      });
      let refuse!: () => void;
      const refused = new Promise<void>((resolve) => {
        refuse = resolve;
      });
      class SecretWithheldFilesystem extends MemoryFilesystem {
        override async writeFileAtomic(
          ...arguments_: Parameters<MemoryFilesystem["writeFileAtomic"]>
        ): Promise<void> {
          if (!arguments_[0].endsWith("admin.token")) return super.writeFileAtomic(...arguments_);
          seen(arguments_[1].trim());
          await refused;
          throw new Error("disk is read-only");
        }
      }
      const directory = await mkdtemp(join(tmpdir(), "simlock-main-stop-then-fail-"));
      temporaryDirectories.push(directory);
      const clock = new FakeClock(1_000);
      const sink = new MemoryLogSink();
      const ipc = new MemoryIpcTransport();
      const socketPath = join(directory, "daemon.sock");
      const disposed: string[] = [];
      const driver = Object.assign(
        new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" }),
        {
          dispose: async () => {
            disposed.push("ios");
          },
        },
      );
      const stoppedLines = () =>
        sink.records.filter((record) => record.message === "Daemon stopped").length;
      const settled = startDaemon({
        clock,
        // why: an HTTP frontend whose start the claim's hooks never began, so the stop's `stopAuxiliary` waits for the start to settle.
        configOverrides:
          role === "gateway"
            ? {}
            : { ...STANDALONE_OFF, http: { enabled: true, host: "127.0.0.1", port: 1 } },
        dataDirectory: directory,
        deviceDataTables: fakeDeviceDataTables,
        drivers: role === "gateway" ? [] : [driver],
        filesystem: new SecretWithheldFilesystem(),
        hostLoadProbe: null,
        ipc,
        logger: new JsonLinesLogger({ clock, level: "debug", sink }),
        npm: new FakeNpmCli({ view: [{ ok: true, output: "0.3.0\n" }] }),
        role,
        socketPath,
        version: "0.3.0",
      } as StartDaemonOptions).then(
        () => ({ outcome: "resolved" }),
        (error: unknown) => ({
          outcome: (error as Error).message,
          stoppedBefore: stoppedLines(),
          disposedBefore: [...disposed],
        }),
      );
      const secret = await secretSeen;
      const connection = await ipc.connect(socketPath);
      let received = "";
      connection.onData((chunk) => {
        received += chunk;
      });
      const send = (id: number, type: string, payload: unknown) =>
        connection.write(`${JSON.stringify({ id, payload, type })}\n`);
      await send(1, "hello", {
        clientVersion: "test",
        credential: secret,
        protocolVersion: DAEMON_PROTOCOL_VERSION,
      });
      await expect.poll(() => received).toContain('"role":"admin"');
      await send(2, "daemon.stop", {});
      await expect.poll(() => received).toContain('"stopping":true');

      refuse();
      const result = await Promise.race([
        settled,
        new Promise<{ outcome: string }>((resolve) =>
          setTimeout(() => resolve({ outcome: "still pending after 2 s" }), 2_000),
        ),
      ]);
      return { role, ...result, stoppedAfter: stoppedLines(), disposedAfter: disposed };
    };

    expect(await failedStart("worker")).toEqual({
      role: "worker",
      outcome: "disk is read-only",
      stoppedBefore: 1,
      disposedBefore: ["ios"],
      stoppedAfter: 1,
      disposedAfter: ["ios"],
    });
    expect(await failedStart("gateway")).toEqual({
      role: "gateway",
      outcome: "disk is read-only",
      stoppedBefore: 1,
      disposedBefore: [],
      stoppedAfter: 1,
      disposedAfter: [],
    });
  });

  it("a daemon runs the version check at start without delaying ready, then after 24 h, and reports a newer latest in status.get and the daemon.update query; npm failing or answering junk keeps the last value; a stopped daemon never schedules the next check", async () => {
    const pending: ((outcome: NpmOutcome) => void)[] = [];
    const npm: NpmCli = {
      view: () => new Promise<NpmOutcome>((resolve) => pending.push(resolve)),
      install: () => Promise.reject(new Error("unused")),
      globalRoot: () => Promise.reject(new Error("unused")),
    };
    const day = 24 * 60 * 60 * 1000;

    const { clock, daemon, sink } = await startChecked(npm);

    expect(pending).toHaveLength(1);
    expect(await latestOf(daemon)).toBeNull();
    pending[0]?.({ ok: true, output: "0.4.0\n" });
    await expect.poll(() => latestOf(daemon)).toBe("0.4.0");
    const query = (await daemon.dispatch("daemon.update", { query: true }, operator)) as {
      latestVersion: unknown;
    };
    expect(query.latestVersion).toBe("0.4.0");

    clock.advance(day - 1);
    expect(pending).toHaveLength(1);
    const later: NpmOutcome[] = [
      { ok: false, message: "npm did not finish within 30 seconds" },
      { ok: true, output: "not a version\n" },
      { ok: true, output: "0.5.0\n" },
    ];
    for (const [index, outcome] of later.entries()) {
      clock.advance(index === 0 ? 1 : day);
      await expect.poll(() => pending.length).toBe(index + 2);
      pending[index + 1]?.(outcome);
      const failed = index < 2;
      if (failed) {
        await expect
          .poll(() => sink.records.filter((record) => record.level === "warn").length)
          .toBe(index + 1);
      }
      await expect.poll(() => latestOf(daemon)).toBe(failed ? "0.4.0" : "0.5.0");
    }

    const off = new FakeNpmCli({ view: [{ ok: true, output: "0.9.0\n" }] });
    const disabled = await startChecked(off, { configOverrides: { update: { check: false } } });
    disabled.clock.advance(2 * day);
    expect(off.calls).toEqual([]);
    expect(await latestOf(disabled.daemon)).toBeNull();

    const stopping = await startChecked(npm);
    expect(pending).toHaveLength(5);
    await stopping.daemon.stop("test");
    pending[4]?.({ ok: true, output: "0.7.0\n" });
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    expect(stopping.clock.pendingTimerCount).toBe(0);

    // why: stopping while the next check is scheduled (no npm call in flight) must cancel that timer.
    const scheduled = new FakeNpmCli({ view: [{ ok: true, output: "0.8.0\n" }] });
    const idle = await startChecked(scheduled);
    await expect.poll(() => latestOf(idle.daemon)).toBe("0.8.0");
    await expect.poll(() => idle.clock.pendingTimerCount).toBeGreaterThan(0);
    const armed = idle.clock.pendingTimerCount;
    await idle.daemon.stop("test");
    expect(idle.clock.pendingTimerCount).toBeLessThan(armed);
    idle.clock.advance(2 * day);
    expect(scheduled.calls).toHaveLength(1);

    const gatewayNpm = new FakeNpmCli({ view: [{ ok: true, output: "0.6.0\n" }] });
    const gateway = await startChecked(gatewayNpm, { role: "gateway" });
    await expect.poll(() => latestOf(gateway.daemon)).toBe("0.6.0");
  });

  it("a gateway started by test-main's start helper and by this file's startChecked starts while 127.0.0.1:4700 is taken", async () => {
    // why: 4700 is a gateway's default port; a gateway running on the host holds it already.
    const holder = createServer();
    const held = await new Promise<boolean>((resolve, reject) => {
      holder.once("error", (error: NodeJS.ErrnoException) =>
        error.code === "EADDRINUSE" ? resolve(false) : reject(error),
      );
      holder.listen(4700, "127.0.0.1", () => resolve(true));
    });
    try {
      const outcomes = await Promise.allSettled([
        start({ role: "gateway" }),
        startChecked(new FakeNpmCli(), { role: "gateway" }),
      ]);

      expect(
        outcomes.map((outcome) =>
          outcome.status === "fulfilled" ? "started" : String(outcome.reason),
        ),
      ).toEqual(["started", "started"]);
    } finally {
      if (held) await new Promise<void>((resolve) => holder.close(() => resolve()));
    }
  });
});

describe("startDaemon gateway update", () => {
  const operator = {
    manageEventSubscription: () => undefined,
    via: "socket",
    principal: "test-operator",
    role: "admin",
  } as const;

  async function startUpdatable(
    launcher: FakeUpdaterLauncher,
    filesystem = new MemoryFilesystem(),
    given?: string,
  ) {
    await filesystem.mkdirp("/opt/simlock");
    const directory = given ?? (await mkdtemp(join(tmpdir(), "simlock-main-gw-update-")));
    if (given === undefined) temporaryDirectories.push(directory);
    const clock = new FakeClock(1_000);
    const daemon = await startDaemon({
      clock,
      configOverrides: {
        http: { enabled: true, host: "127.0.0.1", port: await freeLoopbackPort() },
      },
      dataDirectory: directory,
      drivers: [],
      filesystem,
      hostLoadProbe: null,
      logger: new NoopLogger(),
      npm: new FakeNpmCli({
        globalRoot: [{ ok: true, output: "/opt" }],
        view: [{ ok: true, output: "0.4.0" }],
      }),
      role: "gateway",
      updater: { launcher, otherRoleRunning: async () => false, packageRoot: "/opt/simlock" },
      version: "0.3.0",
    } as StartDaemonOptions);
    runningDaemons.push(daemon);
    return { daemon, directory, filesystem };
  }

  const daemonOf = async (daemon: DaemonServer) =>
    ((await daemon.dispatch("status.get", {}, operator)) as { daemon: Record<string, unknown> })
      .daemon;

  it("a failed install shows in the gateway's status.get as lastUpdateFailure, and the gateway keeps serving", async () => {
    const launcher = new FakeUpdaterLauncher({
      exit: 1,
      lines: [JSON.stringify({ failed: { message: "npm exited 1", stage: "installing" } })],
    });
    const { daemon } = await startUpdatable(launcher);

    await daemon.dispatch("daemon.update", {}, operator);

    await expect
      .poll(async () => (await daemonOf(daemon)).lastUpdateFailure)
      .toEqual({
        at: 1_000,
        from: "0.3.0",
        message: "npm exited 1",
        stage: "installing",
        to: "0.4.0",
      });
    expect(await daemonOf(daemon)).toMatchObject({ health: "running", update: null });
  });

  it("a gateway that starts after a rolled-back update reports the failure in status.get and announces daemon.update-failed", async () => {
    const filesystem = new MemoryFilesystem();
    const failure = {
      at: 900,
      from: "0.3.0",
      message: "the new version did not start",
      stage: "restarting",
      to: "0.4.0",
    };
    const directory = await mkdtemp(join(tmpdir(), "simlock-main-gw-rolled-back-"));
    temporaryDirectories.push(directory);
    await filesystem.mkdirp(directory);
    await filesystem.writeFileAtomic(
      join(directory, "update-result.json"),
      JSON.stringify(failure),
    );
    const { daemon } = await startUpdatable(new FakeUpdaterLauncher(), filesystem, directory);

    expect((await daemonOf(daemon)).lastUpdateFailure).toEqual(failure);
    await expect(
      daemon.dispatch("events.replay", {}, operator) as Promise<readonly { event: string }[]>,
    ).resolves.toContainEqual(expect.objectContaining({ event: "daemon.update-failed" }));
    await expect(filesystem.exists(join(directory, "update-result.json"))).resolves.toBe(false);
  });
});
