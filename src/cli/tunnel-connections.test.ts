import { describe, expect, it, vi } from "vitest";
import { TUNNEL_MAX_DATA_BYTES, TUNNEL_TAG, encodeTunnelFrame } from "../contract/index.js";
import { FakeTcpPeer, WebSocketRefusedError } from "../ports/index.js";
import {
  ENV,
  READY,
  command,
  errorBody,
  firstPeer,
  line,
  open,
  refusedFrame,
  sentFrames,
  settle,
} from "./test-tunnel.js";

async function started(argv: readonly string[]) {
  const cli = command(ENV);
  const exit = cli.run(["tunnel", ...argv, "--lease", "L1"]);
  await vi.waitFor(() => expect(cli.webSocket.connections).toHaveLength(1));
  const peer = cli.webSocket.connections[0]?.peer;
  if (peer === undefined) throw new Error("no socket");
  peer.receive(READY);
  return { cli, exit, peer };
}

async function warningsPerTunnel(): Promise<void> {
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
}

async function forwardResetWarnings(): Promise<void> {
  const cli = command(ENV);
  const exit = cli.run(["tunnel", "forward", "9229:19229", "--lease", "L1"]);
  await vi.waitFor(() => expect(cli.webSocket.connections).toHaveLength(1));
  const peer = firstPeer(cli);
  peer.receive(READY);
  const reason = "nothing on the lease's simulator listens on port 9229";
  const warnings = () =>
    cli.err
      .join("")
      .split("\n")
      .filter((text) => text !== "");
  const resetByWorker = async (conn: number) => {
    cli.tcpListeners.listeners[0]?.connect();
    await vi.waitFor(() => expect(sentFrames(cli).at(-1)?.conn).toBe(conn));
    peer.receive(encodeTunnelFrame(TUNNEL_TAG.reset, conn, JSON.stringify({ reason })));
    await settle();
  };
  await resetByWorker(2);
  expect(warnings()).toEqual([`warning: forward 9229: ${reason}`]);
  cli.clock.advance(9_999);
  await resetByWorker(4);
  expect(warnings()).toHaveLength(1);
  cli.clock.advance(1);
  await resetByWorker(6);
  expect(warnings()).toEqual([
    `warning: forward 9229: ${reason}`,
    `warning: forward 9229: ${reason}`,
  ]);
  expect(peer.closedWith).toBeUndefined();
  cli.signals.emit("SIGINT");
  expect(await exit).toBe(0);
}

async function responseThroughTheTunnel() {
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

  return { local, page };
}

async function writesToTheCaller(
  page: Awaited<ReturnType<typeof started>>,
  local: FakeTcpPeer,
): Promise<void> {
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
  expect(local.closed).toBe(false);
  page.peer.receive(encodeTunnelFrame(TUNNEL_TAG.end, 1));
  await vi.waitFor(() => expect(local.writeEnded).toBe(true));
  await vi.waitFor(() => expect(local.closed).toBe(true));
  page.peer.receive(encodeTunnelFrame(TUNNEL_TAG.data, 1, new Uint8Array(5)));
  await settle();
  expect(local.written.map((chunk) => chunk.length)).toEqual([65_536, 30_000]);
  page.peer.receive(open(1, 5173));
  await vi.waitFor(() => expect(page.cli.tcpStreams.connections).toHaveLength(2));
  const second = page.cli.tcpStreams.connections[1]?.peer;
  expect(second?.closed).toBe(false);
  page.peer.receive(encodeTunnelFrame(TUNNEL_TAG.end, 1));
  await vi.waitFor(() => expect(second?.writeEnded).toBe(true));
  await settle();
  expect(second?.closed).toBe(false);
  second?.end();
  await vi.waitFor(() => expect(second?.closed).toBe(true));
  page.peer.receive(open(3, 5173));
  await vi.waitFor(() => expect(page.cli.tcpStreams.connections).toHaveLength(3));
  const reset = page.cli.tcpStreams.connections[2]?.peer;
  expect(reset?.closed).toBe(false);
  page.peer.receive(encodeTunnelFrame(TUNNEL_TAG.reset, 3));
  await vi.waitFor(() => expect(reset?.closed).toBe(true));
}

async function brokenWrite(page: Awaited<ReturnType<typeof started>>): Promise<void> {
  page.peer.receive(open(5, 5173));
  await vi.waitFor(() => expect(page.cli.tcpStreams.connections).toHaveLength(4));
  const broken = page.cli.tcpStreams.connections[3]?.peer;
  if (broken === undefined) throw new Error("no fourth connection");
  broken.writeFailure = new Error("write EPIPE");
  page.peer.receive(encodeTunnelFrame(TUNNEL_TAG.data, 5, new Uint8Array(10)));
  page.peer.receive(encodeTunnelFrame(TUNNEL_TAG.end, 5));
  await vi.waitFor(() =>
    expect(
      sentFrames(page.cli)
        .filter((f) => f.tag === TUNNEL_TAG.reset)
        .map((f) => f.conn),
    ).toEqual([5]),
  );
  await settle();
  expect(broken.closed).toBe(true);
  expect(sentFrames(page.cli).filter((f) => f.tag === TUNNEL_TAG.credit && f.conn === 5)).toEqual(
    [],
  );
  expect(page.cli.err).toEqual([]);
  page.peer.receive(open(7, 5173));
  await vi.waitFor(() => expect(page.cli.tcpStreams.connections).toHaveLength(5));
  expect(page.cli.tcpStreams.connections[4]?.peer.closed).toBe(false);
  page.cli.signals.emit("SIGINT");
  expect(await page.exit).toBe(0);
}

describe("simlock tunnel carrying connections", () => {
  it("warns once per 10 s per tunnel when nothing listens, or the worker resets a forward connection with its reason, keeps the tunnel open, and a 1 MiB response arrives whole, a connection whose both halves ended is closed and dropped, and one with a single half ended keeps relaying the other", async () => {
    await warningsPerTunnel();
    await forwardResetWarnings();
    const { local, page } = await responseThroughTheTunnel();
    await writesToTheCaller(page, local);
    await brokenWrite(page);
  });
});

async function withLocalConnection(
  cli: ReturnType<typeof command>,
  peer: { receive(bytes: Uint8Array): void },
  devicePort: number,
) {
  const before = cli.tcpStreams.connections.length;
  peer.receive(open(1 + 2 * before, devicePort));
  await vi.waitFor(() => expect(cli.tcpStreams.connections).toHaveLength(before + 1));
  const local = cli.tcpStreams.connections[before]?.peer;
  if (local === undefined) throw new Error("no local connection");
  expect(local.closed).toBe(false);
  return local;
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
  const refusedLocal = await withLocalConnection(refused.cli, refused.peer, 80);
  refused.peer.receive(refusedFrame("TUNNEL_BAD_PORT", "Device port 80 is below 1024"));
  expect(await refused.exit).toBe(1);
  expect(refusedLocal.closed).toBe(true);
  expect(refused.peer.closedWith?.code).toBe(1000);
  expect(refused.cli.clock.pendingTimerCount).toBe(0);
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
      error: errorBody(
        "TUNNEL_DISCONNECTED",
        `Lease L1: the connection to ${ENV.SIMLOCK_URL} was lost`,
      ),
      exit: 1,
    })),
  ];
  for (const { drop, error, exit } of losses) {
    const lost = await started(["reverse", "5173"]);
    const lostLocal = await withLocalConnection(lost.cli, lost.peer, 5173);
    lost.peer.dropped(...drop);
    expect(await lost.exit).toBe(exit);
    expect(lostLocal.closed).toBe(true);
    expect(lost.cli.clock.pendingTimerCount).toBe(0);
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
  const silentLocal = await withLocalConnection(silent.cli, silent.peer, 5173);
  silent.cli.clock.advance(44_999);
  await settle();
  expect(silent.cli.err).toEqual([]);
  silent.cli.clock.advance(1);
  await settle();
  expect(silent.cli.err).toHaveLength(1);
  expect(await silent.exit).toBe(1);
  expect(silentLocal.closed).toBe(true);
  expect(silent.peer.closedWith?.code).toBe(1000);
  expect(silent.peer.terminated).toBe(true);
  expect(silent.cli.clock.pendingTimerCount).toBe(0);
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
  expect(quietPeer?.closedWith?.code).toBe(1000);
  expect(quietPeer?.terminated).toBe(true);
  expect(noReady.clock.pendingTimerCount).toBe(0);
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
  const idleLocal = await withLocalConnection(idle.cli, idle.peer, 5173);
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
  expect(idleLocal.closed).toBe(true);
  expect(idle.peer.terminated).toBe(true);
  expect(idle.cli.clock.pendingTimerCount).toBe(0);
}

async function sigterm(): Promise<void> {
  const term = await started(["reverse", "5173"]);
  const termLocal = await withLocalConnection(term.cli, term.peer, 5173);
  term.cli.signals.emit("SIGTERM");
  expect(term.peer.closedWith?.code).toBe(1000);
  expect(await term.exit).toBe(0);
  expect(termLocal.closed).toBe(true);
  expect(term.cli.clock.pendingTimerCount).toBe(0);
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
