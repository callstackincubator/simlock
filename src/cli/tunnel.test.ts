import { describe, expect, it, vi } from "vitest";

import { buildCliEnvironment, runCli } from "./index.js";
import {
  FakeClock,
  FakeDaemonLauncher,
  FakeHttpJsonClient,
  FakeSystemStats,
  FakeTcpStreamConnector,
  FakeWebSocketClientConnector,
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
  const environment = buildCliEnvironment(
    {
      clock: new FakeClock(0),
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
      tcpStreams: new FakeTcpStreamConnector(),
      webSocket,
      workingDirectory: "/work",
    },
    env,
  );
  return {
    err,
    httpJson,
    out,
    run: (argv: readonly string[]) => runCli(argv, environment),
    signals,
    webSocket,
  };
}

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
