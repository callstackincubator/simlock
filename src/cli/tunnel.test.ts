import { describe, expect, it, vi } from "vitest";

import { TUNNEL_TAG, decodeTunnelFrame, encodeTunnelFrame } from "../contract/index.js";
import { buildCliEnvironment, runCli } from "./index.js";
import {
  FakeClock,
  FakeDaemonLauncher,
  FakeHttpJsonClient,
  FakeSystemStats,
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

    const cases: readonly {
      readonly argv: readonly string[];
      readonly env?: NodeJS.ProcessEnv;
      readonly message: string;
    }[] = [
      {
        argv: ["reverse", "70000"],
        message: 'device port "70000" is not an integer from 1 to 65535',
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
      { argv: [], message: "Name at least one tunnel: reverse <device-port>[:<caller-port>]" },
      {
        argv: ["reverse", "5173", "reverse", "6000:5173"],
        message: "Caller port 5173 is named by two tunnels",
      },
      {
        argv: ["forward", "5173"],
        message: 'Unknown tunnel kind "forward": only reverse is available',
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
    ];
    for (const { argv, env, message } of cases) {
      const cli = command(env ?? ENV);
      const exit = cli.run(["tunnel", ...argv, "--lease", "L1"]);
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
      expect(await cli.run(["tunnel", "reverse", "5173"])).toBe(2);
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
    const quiet = await started(["reverse", "5173", "reverse", "6000"]);
    quiet.cli.tcpStreams.refusedPorts.add(5173);
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
    await opening(1, 5173);
    expect(warnings()).toEqual(["reverse 5173: nothing listening on localhost:5173"]);
    quiet.cli.clock.advance(9_999);
    await opening(3, 5173);
    expect(warnings()).toEqual(["reverse 5173: nothing listening on localhost:5173"]);
    await opening(5, 6000);
    expect(warnings()).toEqual([
      "reverse 5173: nothing listening on localhost:5173",
      "reverse 6000: nothing listening on localhost:6000",
    ]);
    quiet.cli.clock.advance(1);
    await opening(7, 5173);
    expect(warnings()).toHaveLength(3);
    expect(warnings()[2]).toBe("reverse 5173: nothing listening on localhost:5173");
    expect(
      sentFrames(quiet.cli)
        .filter((f) => f.tag === TUNNEL_TAG.reset)
        .map((f) => f.conn),
    ).toEqual([1, 3, 5, 7]);
    expect(quiet.peer.closedWith).toBeUndefined();
    quiet.cli.signals.emit("SIGINT");
    expect(await quiet.exit).toBe(0);

    const page = await started(["reverse", "5173"]);
    page.peer.receive(open(1, 5173));
    await vi.waitFor(() => expect(page.cli.tcpStreams.connections).toHaveLength(1));
    const local = page.cli.tcpStreams.connections[0]?.peer;
    if (local === undefined) throw new Error("no local connection");
    const response = Uint8Array.from({ length: 1_048_576 }, (_, index) => index % 251);
    for (let at = 0; at < response.length; at += 65_536)
      local.send(response.subarray(at, at + 65_536));
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
        if (frame.tag === TUNNEL_TAG.data) received.push(...frame.payload);
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
    page.cli.signals.emit("SIGINT");
    expect(await page.exit).toBe(0);
  });
});

function refusedFrame(code: string, message: string): Uint8Array {
  return encodeTunnelFrame(TUNNEL_TAG.refused, 0, JSON.stringify({ code, message }));
}

function errorBody(code: string, message: string) {
  return { error: { code, message } };
}

describe("simlock tunnel that is refused or loses its worker", () => {
  it("exits with the worker's code and one JSON line, and a Ctrl-C closes and waits at most 2 s", async () => {
    const line = (cli: ReturnType<typeof command>) => JSON.parse(cli.err.join("")) as unknown;
    const upgrades: readonly {
      readonly refusal: WebSocketRefusedError;
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
    ];
    for (const { code, message, refusal } of upgrades) {
      const cli = command(ENV);
      cli.webSocket.failure = refusal;
      expect(await cli.run(["tunnel", "reverse", "5173", "--lease", "L1"])).toBe(1);
      expect(line(cli)).toEqual(errorBody(code, message));
    }

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

    const refused = await started(["reverse", "80"]);
    refused.peer.receive(refusedFrame("TUNNEL_BAD_PORT", "Device port 80 is below 1024"));
    expect(await refused.exit).toBe(1);
    expect(line(refused.cli)).toEqual(
      errorBody("TUNNEL_BAD_PORT", "Lease L1: Device port 80 is below 1024"),
    );

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

    const silent = await started(["reverse", "5173"]);
    silent.cli.clock.advance(30_000);
    silent.peer.ping();
    silent.cli.clock.advance(44_999);
    expect(silent.cli.err).toEqual([]);
    silent.peer.receive(open(1, 5173));
    silent.cli.clock.advance(44_999);
    expect(silent.cli.err).toEqual([]);
    silent.cli.clock.advance(1);
    expect(await silent.exit).toBe(1);
    expect(line(silent.cli)).toEqual(
      errorBody("TUNNEL_DISCONNECTED", "Lease L1: nothing was heard from the worker for 45 s"),
    );

    const noReady = command(ENV);
    const noReadyExit = noReady.run(["tunnel", "reverse", "5173", "--lease", "L1"]);
    await vi.waitFor(() => expect(noReady.webSocket.connections).toHaveLength(1));
    const quietPeer = noReady.webSocket.connections[0]?.peer;
    for (let at = 0; at < 89_999; at += 15_000) {
      noReady.clock.advance(Math.min(15_000, 89_999 - at));
      quietPeer?.ping();
    }
    expect(noReady.err).toEqual([]);
    noReady.clock.advance(1);
    expect(await noReadyExit).toBe(1);
    expect(line(noReady)).toEqual(
      errorBody("TUNNEL_DISCONNECTED", "Lease L1: no READY from the worker within 90 s"),
    );

    const idle = await started(["reverse", "5173"]);
    for (let at = 0; at < 90_000; at += 15_000) {
      idle.cli.clock.advance(15_000);
      idle.peer.ping();
    }
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
    await Promise.resolve();
    expect(settled).toBe(false);
    idle.cli.clock.advance(1);
    expect(await idle.exit).toBe(0);

    const term = await started(["reverse", "5173"]);
    term.cli.signals.emit("SIGTERM");
    expect(term.peer.closedWith?.code).toBe(1000);
    expect(await term.exit).toBe(0);
  });
});
