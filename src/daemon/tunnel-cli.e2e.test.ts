import { mkdtemp, rm } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildCliEnvironment, runCli } from "../cli/index.js";
import { FakeDeviceTcp, FakeDriver, fakeDeviceDataTables } from "../core/testing.js";
import {
  FakeClock,
  FakeDaemonLauncher,
  FakeSystemStats,
  MemoryFilesystem,
  MemoryIpcTransport,
  NoopLogger,
  SystemClock,
} from "../ports/index.js";
import type { DispatchSession } from "./dispatch.js";
import { startDaemon } from "./main.js";
import type { DaemonServer } from "./server.js";

async function freeLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (typeof address !== "object" || address === null) throw new Error("no port bound");
  return address.port;
}

const admin: DispatchSession = {
  manageEventSubscription: () => undefined,
  via: "socket",
  principal: "test-operator",
  role: "admin",
};

const agent: DispatchSession = {
  manageEventSubscription: () => undefined,
  via: "socket",
  principal: "agent-1",
  role: "agent",
};

type Listener = () => void;

// why: the CLI's signal source, so a test sends Ctrl-C without signalling the test process.
class TestSignals {
  readonly #listeners = new Map<string, Set<Listener>>();
  on(signal: string, listener: Listener): this {
    const set = this.#listeners.get(signal) ?? new Set<Listener>();
    set.add(listener);
    this.#listeners.set(signal, set);
    return this;
  }
  off(signal: string, listener: Listener): this {
    this.#listeners.get(signal)?.delete(listener);
    return this;
  }
  emit(signal: string): void {
    for (const listener of this.#listeners.get(signal) ?? []) listener();
  }
}

describe("simlock tunnel against a lone worker", () => {
  const daemons: DaemonServer[] = [];
  const directories: string[] = [];
  const servers: Server[] = [];
  const sockets: Socket[] = [];

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.destroy();
    await Promise.all(
      servers
        .splice(0)
        .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
    await Promise.all(daemons.splice(0).map((daemon) => daemon.stop("test")));
    await Promise.all(
      directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
    );
  });

  async function worker() {
    const port = await freeLoopbackPort();
    const path = await mkdtemp(join(tmpdir(), "simlock-e2e-tunnel-cli-"));
    directories.push(path);
    const deviceTcp = new FakeDeviceTcp();
    const daemon = await startDaemon({
      configOverrides: {
        capabilities: { tunnel: { enabled: true } },
        http: { enabled: true, host: "127.0.0.1", port },
      },
      dataDirectory: path,
      deviceDataTables: fakeDeviceDataTables,
      drivers: [
        new FakeDriver({
          availableOsVersions: ["18.0"],
          clock: new SystemClock(),
          deviceTcp,
          knownModels: ["Pixel-A"],
          platform: "android",
        }),
      ],
      filesystem: new MemoryFilesystem(),
      logger: new NoopLogger(),
      version: "1.0.0-e2e",
    });
    daemons.push(daemon);
    const holder = await daemon.dispatch("token.create", { label: "holder", role: "agent" }, admin);
    const granted = await daemon.dispatch(
      "lease.request",
      { model: "Pixel-A", platform: "android" },
      { ...agent, principal: holder.token.id },
    );
    return {
      deviceTcp,
      leaseId: (granted as { lease: { id: string } }).lease.id,
      token: holder.secret,
      url: `http://127.0.0.1:${String(port)}`,
    };
  }

  async function callerServer(received: string[]): Promise<number> {
    const server = createServer((socket) => {
      sockets.push(socket);
      socket.on("data", (chunk) => {
        received.push(chunk.toString("utf8"));
        socket.write("from-caller");
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("no port bound");
    return address.port;
  }

  function command(env: NodeJS.ProcessEnv) {
    const signals = new TestSignals();
    const out: string[] = [];
    const err: string[] = [];
    const environment = buildCliEnvironment(
      {
        clock: new FakeClock(0),
        daemonHome: { dataDirectory: "/unused", gatewayPresent: false, role: "worker" },
        filesystem: new MemoryFilesystem(),
        homeDirectory: "/home/caller",
        hostPlatform: process.platform,
        ipc: new MemoryIpcTransport(),
        launcher: new FakeDaemonLauncher(),
        runTool: async () => ({ outcome: "not-found" }),
        signals,
        stderr: { write: (value) => err.push(value) },
        stdout: { write: (value) => out.push(value) },
        systemStats: new FakeSystemStats({ cpuCount: 2, totalRamBytes: 2 ** 30 }),
        workingDirectory: "/work",
      },
      env,
    );
    return {
      err,
      out,
      run: (argv: readonly string[]) => runCli(argv, environment),
      signals,
    };
  }

  it("opens a reverse tunnel, carries bytes, refuses with the worker's code, and its rules are gone after Ctrl-C", async () => {
    const lone = await worker();
    const received: string[] = [];
    const callerPort = await callerServer(received);
    const cli = command({ SIMLOCK_TOKEN: lone.token, SIMLOCK_URL: lone.url });

    const exit = cli.run(["tunnel", "reverse", `5173:${String(callerPort)}`]);
    await vi.waitFor(() => expect(cli.out.join("")).toContain("reverse device:5173"), {
      timeout: 10_000,
    });
    expect(cli.out.join("")).toBe(
      `reverse device:5173 -> localhost:${String(callerPort)} (lease ${lone.leaseId})\n`,
    );
    expect(lone.deviceTcp.reversed).toEqual([5173]);

    const peer = lone.deviceTcp.openFromDevice(5173);
    peer.send("from-device");
    await vi.waitFor(() => expect(received.join("")).toBe("from-device"), { timeout: 10_000 });
    await vi.waitFor(() => expect(peer.writtenText()).toBe("from-caller"), { timeout: 10_000 });

    cli.signals.emit("SIGINT");
    expect(await exit).toBe(0);
    await vi.waitFor(() => expect(lone.deviceTcp.reversed).toEqual([]), { timeout: 10_000 });
    expect(cli.err.join("")).toBe("");

    const refused = command({ SIMLOCK_TOKEN: lone.token, SIMLOCK_URL: lone.url });
    const refusedExit = refused.run(["tunnel", "reverse", "80"]);
    await vi.waitFor(() => expect(refused.err.join("")).not.toBe(""), { timeout: 10_000 });
    expect(await refusedExit).toBe(1);
    expect(refused.out.join("")).toBe("");
    expect(JSON.parse(refused.err.join(""))).toEqual({
      error: {
        code: "TUNNEL_BAD_PORT",
        message: `Lease ${lone.leaseId}: reverse 80: device ports are 1024 to 65535`,
      },
    });
  });

  async function callerClient(port: number, received: string[]): Promise<Socket> {
    const socket = connect({ host: "127.0.0.1", port });
    sockets.push(socket);
    socket.on("error", () => undefined);
    socket.on("data", (chunk) => received.push(chunk.toString("utf8")));
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    return socket;
  }

  it("a user runs simlock tunnel forward and the caller's loopback port reaches the device port", async () => {
    const lone = await worker();
    lone.deviceTcp.listening.add(9229);
    const callerPort = await freeLoopbackPort();
    const closedPort = await freeLoopbackPort();
    const cli = command({ SIMLOCK_TOKEN: lone.token, SIMLOCK_URL: lone.url });

    const exit = cli.run([
      "tunnel",
      "forward",
      `9229:${String(callerPort)}`,
      "forward",
      `9230:${String(closedPort)}`,
    ]);
    await vi.waitFor(() => expect(cli.out.join("")).not.toBe(""), { timeout: 10_000 });
    expect(cli.out.join("")).toBe(
      `forward localhost:${String(callerPort)} -> device:9229 (lease ${lone.leaseId})
forward localhost:${String(closedPort)} -> device:9230 (lease ${lone.leaseId})
`,
    );

    const received: string[] = [];
    const client = await callerClient(callerPort, received);
    client.write("from-caller");
    await vi.waitFor(() => expect(lone.deviceTcp.connections).toHaveLength(1), {
      timeout: 10_000,
    });
    const device = lone.deviceTcp.connections[0];
    expect(device?.devicePort).toBe(9229);
    await vi.waitFor(() => expect(device?.peer.writtenText()).toBe("from-caller"), {
      timeout: 10_000,
    });
    device?.peer.send("from-device");
    await vi.waitFor(() => expect(received.join("")).toBe("from-device"), { timeout: 10_000 });

    expect(device?.peer.writeEnded).toBe(false);
    client.end();
    await vi.waitFor(() => expect(device?.peer.writeEnded).toBe(true), { timeout: 10_000 });

    const refused = await callerClient(closedPort, []);
    refused.write("nobody home");
    await vi.waitFor(() => expect(refused.readyState).toBe("closed"), { timeout: 10_000 });
    expect(lone.deviceTcp.connections).toHaveLength(1);

    cli.signals.emit("SIGINT");
    expect(await exit).toBe(0);
    expect(cli.err.join("")).toBe("");
    await expect(callerClient(callerPort, [])).rejects.toMatchObject({ code: "ECONNREFUSED" });
  });
});
