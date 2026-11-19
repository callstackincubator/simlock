import { TUNNEL_TAG, decodeTunnelFrame, encodeTunnelFrame } from "../contract/index.js";
import { buildCliEnvironment, runCli } from "./index.js";
import {
  FakeClock,
  FakeDaemonLauncher,
  FakeHttpJsonClient,
  FakeSystemStats,
  FakeTcpListenerFactory,
  FakeTcpStreamConnector,
  FakeWebSocketClientConnector,
  MemoryFilesystem,
  MemoryIpcTransport,
  ProcessSpawnError,
  ScriptedProcessRunner,
  type ScriptedProcessExpectation,
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

// why: stands in for the caller's machine: only the commands in `present` start, as a real runner throws ProcessSpawnError for an adb that is not there.
export class CallerAdb extends ScriptedProcessRunner {
  constructor(
    expectations: readonly ScriptedProcessExpectation[],
    private readonly present: readonly string[] = ["adb"],
  ) {
    super(expectations);
  }

  override spawn(
    command: string,
    args: readonly string[],
    options?: Parameters<ScriptedProcessRunner["spawn"]>[2],
  ) {
    if (!this.present.includes(command)) throw new ProcessSpawnError(command, args);
    return super.spawn(command, args, options);
  }
}

export function command(env: NodeJS.ProcessEnv, processRunner: CallerAdb = new CallerAdb([])) {
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
      processRunner,
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

export const READY = encodeTunnelFrame(TUNNEL_TAG.ready, 0, "{}");

export const ENV = { SIMLOCK_TOKEN: "sk_agent_x", SIMLOCK_URL: "http://127.0.0.1:7300" };

export function open(conn: number, devicePort: number): Uint8Array {
  return encodeTunnelFrame(TUNNEL_TAG.open, conn, JSON.stringify({ devicePort, kind: "reverse" }));
}

export function sentFrames(cli: ReturnType<typeof command>) {
  return (cli.webSocket.connections[0]?.peer.sent ?? []).flatMap((bytes) => {
    const frame = decodeTunnelFrame(bytes);
    return frame === undefined ? [] : [frame];
  });
}

// why: a failure reaches stderr through a chain of promises, so a check that nothing was written lets them run first.
export function settle(): Promise<void> {
  return new Promise((done) => setTimeout(done, 0));
}

export function refusedFrame(code: string, message: string): Uint8Array {
  return encodeTunnelFrame(TUNNEL_TAG.refused, 0, JSON.stringify({ code, message }));
}

export function errorBody(code: string, message: string) {
  return { error: { code, message } };
}

export function line(cli: ReturnType<typeof command>): unknown {
  return JSON.parse(cli.err.join(""));
}

export function firstPeer(cli: ReturnType<typeof command>): Peer {
  const peer = cli.webSocket.connections[0]?.peer;
  if (peer === undefined) throw new Error("no socket");
  return peer;
}

export type Peer = ReturnType<typeof command>["webSocket"]["connections"][number]["peer"];
