import { describe, expect, it, vi } from "vitest";

import {
  TUNNEL_MAX_DATA_BYTES,
  TUNNEL_TAG,
  decodeTunnelFrame,
  encodeTunnelFrame,
} from "../contract/index.js";
import { buildCliEnvironment, runCli } from "./index.js";
import {
  FakeClock,
  FakeDaemonLauncher,
  FakeHttpJsonClient,
  FakeSystemStats,
  FakeTcpListenerFactory,
  FakeTcpStreamConnector,
  FakeWebSocketClientConnector,
  WebSocketRefusedError,
  MemoryFilesystem,
  MemoryIpcTransport,
} from "../ports/index.js";

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

function command(env: NodeJS.ProcessEnv) {
  const signals = new TestSignals();
  const out: string[] = [];
  const err: string[] = [];
  const webSocket = new FakeWebSocketClientConnector();
  const httpJson = new FakeHttpJsonClient();
  const clock = new FakeClock(0);
  const tcpStreams = new FakeTcpStreamConnector();
  const tcpListeners = new FakeTcpListenerFactory();
  const environment = buildCliEnvironment(
    {
      clock,
      daemonHome: { dataDirectory: "/unused", gatewayPresent: false, role: "worker" },
      filesystem: new MemoryFilesystem(),
      homeDirectory: "/home/caller",
      hostPlatform: "linux",
      httpJson,
      ipc: new MemoryIpcTransport(),
      launcher: new FakeDaemonLauncher(),
      runTool: async () => ({ outcome: "not-found" }),
      signals,
      stderr: { write: (value) => err.push(value) },
      stdout: { write: (value) => out.push(value) },
      systemStats: new FakeSystemStats({ cpuCount: 2, totalRamBytes: 2 ** 30 }),
      tcpListeners,
      tcpStreams,
      webSocket,
      workingDirectory: "/work",
    },
    env,
  );
  return {
    clock,
    err,
    httpJson,
    out,
    run: (argv: readonly string[]) => runCli(argv, environment),
    signals,
    tcpListeners,
    tcpStreams,
    webSocket,
  };
}

const READY = encodeTunnelFrame(TUNNEL_TAG.ready, 0, "{}");

const ENV = { SIMLOCK_TOKEN: "sk_agent_x", SIMLOCK_URL: "http://127.0.0.1:7300" };

describe("simlock tunnel that cannot run", () => {
  it("exits 2 with a USAGE line, before it connects anywhere, for each bad invocation", async () => {
    const accepted = command(ENV);
    const acceptedExit = accepted.run(["tunnel", "reverse", "5173", "--lease", "L1"]);
    await vi.waitFor(() => expect(accepted.webSocket.connections).toHaveLength(1));
    expect(accepted.webSocket.connections[0]?.url).toBe("ws://127.0.0.1:7300/v1/leases/L1/tunnel");
    accepted.signals.emit("SIGINT");
    expect(await acceptedExit).toBe(0);

    const longest = command({
      SIMLOCK_TOKEN: "t".repeat(4096),
      SIMLOCK_URL: `https://${"a".repeat(2040)}`,
    });
    const longestExit = longest.run(["tunnel", "reverse", "5173", "--lease", "L".repeat(256)]);
    await vi.waitFor(() => expect(longest.webSocket.connections).toHaveLength(1));
    longest.signals.emit("SIGINT");
    expect(await longestExit).toBe(0);

    const floor = command(ENV);
    const floorExit = floor.run(["tunnel", "forward", "9229:1024", "--lease", "L1"]);
    await vi.waitFor(() => expect(floor.webSocket.connections).toHaveLength(1));
    expect(floor.tcpListeners.listeners.map((listener) => listener.port)).toEqual([1024]);
    floor.signals.emit("SIGINT");
    expect(await floorExit).toBe(0);

    const cases: readonly {
      readonly argv: readonly string[];
      readonly env?: NodeJS.ProcessEnv;
      readonly lease?: string;
      readonly message: string;
    }[] = [
      {
        argv: ["reverse", "70000"],
        message: 'device port "70000" is not an integer from 1 to 65535',
      },
      {
        argv: ["reverse", "65536"],
        message: 'device port "65536" is not an integer from 1 to 65535',
      },
      { argv: ["reverse", "abc"], message: 'device port "abc" is not an integer from 1 to 65535' },
      {
        argv: ["reverse", "5173:"],
        message: 'caller port "" is not an integer from 1 to 65535',
      },
      {
        argv: ["reverse", "5173:0"],
        message: 'caller port "0" is not an integer from 1 to 65535',
      },
      {
        argv: [],
        message: "Name at least one tunnel: reverse|forward <device-port>[:<caller-port>]",
      },
      {
        argv: ["reverse", "5173", "reverse", "6000:5173"],
        message: "Caller port 5173 is named by two tunnels",
      },
      {
        argv: ["forward", "9229:80"],
        message: 'forward caller port "80" is below 1024',
      },
      {
        argv: ["forward", "9229:1023"],
        message: 'forward caller port "1023" is below 1024',
      },
      {
        argv: ["reverse", "5173", "forward", "5173"],
        message: "Caller port 5173 is named by two tunnels",
      },
      {
        argv: ["sideways", "5173"],
        message: 'Unknown tunnel kind "sideways": use reverse or forward',
      },
      {
        argv: ["--url", "http://10.0.0.5:7300", "reverse", "5173"],
        message: "--url must be https://, or http:// only for 127.0.0.1, [::1] or localhost",
      },
      {
        argv: ["reverse", "5173"],
        env: { SIMLOCK_TOKEN: "sk_agent_x" },
        message: "No worker URL: pass --url or set SIMLOCK_URL",
      },
      {
        argv: ["reverse", "5173"],
        env: { SIMLOCK_URL: "http://127.0.0.1:7300" },
        message: "No token: pass --token or set SIMLOCK_TOKEN",
      },
      {
        argv: ["reverse", "5173"],
        lease: "",
        message: "--lease must be 1 to 256 characters",
      },
      {
        argv: ["reverse", "5173"],
        lease: "L".repeat(257),
        message: "--lease must be 1 to 256 characters",
      },
      {
        argv: ["reverse", "5173"],
        env: { ...ENV, SIMLOCK_URL: `https://${"a".repeat(2041)}` },
        message: "--url must be https://, or http:// only for 127.0.0.1, [::1] or localhost",
      },
      {
        argv: ["reverse", "5173"],
        env: { ...ENV, SIMLOCK_TOKEN: "t".repeat(4097) },
        message: "No token: pass --token or set SIMLOCK_TOKEN",
      },
      {
        argv: Array.from({ length: 9 }, (_, index) => ["reverse", String(5000 + index)]).flat(),
        message: "At most 8 tunnels",
      },
    ];
    for (const { argv, env, lease, message } of cases) {
      const cli = command(env ?? ENV);
      const exit = cli.run(["tunnel", ...argv, "--lease", lease ?? "L1"]);
      await vi.waitFor(() =>
        expect({ argv, err: cli.err.join("") }).not.toEqual({ argv, err: "" }),
      );
      expect(await exit).toBe(2);
      expect({ argv, error: JSON.parse(cli.err.join("")) }).toEqual({
        argv,
        error: { error: { code: "USAGE", message } },
      });
      expect(cli.webSocket.connections).toEqual([]);
      expect(cli.httpJson.requests).toEqual([]);
    }
  });
});

describe("simlock tunnel that runs", () => {
  it("prints one line per tunnel, naming the lease the flags, the token or its only lease gave", async () => {
    const ok: readonly {
      readonly argv: readonly string[];
      readonly env?: NodeJS.ProcessEnv;
      readonly lines: readonly string[];
      readonly url: string;
      readonly authorization?: string;
    }[] = [
      {
        argv: ["reverse", "65535:1", "--lease", "L1"],
        lines: ["reverse device:65535 -> localhost:1 (lease L1)"],
        url: "ws://127.0.0.1:7300/v1/leases/L1/tunnel",
      },
      {
        argv: ["reverse", "5173", "--lease", "L1"],
        lines: ["reverse device:5173 -> localhost:5173 (lease L1)"],
        url: "ws://127.0.0.1:7300/v1/leases/L1/tunnel",
      },
      {
        argv: ["reverse", "8081:3000", "reverse", "9000", "--lease", "L1"],
        lines: [
          "reverse device:8081 -> localhost:3000 (lease L1)",
          "reverse device:9000 -> localhost:9000 (lease L1)",
        ],
        url: "ws://127.0.0.1:7300/v1/leases/L1/tunnel",
      },
      {
        argv: [
          "--url",
          "https://worker.example:7400/",
          "--token",
          "sk_flag",
          "reverse",
          "5173",
          "--lease",
          "L 2",
        ],
        authorization: "Bearer sk_flag",
        lines: ["reverse device:5173 -> localhost:5173 (lease L 2)"],
        url: "wss://worker.example:7400/v1/leases/L%202/tunnel",
      },
      ...["localhost", "[::1]"].map((host) => ({
        argv: ["--url", `http://${host}:7300`, "reverse", "5173", "--lease", "L1"],
        lines: ["reverse device:5173 -> localhost:5173 (lease L1)"],
        url: `ws://${host}:7300/v1/leases/L1/tunnel`,
      })),
      {
        argv: ["reverse", "5173"],
        lines: ["reverse device:5173 -> localhost:5173 (lease only)"],
        url: "ws://127.0.0.1:7300/v1/leases/only/tunnel",
      },
    ];
    for (const { argv, authorization, lines, url } of ok) {
      const cli = command(ENV);
      cli.httpJson.answers.set("http://127.0.0.1:7300/v1/identity", {
        body: { role: "agent" },
        status: 200,
      });
      cli.httpJson.answers.set("http://127.0.0.1:7300/v1/leases", {
        body: { leases: [{ id: "only", requesterId: "agent-1" }] },
        status: 200,
      });
      const exit = cli.run(["tunnel", ...argv]);
      await vi.waitFor(() => expect(cli.webSocket.connections).toHaveLength(1));
      const connection = cli.webSocket.connections[0];
      expect(connection?.url).toBe(url);
      expect(connection?.options.headers.authorization).toBe(authorization ?? "Bearer sk_agent_x");
      expect(connection?.options.handshakeTimeoutMs).toBe(10_000);
      const hello = decodeTunnelFrame(connection?.peer.sent[0] ?? new Uint8Array());
      expect(hello?.tag).toBe(TUNNEL_TAG.hello);
      expect(JSON.parse(new TextDecoder().decode(hello?.payload))).toEqual({
        tunnels: lines.map((text) => ({
          devicePort: Number(/device:(\d+)/.exec(text)?.[1]),
          kind: "reverse",
        })),
      });
      connection?.peer.receive(READY);
      await vi.waitFor(() => expect(cli.out.join("").split("\n").slice(0, -1)).toEqual(lines));
      cli.signals.emit("SIGINT");
      expect(await exit).toBe(0);
    }

    const refused: readonly {
      readonly leases: readonly { id: string; requesterId: string }[];
      readonly role: string;
      readonly message: string;
    }[] = [
      {
        leases: [],
        message:
          "This token holds no lease: start one with `simlock lease` on the worker, or pass --lease <id>",
        role: "agent",
      },
      {
        leases: [
          { id: "A", requesterId: "agent-1" },
          { id: "B", requesterId: "agent-1" },
        ],
        message:
          "This token holds more than one lease (A, B); pass --lease <id> to name the device you mean",
        role: "agent",
      },
      {
        leases: [{ id: "A", requesterId: "agent-1" }],
        message: "An operator token must name its lease: pass --lease <id>",
        role: "admin",
      },
    ];
    for (const { leases, message, role } of refused) {
      const cli = command(ENV);
      cli.httpJson.answers.set("http://127.0.0.1:7300/v1/identity", {
        body: { role },
        status: 200,
      });
      cli.httpJson.answers.set("http://127.0.0.1:7300/v1/leases", {
        body: { leases },
        status: 200,
      });
      const exit = cli.run(["tunnel", "reverse", "5173"]);
      await vi.waitFor(() => expect(cli.err.join("")).not.toBe(""));
      expect(await exit).toBe(2);
      expect(JSON.parse(cli.err.join(""))).toEqual({ error: { code: "USAGE", message } });
      expect(cli.webSocket.connections).toEqual([]);
    }
  });
});

function open(conn: number, devicePort: number): Uint8Array {
  return encodeTunnelFrame(TUNNEL_TAG.open, conn, JSON.stringify({ devicePort, kind: "reverse" }));
}

function sentFrames(cli: ReturnType<typeof command>) {
  return (cli.webSocket.connections[0]?.peer.sent ?? []).flatMap((bytes) => {
    const frame = decodeTunnelFrame(bytes);
    return frame === undefined ? [] : [frame];
  });
}

async function started(argv: readonly string[]) {
  const cli = command(ENV);
  const exit = cli.run(["tunnel", ...argv, "--lease", "L1"]);
  await vi.waitFor(() => expect(cli.webSocket.connections).toHaveLength(1));
  const peer = cli.webSocket.connections[0]?.peer;
  if (peer === undefined) throw new Error("no socket");
  peer.receive(READY);
  return { cli, exit, peer };
}

describe("simlock tunnel carrying connections", () => {
  it("warns once per 10 s per tunnel when nothing listens, keeps the tunnel open, and a 1 MiB response arrives whole", async () => {
    const quiet = await started(["reverse", "5173:5174", "reverse", "6000"]);
    quiet.cli.tcpStreams.refusedPorts.add(5174);
    quiet.cli.tcpStreams.refusedPorts.add(6000);
    const opening = async (conn: number, port: number) => {
      quiet.peer.receive(open(conn, port));
      await vi.waitFor(() =>
        expect(sentFrames(quiet.cli).filter((f) => f.tag === TUNNEL_TAG.reset)).toHaveLength(
          (conn + 1) / 2,
        ),
      );
    };
    const warnings = () =>
      quiet.cli.err
        .join("")
        .split("\n")
        .filter((line) => line !== "");
    quiet.peer.receive(open(9, 7000));
    await opening(1, 5173);
    expect(warnings()).toEqual(["reverse 5173: nothing listening on localhost:5174"]);
    quiet.cli.clock.advance(9_999);
    await opening(3, 5173);
    expect(warnings()).toEqual(["reverse 5173: nothing listening on localhost:5174"]);
    await opening(5, 6000);
    expect(warnings()).toEqual([
      "reverse 5173: nothing listening on localhost:5174",
      "reverse 6000: nothing listening on localhost:6000",
    ]);
    quiet.cli.clock.advance(1);
    await opening(7, 5173);
    expect(warnings()).toHaveLength(3);
    expect(warnings()[2]).toBe("reverse 5173: nothing listening on localhost:5174");
    expect(
      sentFrames(quiet.cli)
        .filter((f) => f.tag === TUNNEL_TAG.reset)
        .map((f) => f.conn),
    ).toEqual([1, 3, 5, 7]);
    expect(quiet.cli.tcpStreams.connections).toEqual([]);
    expect(quiet.peer.closedWith).toBeUndefined();
    quiet.cli.signals.emit("SIGINT");
    expect(await quiet.exit).toBe(0);

    const page = await started(["reverse", "5173:5174"]);
    page.peer.receive(open(1, 5173));
    await vi.waitFor(() => expect(page.cli.tcpStreams.connections).toHaveLength(1));
    expect(page.cli.tcpStreams.connections[0]?.port).toBe(5174);
    const local = page.cli.tcpStreams.connections[0]?.peer;
    if (local === undefined) throw new Error("no local connection");
    const response = Uint8Array.from({ length: 1_048_576 }, (_, index) => index % 251);
    for (let at = 0; at < response.length; at += 131_072)
      local.send(response.subarray(at, at + 131_072));
    local.end();
    const received: number[] = [];
    let ended = false;
    let before = 0;
    const credit = (conn: number, size: number) => {
      const granted = new Uint8Array(4);
      new DataView(granted.buffer).setUint32(0, size);
      page.peer.receive(encodeTunnelFrame(TUNNEL_TAG.credit, conn, granted));
    };
    const drain = () => {
      const frames = sentFrames(page.cli);
      for (const frame of frames.slice(before)) {
        if (frame.tag === TUNNEL_TAG.data) for (const byte of frame.payload) received.push(byte);
        else if (frame.tag === TUNNEL_TAG.end) ended = true;
      }
      before = frames.length;
    };
    await vi.waitFor(() => {
      drain();
      expect(received.length).toBe(262_144);
    });
    await new Promise((done) => setTimeout(done, 20));
    drain();
    expect(received).toHaveLength(262_144);
    while (!ended) {
      const have = received.length;
      credit(1, 65_536);
      await vi.waitFor(() => {
        drain();
        expect(received.length > have || ended).toBe(true);
      });
    }
    expect(received).toHaveLength(1_048_576);
    expect(Uint8Array.from(received)).toEqual(response);
    const dataSizes = sentFrames(page.cli)
      .filter((f) => f.tag === TUNNEL_TAG.data)
      .map((f) => f.payload.length);
    expect(Math.max(...dataSizes)).toBe(TUNNEL_MAX_DATA_BYTES);
    expect(dataSizes.every((size) => size <= TUNNEL_MAX_DATA_BYTES)).toBe(true);

    for (const size of [65_536, 30_000]) {
      page.peer.receive(encodeTunnelFrame(TUNNEL_TAG.data, 1, new Uint8Array(size)));
    }
    await vi.waitFor(() =>
      expect(local.written.map((chunk) => chunk.length)).toEqual([65_536, 30_000]),
    );
    await vi.waitFor(() => {
      const credits = sentFrames(page.cli)
        .filter((f) => f.tag === TUNNEL_TAG.credit)
        .map((f) => new DataView(f.payload.buffer, f.payload.byteOffset).getUint32(0));
      expect(credits).toEqual([65_536, 30_000]);
    });
    page.peer.receive(encodeTunnelFrame(TUNNEL_TAG.end, 1));
    await vi.waitFor(() => expect(local.writeEnded).toBe(true));
    page.peer.receive(open(3, 5173));
    await vi.waitFor(() => expect(page.cli.tcpStreams.connections).toHaveLength(2));
    const second = page.cli.tcpStreams.connections[1]?.peer;
    expect(second?.closed).toBe(false);
    page.peer.receive(encodeTunnelFrame(TUNNEL_TAG.reset, 3));
    await vi.waitFor(() => expect(second?.closed).toBe(true));
    page.cli.signals.emit("SIGINT");
    expect(await page.exit).toBe(0);
  });
});

// why: a failure reaches stderr through a chain of promises, so a check that nothing was written lets them run first.
function settle(): Promise<void> {
  return new Promise((done) => setTimeout(done, 0));
}

function refusedFrame(code: string, message: string): Uint8Array {
  return encodeTunnelFrame(TUNNEL_TAG.refused, 0, JSON.stringify({ code, message }));
}

function errorBody(code: string, message: string) {
  return { error: { code, message } };
}

function line(cli: ReturnType<typeof command>): unknown {
  return JSON.parse(cli.err.join(""));
}

async function upgradeRefusals(): Promise<void> {
  const upgrades: readonly {
    readonly refusal: WebSocketRefusedError;
    readonly exit?: number;
    readonly code: string;
    readonly message: string;
  }[] = [
    {
      code: "UNAUTHENTICATED",
      message: "No valid token",
      refusal: new WebSocketRefusedError(
        401,
        JSON.stringify(errorBody("UNAUTHENTICATED", "No valid token")),
      ),
    },
    {
      code: "UNKNOWN_LEASE",
      message: "Unknown lease L1",
      refusal: new WebSocketRefusedError(
        404,
        JSON.stringify(errorBody("UNKNOWN_LEASE", "Unknown lease L1")),
      ),
    },
    {
      code: "TUNNEL_UNAVAILABLE",
      message: "Tunnels are off",
      refusal: new WebSocketRefusedError(
        503,
        JSON.stringify(errorBody("TUNNEL_UNAVAILABLE", "Tunnels are off")),
      ),
    },
    {
      code: "UNKNOWN_LEASE",
      message: "Lease L1 is not known to this worker",
      refusal: new WebSocketRefusedError(404, "Not Found"),
    },
    {
      code: "BAD_REQUEST",
      exit: 2,
      message: "Bad upgrade",
      refusal: new WebSocketRefusedError(
        400,
        JSON.stringify(errorBody("BAD_REQUEST", "Bad upgrade")),
      ),
    },
    {
      code: "TUNNEL_DISCONNECTED",
      message: "Lease L1: the worker answered 502",
      refusal: new WebSocketRefusedError(502, "<html>Bad Gateway</html>"),
    },
  ];
  for (const { code, exit, message, refusal } of upgrades) {
    const cli = command(ENV);
    cli.webSocket.failure = refusal;
    expect(await cli.run(["tunnel", "reverse", "5173", "--lease", "L1"])).toBe(exit ?? 1);
    expect(line(cli)).toEqual(errorBody(code, message));
  }
}

async function lookupFailures(): Promise<void> {
  const lookups: readonly {
    readonly identity?: { status: number; body: unknown };
    readonly code: string;
    readonly message: string;
  }[] = [
    {
      code: "UNAUTHENTICATED",
      identity: { body: errorBody("UNAUTHENTICATED", "No valid token"), status: 401 },
      message: "No valid token",
    },
    {
      code: "FORBIDDEN",
      identity: { body: errorBody("FORBIDDEN", "Not allowed"), status: 403 },
      message: "Not allowed",
    },
    {
      code: "TUNNEL_DISCONNECTED",
      identity: { body: undefined, status: 502 },
      message: "The worker answered 502",
    },
    {
      code: "TUNNEL_DISCONNECTED",
      message: "No answer from http://127.0.0.1:7300",
    },
  ];
  for (const { code, identity, message } of lookups) {
    const cli = command(ENV);
    if (identity !== undefined)
      cli.httpJson.answers.set("http://127.0.0.1:7300/v1/identity", identity);
    expect(await cli.run(["tunnel", "reverse", "5173"])).toBe(1);
    expect(line(cli)).toEqual(errorBody(code, message));
    expect(cli.webSocket.connections).toEqual([]);
  }
}

async function refusalFrame(): Promise<void> {
  const refused = await started(["reverse", "80"]);
  refused.peer.receive(refusedFrame("TUNNEL_BAD_PORT", "Device port 80 is below 1024"));
  expect(await refused.exit).toBe(1);
  expect(line(refused.cli)).toEqual(
    errorBody("TUNNEL_BAD_PORT", "Lease L1: Device port 80 is below 1024"),
  );
  const unknown = await started(["reverse", "5173"]);
  unknown.peer.receive(refusedFrame("NOT_A_CODE", "something new"));
  expect(await unknown.exit).toBe(1);
  expect(line(unknown.cli)).toEqual(errorBody("TUNNEL_FAILED", "Lease L1: something new"));
  const garbled = await started(["reverse", "5173"]);
  garbled.peer.receive(open(1, 7000));
  garbled.peer.receive(encodeTunnelFrame(TUNNEL_TAG.open, 3, "not json"));
  garbled.peer.receive(encodeTunnelFrame(TUNNEL_TAG.refused, 0, "not json"));
  expect(await garbled.exit).toBe(1);
  expect(line(garbled.cli)).toEqual(
    errorBody("TUNNEL_FAILED", "Lease L1: the worker refused the tunnel"),
  );
  expect(garbled.cli.tcpStreams.connections).toEqual([]);
}

async function lossesOfTheSocket(): Promise<void> {
  const losses: readonly {
    readonly drop: [number, string];
    readonly exit: number;
    readonly error: unknown;
  }[] = [
    {
      drop: [4001, "device released"],
      error: errorBody("TUNNEL_LEASE_ENDED", "Lease L1 ended: device released"),
      exit: 14,
    },
    ...[1011, 1001, 1006].map((code) => ({
      drop: [code, ""] as [number, string],
      error: errorBody("TUNNEL_DISCONNECTED", "Lease L1: the connection to the worker was lost"),
      exit: 1,
    })),
  ];
  for (const { drop, error, exit } of losses) {
    const lost = await started(["reverse", "5173"]);
    lost.peer.dropped(...drop);
    expect(await lost.exit).toBe(exit);
    expect(line(lost.cli)).toEqual(error);
  }
}

async function silentSocket(): Promise<void> {
  const silent = await started(["reverse", "5173"]);
  silent.cli.clock.advance(30_000);
  silent.peer.ping();
  silent.cli.clock.advance(44_999);
  await settle();
  expect(silent.cli.err).toEqual([]);
  silent.peer.receive(open(1, 5173));
  silent.cli.clock.advance(44_999);
  await settle();
  expect(silent.cli.err).toEqual([]);
  silent.cli.clock.advance(1);
  await settle();
  expect(silent.cli.err).toHaveLength(1);
  expect(await silent.exit).toBe(1);
  expect(line(silent.cli)).toEqual(
    errorBody("TUNNEL_DISCONNECTED", "Lease L1: nothing was heard from the worker for 45 s"),
  );
}

async function noReadySocket(): Promise<void> {
  const noReady = command(ENV);
  const noReadyExit = noReady.run(["tunnel", "reverse", "5173", "--lease", "L1"]);
  await vi.waitFor(() => expect(noReady.webSocket.connections).toHaveLength(1));
  const quietPeer = noReady.webSocket.connections[0]?.peer;
  for (let at = 0; at < 89_999; at += 15_000) {
    noReady.clock.advance(Math.min(15_000, 89_999 - at));
    quietPeer?.ping();
  }
  await settle();
  expect(noReady.err).toEqual([]);
  noReady.clock.advance(1);
  await settle();
  expect(noReady.err).toHaveLength(1);
  expect(await noReadyExit).toBe(1);
  expect(line(noReady)).toEqual(
    errorBody("TUNNEL_DISCONNECTED", "Lease L1: no READY from the worker within 90 s"),
  );
}

async function ctrlC(): Promise<void> {
  const idle = await started(["reverse", "5173"]);
  for (let at = 0; at < 90_000; at += 15_000) {
    idle.cli.clock.advance(15_000);
    idle.peer.ping();
  }
  await settle();
  expect(idle.cli.err).toEqual([]);
  expect(idle.peer.closedWith).toBeUndefined();
  idle.peer.silentOnClose = true;
  idle.cli.signals.emit("SIGINT");
  expect(idle.peer.closedWith?.code).toBe(1000);
  let settled = false;
  void idle.exit.then(() => {
    settled = true;
  });
  idle.cli.clock.advance(1_999);
  await settle();
  expect(settled).toBe(false);
  idle.cli.clock.advance(1);
  await settle();
  expect(settled).toBe(true);
  expect(await idle.exit).toBe(0);
}

async function sigterm(): Promise<void> {
  const term = await started(["reverse", "5173"]);
  term.cli.signals.emit("SIGTERM");
  expect(term.peer.closedWith?.code).toBe(1000);
  expect(await term.exit).toBe(0);
}

describe("simlock tunnel that is refused or loses its worker", () => {
  it("exits with the worker's code and one JSON line, and a Ctrl-C closes and waits at most 2 s", async () => {
    await upgradeRefusals();
    await lookupFailures();
    await refusalFrame();
    await lossesOfTheSocket();
    await silentSocket();
    await noReadySocket();
    await ctrlC();
    await sigterm();
  });
});

describe("simlock tunnel forward listening on the caller's loopback", () => {
  it("binds each caller port before HELLO, holds connections until READY, announces them with even ids and closes every listener however the command ends, and sends a device's OPEN to the reverse tunnel when a forward names the same device port", async () => {
    const busy = command(ENV);
    busy.tcpListeners.busy.add(9229);
    expect(await busy.run(["tunnel", "forward", "9229", "--lease", "L1"])).toBe(1);
    expect(line(busy)).toEqual(
      errorBody("TUNNEL_CALLER_PORT_IN_USE", "forward 9229: localhost:9229 is already in use"),
    );
    expect(busy.webSocket.connections).toEqual([]);

    const waiting = command(ENV);
    const exit = waiting.run([
      "tunnel",
      "forward",
      "9229:19229",
      "reverse",
      "9229:5173",
      "--lease",
      "L1",
    ]);
    await vi.waitFor(() => expect(waiting.webSocket.connections).toHaveLength(1));
    const peer = firstPeer(waiting);
    expect(waiting.tcpListeners.listeners.map((listener) => listener.port)).toEqual([19229]);
    const early = waiting.tcpListeners.listeners[0]?.connect();
    await vi.waitFor(() =>
      expect(sentFrames(waiting).map((f) => f.tag)).toEqual([TUNNEL_TAG.hello]),
    );
    expect(early?.closed).toBe(false);
    peer.receive(READY);
    await vi.waitFor(() =>
      expect(sentFrames(waiting).map((f) => [f.tag, f.conn])).toEqual([
        [TUNNEL_TAG.hello, 0],
        [TUNNEL_TAG.open, 2],
      ]),
    );
    expect(JSON.parse(new TextDecoder().decode(sentFrames(waiting)[1]?.payload))).toEqual({
      devicePort: 9229,
      kind: "forward",
    });
    waiting.tcpListeners.listeners[0]?.connect();
    await vi.waitFor(() => expect(sentFrames(waiting).at(-1)?.conn).toBe(4));
    peer.receive(open(1, 9229));
    await vi.waitFor(() => expect(waiting.tcpStreams.connections).toHaveLength(1));
    expect(waiting.tcpStreams.connections[0]?.port).toBe(5173);
    waiting.signals.emit("SIGINT");
    expect(await exit).toBe(0);

    const refusedEarly = command(ENV);
    const refusedExit = refusedEarly.run(["tunnel", "forward", "9229", "--lease", "L1"]);
    await vi.waitFor(() => expect(refusedEarly.webSocket.connections).toHaveLength(1));
    const queued = refusedEarly.tcpListeners.listeners[0]?.connect();
    refusedEarly.webSocket.connections[0]?.peer.receive(
      refusedFrame("TUNNEL_BAD_PORT", "Device port 80 is below 1024"),
    );
    expect(await refusedExit).toBe(1);
    expect(queued?.closed).toBe(true);
    expect(sentFrames(refusedEarly).map((f) => f.tag)).toEqual([TUNNEL_TAG.hello]);

    const endings: readonly ((cli: ReturnType<typeof command>, peer: Peer) => void)[] = [
      (cli) => cli.signals.emit("SIGINT"),
      (_cli, ended) => ended.receive(refusedFrame("TUNNEL_BAD_PORT", "no")),
      (_cli, ended) => ended.dropped(4001, "device released"),
      (_cli, ended) => ended.dropped(1006, ""),
    ];
    for (const ending of endings) await listenersCloseAfter(ending);
  });
});

function firstPeer(cli: ReturnType<typeof command>): Peer {
  const peer = cli.webSocket.connections[0]?.peer;
  if (peer === undefined) throw new Error("no socket");
  return peer;
}

async function listenersCloseAfter(
  ending: (cli: ReturnType<typeof command>, peer: Peer) => void,
): Promise<void> {
  const cli = command(ENV);
  const run = cli.run(["tunnel", "forward", "9229", "forward", "9230", "--lease", "L1"]);
  await vi.waitFor(() => expect(cli.webSocket.connections).toHaveLength(1));
  const connection = firstPeer(cli);
  connection.silentOnClose = true;
  expect(cli.tcpListeners.listeners.map((listener) => listener.closed)).toEqual([false, false]);
  ending(cli, connection);
  cli.clock.advance(2_000);
  await run;
  expect(cli.tcpListeners.listeners.map((listener) => listener.closed)).toEqual([true, true]);
}

type Peer = ReturnType<typeof command>["webSocket"]["connections"][number]["peer"];
