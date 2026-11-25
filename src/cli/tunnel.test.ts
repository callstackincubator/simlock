import { describe, expect, it, vi } from "vitest";
import { TUNNEL_TAG, decodeTunnelFrame } from "../contract/index.js";
import { ENV, READY, command } from "./test-tunnel.js";

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

    const slashed = command({ ...ENV, SIMLOCK_URL: "http://127.0.0.1:7300/" });
    const slashedExit = slashed.run(["tunnel", "reverse", "5173", "--lease", "L1"]);
    await vi.waitFor(() => expect(slashed.webSocket.connections).toHaveLength(1));
    expect(slashed.webSocket.connections[0]?.url).toBe("ws://127.0.0.1:7300/v1/leases/L1/tunnel");
    slashed.signals.emit("SIGINT");
    expect(await slashedExit).toBe(0);

    const floor = command(ENV);
    const floorExit = floor.run(["tunnel", "forward", "9229:1024", "--lease", "L1"]);
    await vi.waitFor(() => expect(floor.webSocket.connections).toHaveLength(1));
    expect(floor.tcpListeners.listeners.map((listener) => listener.port)).toEqual([1024]);
    floor.signals.emit("SIGINT");
    expect(await floorExit).toBe(0);

    const help = command(ENV);
    expect(await help.run(["tunnel", "--help"])).toBe(0);
    expect(help.out.join("")).toBe(
      "Usage: simlock tunnel reverse|forward <device-port>[:<caller-port>] | emulator adb[:<caller-port>] [reverse|forward ...] [--lease <id>] [--url <url>]\n",
    );

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
        message: 'Unknown tunnel kind "sideways": use reverse, forward or emulator',
      },
      {
        argv: ["emulate", "adb"],
        message: 'Unknown tunnel kind "emulate": use reverse, forward or emulator',
      },
      ...["console", "grpc", "5555", ""].map((name) => ({
        argv: name === "" ? ["emulator"] : ["emulator", name],
        message: `Unknown emulator port "${name}": use adb`,
      })),
      {
        argv: ["emulator", "adb:80"],
        message: 'emulator caller port "80" is below 1024',
      },
      {
        argv: ["emulator", "adb:70000"],
        message: 'caller port "70000" is not an integer from 1 to 65535',
      },
      {
        argv: ["emulator", "adb:"],
        message: 'caller port "" is not an integer from 1 to 65535',
      },
      { argv: ["emulator", "adb", "emulator", "adb"], message: "Name emulator adb once" },
      {
        argv: ["forward", "6000", "emulator", "adb:6000"],
        message: "Caller port 6000 is named by two tunnels",
      },
      {
        argv: ["--url", "http://10.0.0.5:7300", "reverse", "5173"],
        message:
          "--url must be https://, or http:// only for 127.0.0.1, [::1] or localhost; to connect over plain http anyway (the token is sent unencrypted), pass --allow-insecure-http or set SIMLOCK_ALLOW_INSECURE_HTTP=1",
      },
      ...[
        "http://127.0.0.1:7300/?x=1",
        "http://127.0.0.1:7300?x=1",
        "http://127.0.0.1:7300/#top",
        "http://127.0.0.1:7300/base",
        "http://127.0.0.1:7300/?",
      ].map((url) => ({
        argv: ["--url", url, "reverse", "5173"],
        message: "--url must be the farm's origin only: no path, query or fragment",
      })),
      {
        argv: ["reverse", "5173"],
        env: { ...ENV, SIMLOCK_URL: "https://worker.example/v1" },
        message: "--url must be the farm's origin only: no path, query or fragment",
      },
      {
        argv: ["reverse", "5173"],
        env: { SIMLOCK_TOKEN: "sk_agent_x" },
        message: "No farm URL: pass --url or set SIMLOCK_URL",
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
      ...[
        ["--url", "http://100.75.181.35:7300", "--allow-insecure-http"],
        ["--allow-insecure-http", "--url", "http://100.75.181.35:7300"],
      ].map((flags) => ({
        argv: [...flags, "reverse", "5173", "--lease", "L1"],
        lines: ["reverse device:5173 -> localhost:5173 (lease L1)"],
        url: "ws://100.75.181.35:7300/v1/leases/L1/tunnel",
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
