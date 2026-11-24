import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { STARTUP_READ_LIMIT_MS } from "../core/index.js";
import {
  FakeClock,
  FakeDaemonLauncher,
  IpcError,
  MemoryFilesystem,
  MemoryIpcTransport,
  NodeIpcTransport,
  resolveDaemonSocketPath,
  type IpcConnection,
  type IpcConnector,
  FakeSystemStats,
} from "../ports/index.js";
import { PROTOCOL_VERSION_RANGE } from "../contract/index.js";
import { runCli } from "./index.js";
import {
  EMPTY_STATUS,
  detachedGrant,
  gibibyte,
  outputCapture,
  realCliEnvironmentPorts,
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

describe("CLI: auto-launch's handshake cut short by the launched daemon (#684)", () => {
  it.each([
    { closeAfter: "hello", rejectedCredential: false },
    { closeAfter: "request", rejectedCredential: false },
    { closeAfter: "hello", rejectedCredential: true },
    { closeAfter: "request", rejectedCredential: true },
  ] as const)(
    "reports a daemon it launched that answers hello then dies during that start as a failed start, not a lost connection (after $closeAfter, credential rejected: $rejectedCredential)",
    async ({ closeAfter, rejectedCredential }) => {
      // why: this stages the daemon that loses its HTTP port race exactly as the socket shows it
      // to the CLI: absent before the launch, then listening, answering `hello`, and closing on
      // its own `http-start-failed` stop before the command's first real request is answered.
      const dyingDaemon = new HelloThenDeathIpc(closeAfter, rejectedCredential);
      const clock = new FakeClock(0);
      const launcher = new FakeDaemonLauncher(() => {
        dyingDaemon.startListening();
      });
      const output = outputCapture({
        filesystem: new MemoryFilesystem(),
        clock,
        systemStats: new FakeSystemStats({ cpuCount: 8, totalRamBytes: 32 * gibibyte }),
        ipc: dyingDaemon,
        launcher,
        daemonHome: { role: "worker", dataDirectory: "/simlock", gatewayPresent: false },
        homeDirectory: "/home/operator",
        workingDirectory: "/work/project",
        hostPlatform: "linux",
        runTool: async () => ({ outcome: "not-found" }),
      });
      let settled = false;
      const exitCode = runCli(
        ["daemon", "start", "--json", "--token", "probe"],
        output.environmentWith(),
      ).then((code) => {
        settled = true;
        return code;
      });
      // why: the tick bound is generous because #671 made every module a command loads lazy, so
      // one `daemon start` now passes through several more import turns than when this repro was
      // first staged; the clock is fake and the loop stops the moment the command settles, so the
      // extra headroom pins nothing -- it only keeps a hung command failing on this named
      // assertion instead of on a test timeout.
      for (let tick = 0; tick < 100 && !settled; tick += 1) {
        clock.advance(50);
        await settle();
        await settle();
      }
      expect(
        settled,
        `simlock daemon start still had not settled at ${String(clock.now())}ms`,
      ).toBe(true);

      // why: the staging itself, proven from the fake's side -- the socket was absent until this
      // command launched the daemon and answered `hello` before it closed the connection. Without
      // these the assertion below could be
      // reached by a connection that never saw a daemon at all.
      expect(launcher.launches).toBe(1);
      expect(dyingDaemon.helloReplies).toBe(1);
      expect(dyingDaemon.deaths).toBe(1);
      expect(dyingDaemon.rejectedCredentials).toBe(rejectedCredential ? 1 : 0);

      expect(await exitCode).toBe(1);
      expect(output.stdout).toBe("");
      expect(JSON.parse(output.stderr.trim().split("\n").at(-1)!)).toMatchObject({
        error: {
          code: "DAEMON_STARTUP_FAILED",
          message: expect.stringContaining("daemon"),
        },
      });
    },
  );

  it.each([false, true])(
    "keeps a pre-existing daemon's hello-then-close as DAEMON_CONNECTION_LOST (credential rejected: %s)",
    async (rejectedCredential) => {
      const dyingDaemon = new HelloThenDeathIpc("hello", rejectedCredential);
      dyingDaemon.startListening();
      const launcher = new FakeDaemonLauncher();
      const output = outputCapture({
        ...realCliEnvironmentPorts(),
        ipc: dyingDaemon,
        launcher,
      });

      expect(
        await runCli(["daemon", "start", "--json", "--token", "probe"], output.environmentWith()),
      ).toBe(1);
      expect(launcher.launches).toBe(0);
      expect(dyingDaemon.helloReplies).toBe(1);
      expect(dyingDaemon.deaths).toBe(1);
      expect(output.stdout).toBe("");
      expect(JSON.parse(output.stderr.trim().split("\n").at(-1)!)).toEqual({
        error: { code: "DAEMON_CONNECTION_LOST", message: "Daemon connection closed" },
      });
    },
  );

  it("reports a daemon that answers the startup status probe with DAEMON_STOPPING as its own start error and closes its client", async () => {
    const daemon = new HelloThenDeathIpc("stopping");
    const launcher = new FakeDaemonLauncher(() => daemon.startListening(), {
      exit: { code: 1, signal: null },
      output: `${JSON.stringify({ message: "Daemon failed to start", fields: { message: "listen EADDRINUSE: address already in use :::7777" } })}\n`,
    });
    const output = outputCapture({ ...realCliEnvironmentPorts(), ipc: daemon, launcher });
    expect(await runCli(["daemon", "start", "--token", "probe"], output.environmentWith())).toBe(1);
    expect(launcher.launches).toBe(1);
    expect(daemon.helloReplies).toBe(1);
    expect(daemon.clientCloses).toBe(1);
    expect(JSON.parse(output.stderr)).toMatchObject({
      error: {
        code: "DAEMON_STARTUP_FAILED",
        message: "The daemon could not start: listen EADDRINUSE: address already in use :::7777",
      },
    });
  });

  // why: each of its 2,000-odd ticks waits one real `setTimeout(0)`, about 13 ms on a Windows PC and
  // under 1 ms elsewhere, so the whole run takes 26 s there.
  it(
    "daemon start's wait for health to leave starting ends past the daemon's startup-read cap with DAEMON_STARTUP_FAILED, leaving the daemon running",
    { timeout: 60_000 },
    async () => {
      const daemon = new HelloThenDeathIpc("starting");
      const clock = new FakeClock(0);
      const launcher = new FakeDaemonLauncher(() => daemon.startListening());
      const output = outputCapture({ ...realCliEnvironmentPorts(), ipc: daemon, clock, launcher });
      let settled = false;
      const run = runCli(["daemon", "start", "--token", "probe"], output.environmentWith()).then(
        (code) => {
          settled = true;
          return code;
        },
      );
      for (let tick = 0; tick < 3_000 && !settled; tick += 1) {
        clock.advance(50);
        await settle();
      }
      expect(settled, `daemon start still waiting at ${String(clock.now())}ms`).toBe(true);
      expect(
        clock.now(),
        "the wait outlasts the daemon's own startup read by 30 s",
      ).toBeGreaterThanOrEqual(STARTUP_READ_LIMIT_MS + 30_000);
      expect(await run).toBe(1);
      expect(daemon.frameTypes, "the CLI sends the daemon no stop").not.toContain("daemon.stop");
      expect(daemon.deaths, "the daemon is not stopped by the CLI").toBe(0);
      expect(JSON.parse(output.stderr)).toMatchObject({
        error: {
          code: "DAEMON_STARTUP_FAILED",
          message: expect.stringContaining("still starting"),
        },
      });
    },
  );

  it("bounds the startup status probe by the original launch deadline and closes its client", async () => {
    const daemon = new HelloThenDeathIpc("silent");
    const clock = new FakeClock(0);
    const launcher = new FakeDaemonLauncher(() => {
      clock.setTimer(19_000, () => daemon.startListening());
    });
    const output = outputCapture({ ...realCliEnvironmentPorts(), ipc: daemon, clock, launcher });
    let settled = false;
    const run = runCli(["daemon", "start", "--token", "probe"], output.environmentWith()).then(
      (code) => {
        settled = true;
        return code;
      },
    );
    for (let tick = 0; tick < 500 && !settled; tick += 1) {
      clock.advance(50);
      await settle();
    }
    expect(settled, "silent startup probe must settle within the launch budget").toBe(true);
    expect(
      clock.now(),
      "probe must use the budget left after the socket appeared",
    ).toBeLessThanOrEqual(20_050);
    expect(clock.now(), "probe must wait out the launch deadline").toBeGreaterThanOrEqual(20_000);
    expect(await run).toBe(1);
    expect(launcher.launches).toBe(1);
    expect(daemon.helloReplies).toBe(1);
    expect(daemon.clientCloses).toBe(1);
    expect(JSON.parse(output.stderr)).toMatchObject({
      error: {
        code: "DAEMON_STARTUP_FAILED",
        message: expect.stringContaining("Timed out starting"),
      },
    });
  });

  it("fails a start with DAEMON_STARTUP_FAILED when the daemon stops reading after hello, without waiting for its side of the close", async () => {
    const directory = await mkdtemp(join(tmpdir(), "simlock-wedged-"));
    temporaryDirectories.push(directory);
    const socketPath = resolveDaemonSocketPath(directory);
    const sockets: Socket[] = [];
    let hellos = 0;
    const server = createServer((socket) => {
      sockets.push(socket);
      let buffered = "";
      socket.on("data", (chunk) => {
        buffered += chunk.toString();
        for (const line of buffered.split("\n").slice(0, -1)) {
          const frame = JSON.parse(line) as { id: number; type: string };
          if (frame.type !== "hello") continue;
          hellos += 1;
          socket.write(
            `${JSON.stringify({
              id: frame.id,
              ok: true,
              payload: {
                protocolVersion: PROTOCOL_VERSION_RANGE.max,
                daemonProtocolRange: PROTOCOL_VERSION_RANGE,
                version: "0.0.0-test",
                role: "admin",
                principal: "test-requester",
              },
            })}\n`,
          );
          // why: a daemon wedged after `hello` neither answers nor ends its side of the socket.
          socket.pause();
        }
        buffered = buffered.slice(buffered.lastIndexOf("\n") + 1);
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      const real = new NodeIpcTransport();
      let launched = false;
      const clock = new FakeClock(0);
      const launcher = new FakeDaemonLauncher(() => {
        launched = true;
      });
      let probeSent = false;
      const ipc: IpcConnector = {
        connect: async () => {
          if (!launched) throw new IpcError("endpoint-not-found", "not yet", undefined);
          const connection = await real.connect(socketPath);
          const write = connection.write.bind(connection);
          connection.write = async (contents) => {
            await write(contents);
            if ((JSON.parse(contents.trim()) as { type: string }).type === "status.get") {
              probeSent = true;
            }
          };
          return connection;
        },
      };
      const output = outputCapture({ ...realCliEnvironmentPorts(), ipc, clock, launcher });
      let settled = false;
      const run = runCli(["daemon", "start", "--token", "probe"], output.environmentWith()).then(
        (code) => {
          settled = true;
          return code;
        },
      );
      for (let tick = 0; tick < 200 && hellos === 0; tick += 1) {
        clock.advance(50);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(hellos).toBe(1);
      // why: the server observing hello does not mean the client has read its reply and armed
      // the probe deadline; advance the fake clock only after the client sends that probe.
      await expect.poll(() => probeSent).toBe(true);
      clock.advance(20_000);
      await expect.poll(() => settled, { timeout: 2_000 }).toBe(true);
      expect(await run).toBe(1);
      expect(JSON.parse(output.stderr)).toMatchObject({
        error: { code: "DAEMON_STARTUP_FAILED" },
      });
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("exits 1 for a socket closed before hello and reports DAEMON_STARTUP_FAILED only after launch", async () => {
    for (const scenario of [
      { launch: false, afterExit: false, code: "DAEMON_CONNECTION_LOST", connects: 1 },
      { launch: true, afterExit: false, code: "DAEMON_STARTUP_FAILED", connects: 2 },
      { launch: true, afterExit: true, code: "DAEMON_STARTUP_FAILED", connects: 3 },
    ]) {
      const directory = await mkdtemp(join(tmpdir(), "simlock-closed-"));
      temporaryDirectories.push(directory);
      const socketPath = resolveDaemonSocketPath(directory);
      let accepted = 0;
      // why: the daemon that refuses its history accepts the CLI's connection, then stops and
      // closes it; the CLI is still reading `admin.token` then, so the close lands before `hello`.
      const server = createServer((socket) => {
        accepted += 1;
        socket.destroy();
      });
      await new Promise<void>((resolve) => server.listen(socketPath, resolve));
      try {
        const real = new NodeIpcTransport();
        let launched = !scenario.launch;
        const clock = new FakeClock(0);
        const launcher = new FakeDaemonLauncher(
          () => {
            launched = true;
          },
          { exit: { code: 1, signal: null } },
        );
        let connects = 0;
        const ipc: IpcConnector = {
          connect: async () => {
            connects += 1;
            if (!launched || (scenario.afterExit && connects === 2)) {
              throw new IpcError("endpoint-not-found", "not yet", undefined);
            }
            const connection = await real.connect(socketPath);
            await expect.poll(() => connection.closed).toBe(true);
            return connection;
          },
        };
        const output = outputCapture({ ...realCliEnvironmentPorts(), ipc, clock, launcher });
        let settled = false;
        const run = runCli(["daemon", "start", "--token", "probe"], output.environmentWith()).then(
          (code) => {
            settled = true;
            return code;
          },
        );
        for (let tick = 0; tick < 100 && !settled; tick += 1) {
          clock.advance(50);
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        expect(launcher.launches).toBe(scenario.launch ? 1 : 0);
        expect(accepted).toBe(1);
        expect(connects).toBe(scenario.connects);
        expect(
          settled,
          `simlock daemon start still had not settled at ${String(clock.now())}ms`,
        ).toBe(true);
        expect(await run).toBe(1);
        expect(output.stdout).toBe("");
        expect(JSON.parse(output.stderr.trim().split("\n").at(-1)!)).toMatchObject({
          error: { code: scenario.code },
        });
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  });

  it.each([
    { operation: "pending lease", health: "running" },
    { operation: "pending lease", health: "starting" },
    { operation: "held lease", health: "running" },
    { operation: "in-flight request", health: "running" },
  ] as const)(
    "keeps an auto-launched daemon's death after its startup status probe as DAEMON_CONNECTION_LOST during $operation (status: $health)",
    async ({ operation, health }) => {
      const ipc = new MemoryIpcTransport();
      const clock = new FakeClock(0);
      const requests: string[] = [];
      const replies: string[] = [];
      const connections: IpcConnection[] = [];
      const launcher = new FakeDaemonLauncher(async () => {
        await ipc.listen("/simlock/daemon.sock", (connection) => {
          connections.push(connection);
          connection.onData((contents) => {
            const frame = JSON.parse(contents) as { id: number; type: string };
            requests.push(frame.type);
            const payload =
              frame.type === "hello"
                ? {
                    protocolVersion: PROTOCOL_VERSION_RANGE.max,
                    daemonProtocolRange: PROTOCOL_VERSION_RANGE,
                    version: "0.0.0-test",
                    role: "admin",
                    principal: "test-requester",
                  }
                : frame.type === "lease.request" && operation !== "pending lease"
                  ? detachedGrant
                  : frame.type === "status.get"
                    ? { ...EMPTY_STATUS, daemon: { ...EMPTY_STATUS.daemon, health } }
                    : undefined;
            if (payload === undefined) return;
            replies.push(frame.type);
            void connection.write(`${JSON.stringify({ id: frame.id, ok: true, payload })}\n`);
          });
        });
      });
      const output = outputCapture({
        ...realCliEnvironmentPorts(),
        ipc,
        clock,
        launcher,
      });
      let settled = false;
      const runPromise = runCli(
        operation !== "in-flight request"
          ? ["lease", "--platform", "ios", "--device", "iPhone 17 Pro", "--token", "probe"]
          : ["simctl", "list", "--token", "probe"],
        output.environmentWith(),
      ).then((code) => {
        settled = true;
        return code;
      });
      const ready = (): boolean =>
        operation === "held lease"
          ? output.stdout !== ""
          : requests.includes(
              operation === "pending lease" ? "lease.request" : "driver.passthrough",
            );
      for (let tick = 0; tick < 100 && !ready() && !settled; tick += 1) {
        clock.advance(50);
        await settle();
        await settle();
      }
      expect(ready()).toBe(true);
      expect(settled).toBe(false);
      expect(launcher.launches).toBe(1);
      expect(connections).toHaveLength(1);
      expect(requests).toContain(
        operation === "in-flight request" ? "driver.passthrough" : "lease.request",
      );
      if (operation === "pending lease") expect(replies).not.toContain("lease.request");
      await connections[0]!.close();
      expect(await runPromise).toBe(1);
      expect(JSON.parse(output.stderr)).toMatchObject({
        error: { code: "DAEMON_CONNECTION_LOST" },
      });
      expect(replies).toContain("status.get");
      if (operation === "held lease") {
        expect(JSON.parse(output.stdout)).toMatchObject({ lease: detachedGrant.lease });
        expect(JSON.parse(output.stderr).error.message).toContain(detachedGrant.lease.id);
        expect(requests).toContain("lease.request");
      } else {
        expect(output.stdout).toBe("");
      }
    },
  );

  it("preserves the daemon's refusal of the first auto-launched request", async () => {
    const filesystem = new MemoryFilesystem();
    const ipc = new MemoryIpcTransport();
    const launcher = new FakeDaemonLauncher(async () => {
      await startInMemoryDaemon({
        filesystem,
        ipcTransport: ipc,
        socketPath: "/simlock/daemon.sock",
        adminTokenPath: "/simlock/admin.token",
      });
    });
    const output = outputCapture({
      ...realCliEnvironmentPorts(),
      filesystem,
      ipc,
      launcher,
    });

    expect(
      await runCli(["lease", "--platform", "android", "--detach"], output.environmentWith()),
    ).toBe(12);
    expect(launcher.launches).toBe(1);
    expect(output.stdout).toBe("");
    expect(JSON.parse(output.stderr)).toMatchObject({ error: { code: "NO_DRIVER" } });
  });
});

class HelloThenDeathIpc implements IpcConnector {
  helloReplies = 0;
  deaths = 0;
  readonly frameTypes: string[] = [];
  #listening = false;

  rejectedCredentials = 0;
  clientCloses = 0;

  constructor(
    readonly closeAfter: "hello" | "request" | "silent" | "stopping" | "starting" = "hello",
    readonly rejectCredential = false,
  ) {}

  startListening(): void {
    this.#listening = true;
  }

  async connect(): Promise<IpcConnection> {
    if (!this.#listening) {
      throw new IpcError("endpoint-not-found", "No IPC endpoint yet", undefined);
    }
    return new HelloThenDeathConnection(this);
  }
}

class HelloThenDeathConnection implements IpcConnection {
  readonly #dataListeners = new Set<(chunk: string) => void>();
  readonly #closeListeners = new Set<() => void>();
  #closed = false;

  constructor(private readonly daemon: HelloThenDeathIpc) {}

  get closed(): boolean {
    return this.#closed;
  }

  onData(listener: (chunk: string) => void): () => void {
    this.#dataListeners.add(listener);
    return () => this.#dataListeners.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  onError(): () => void {
    return () => {};
  }

  async write(contents: string): Promise<void> {
    if (this.#closed) return;
    let answeredHello = false;
    for (const line of contents.split("\n")) {
      answeredHello = this.#receiveFrame(line) || answeredHello;
      if (this.#closed) return;
    }
    if (
      this.daemon.closeAfter === "hello" ||
      (!answeredHello && this.daemon.closeAfter === "request")
    )
      this.#shutDown(true);
  }

  #receiveFrame(line: string): boolean {
    if (line.trim() === "") return false;
    const frame = JSON.parse(line) as {
      id?: unknown;
      type?: unknown;
      payload?: { credential?: string };
    };
    if (typeof frame.type === "string") this.daemon.frameTypes.push(frame.type);
    if (frame.type === "status.get") this.#answerStatus(frame.id);
    if (frame.type !== "hello" || typeof frame.id !== "number") return false;
    this.#answerHello(frame.id, frame.payload?.credential);
    return true;
  }

  #answerStatus(id: unknown): void {
    const { closeAfter } = this.daemon;
    if (closeAfter !== "stopping" && closeAfter !== "starting") return;
    const reply =
      closeAfter === "stopping"
        ? {
            id,
            ok: false,
            error: { code: "DAEMON_STOPPING", message: "Daemon is stopping", details: {} },
          }
        : {
            id,
            ok: true,
            payload: {
              daemon: {
                health: "starting",
                mode: "worker",
                version: "0.0.0-test",
                update: null,
                lastUpdateFailure: null,
                latestVersion: null,
              },
              host: { arch: "arm64", os: "macOS", osVersion: "15.5", tools: [] },
            },
          };
    for (const listener of this.#dataListeners) listener(`${JSON.stringify(reply)}\n`);
  }

  #answerHello(id: number, credential: string | undefined): void {
    if (this.daemon.rejectCredential && credential !== undefined) {
      this.daemon.rejectedCredentials += 1;
      const reply = {
        id: id,
        ok: false,
        error: {
          code: "ADMIN_AUTHENTICATION_FAILED",
          message: "Rejected credential",
          details: {},
        },
      };
      for (const listener of this.#dataListeners) listener(`${JSON.stringify(reply)}\n`);
      this.#shutDown(false);
      return;
    }
    this.daemon.helloReplies += 1;
    const reply = {
      id: id,
      ok: true,
      payload: {
        protocolVersion: PROTOCOL_VERSION_RANGE.max,
        daemonProtocolRange: PROTOCOL_VERSION_RANGE,
        version: "0.0.0-test",
        role: "admin",
        principal: "test-requester",
      },
    };
    for (const listener of this.#dataListeners) listener(`${JSON.stringify(reply)}\n`);
  }

  async close(): Promise<void> {
    this.daemon.clientCloses += 1;
    this.#shutDown(false);
  }

  #shutDown(killedByDaemon: boolean): void {
    if (this.#closed) return;
    this.#closed = true;
    if (killedByDaemon) this.daemon.deaths += 1;
    for (const listener of this.#closeListeners) listener();
  }
}
