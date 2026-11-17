import { describe, expect, it, vi } from "vitest";
import { TUNNEL_TAG, encodeTunnelFrame } from "../contract/index.js";
import { promiseState } from "../test-support/promise-state.js";
import type { ScriptedProcessExpectation } from "../ports/index.js";
import {
  CallerAdb,
  ENV,
  Peer,
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

    const slow = command(ENV);
    let releaseLookup: () => void = () => undefined;
    const lookup = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    slow.httpJson.get = async () => {
      await lookup;
      throw new Error("the worker is unreachable");
    };
    const slowExit = slow.run(["tunnel", "forward", "9229"]);
    await vi.waitFor(() => expect(slow.tcpListeners.listeners).toHaveLength(1));
    const beforeSocket = slow.tcpListeners.listeners[0]?.connect();
    expect(beforeSocket?.closed).toBe(false);
    releaseLookup();
    expect(await slowExit).toBe(1);
    expect(beforeSocket?.closed).toBe(true);

    const endings: readonly ((cli: ReturnType<typeof command>, peer: Peer) => void)[] = [
      (cli) => cli.signals.emit("SIGINT"),
      (_cli, ended) => ended.receive(refusedFrame("TUNNEL_BAD_PORT", "no")),
      (_cli, ended) => ended.dropped(4001, "device released"),
      (_cli, ended) => ended.dropped(1006, ""),
    ];
    for (const ending of endings) await listenersCloseAfter(ending);
  });
});

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

describe("simlock tunnel emulator adb", () => {
  const emulatorOpen = JSON.stringify({ kind: "emulator", emulatorPort: "adb" });

  // fallow-ignore-next-line complexity -- one Tests line: each adb outcome and each way the command ends are rows of its cases.
  it("prints the tunnel line and connects the caller's own adb to the caller's port, which opens an emulator connection for each connection to it", async () => {
    const adb = new CallerAdb([
      {
        match: { args: ["connect", "127.0.0.1:49152"], command: "adb" },
        stdoutLines: ["connected to 127.0.0.1:49152"],
      },
    ]);
    const cli = command(ENV, adb);
    const exit = cli.run(["tunnel", "emulator", "adb", "--lease", "L1"]);
    await vi.waitFor(() => expect(cli.webSocket.connections).toHaveLength(1));
    await vi.waitFor(() => expect(sentFrames(cli)).toHaveLength(1));
    expect(new TextDecoder().decode(sentFrames(cli)[0]?.payload)).toBe(
      '{"tunnels":[{"kind":"emulator","emulatorPort":"adb"}]}',
    );
    expect(cli.out).toEqual([]);

    firstPeer(cli).receive(READY);
    await vi.waitFor(() =>
      expect(cli.out.join("")).toBe(
        "emulator localhost:49152 -> emulator:adb (lease L1)\nadb: connected to 127.0.0.1:49152\n",
      ),
    );
    expect(adb.calls.map(({ args, command: bin }) => [bin, ...args])).toEqual([
      ["adb", "connect", "127.0.0.1:49152"],
    ]);

    cli.tcpListeners.listeners[0]?.connect();
    await vi.waitFor(() => expect(sentFrames(cli).at(-1)?.conn).toBe(2));
    expect(sentFrames(cli).at(-1)?.tag).toBe(TUNNEL_TAG.open);
    expect(new TextDecoder().decode(sentFrames(cli).at(-1)?.payload)).toBe(emulatorOpen);

    cli.signals.emit("SIGINT");
    cli.clock.advance(2_000);
    expect(await exit).toBe(0);

    const target = "127.0.0.1:49152";
    const connect = (
      command: string,
      output: Partial<ScriptedProcessExpectation> = {},
    ): ScriptedProcessExpectation => ({
      match: { args: ["connect", target], command },
      stdoutLines: [`connected to ${target}`],
      ...output,
    });
    const rerun = `run: adb connect ${target}`;
    const outputs = [
      {
        adb: new CallerAdb([
          connect("adb", {
            stdoutLines: [],
            stderrLines: ["* daemon not running; starting now"],
            result: {
              code: 0,
              stderr: "",
              stdout: `* daemon started successfully\nconnected to ${target}\n`,
            },
          }),
        ]),
        err: "",
        out: `adb: connected to ${target}\n`,
      },
      {
        adb: new CallerAdb([connect("adb", { stdoutLines: [`already connected to ${target}`] })]),
        err: "",
        out: `adb: connected to ${target}\n`,
      },
      {
        adb: new CallerAdb([
          connect("adb", { stdoutLines: [`failed to authenticate to ${target}`] }),
        ]),
        err: `warning: emulator adb: adb answered: failed to authenticate to ${target}; ${rerun}\n`,
        out: "",
      },
      {
        adb: new CallerAdb([
          connect("adb", {
            stdoutLines: [],
            result: {
              code: 1,
              stderr: "",
              stdout: `* daemon started successfully\nfailed to authenticate to ${target}\n`,
            },
          }),
        ]),
        err: `warning: emulator adb: adb answered: failed to authenticate to ${target}; ${rerun}\n`,
        out: "",
      },
      {
        adb: new CallerAdb([], []),
        err: `warning: emulator adb: adb was not found; ${rerun}\n`,
        out: "",
      },
      {
        adb: new CallerAdb([connect("/sdk/platform-tools/adb")], ["/sdk/platform-tools/adb"]),
        env: { ANDROID_HOME: "/sdk" },
        err: "",
        out: `adb: connected to ${target}\n`,
      },
      {
        adb: new CallerAdb(
          [connect("/home/caller/Library/Android/sdk/platform-tools/adb")],
          ["/home/caller/Library/Android/sdk/platform-tools/adb"],
        ),
        err: "",
        out: `adb: connected to ${target}\n`,
      },
    ];
    for (const expected of outputs) {
      const other = command({ ...ENV, ...expected.env }, expected.adb);
      const otherExit = other.run(["tunnel", "emulator", "adb", "--lease", "L1"]);
      await vi.waitFor(() => expect(other.webSocket.connections).toHaveLength(1));
      firstPeer(other).receive(READY);
      await vi.waitFor(() =>
        expect(other.out.join("") + other.err.join("")).toContain(
          expected.out === "" ? expected.err : expected.out,
        ),
      );
      await settle();
      expect(other.out.join("")).toBe(
        `emulator localhost:49152 -> emulator:adb (lease L1)\n${expected.out}`,
      );
      expect(other.err.join("")).toBe(expected.err);
      other.signals.emit("SIGINT");
      other.clock.advance(2_000);
      expect(await otherExit).toBe(0);
    }

    const pinned = new CallerAdb([
      {
        match: { args: ["connect", "127.0.0.1:6000"], command: "adb" },
        stdoutLines: ["connected to 127.0.0.1:6000"],
      },
    ]);
    const both = command(ENV, pinned);
    const bothExit = both.run(["tunnel", "emulator", "adb:6000", "--lease", "L1"]);
    await vi.waitFor(() => expect(both.webSocket.connections).toHaveLength(1));
    expect(both.tcpListeners.listeners.map((listener) => listener.port)).toEqual([6000]);
    firstPeer(both).receive(READY);
    await vi.waitFor(() =>
      expect(both.out.join("")).toBe(
        "emulator localhost:6000 -> emulator:adb (lease L1)\nadb: connected to 127.0.0.1:6000\n",
      ),
    );
    both.signals.emit("SIGINT");
    both.clock.advance(2_000);
    expect(await bothExit).toBe(0);

    const busy = command(ENV, new CallerAdb([]));
    busy.tcpListeners.busy.add(6000);
    expect(await busy.run(["tunnel", "emulator", "adb:6000", "--lease", "L1"])).toBe(1);
    expect(line(busy)).toEqual(
      errorBody("TUNNEL_CALLER_PORT_IN_USE", "emulator adb: localhost:6000 is already in use"),
    );

    const mixedAdb = new CallerAdb([connect("adb")]);
    const mixed = command(ENV, mixedAdb);
    const mixedExit = mixed.run(["tunnel", "reverse", "8081", "emulator", "adb", "--lease", "L1"]);
    await vi.waitFor(() => expect(sentFrames(mixed)).toHaveLength(1));
    expect(new TextDecoder().decode(sentFrames(mixed)[0]?.payload)).toBe(
      '{"tunnels":[{"devicePort":8081,"kind":"reverse"},{"kind":"emulator","emulatorPort":"adb"}]}',
    );
    firstPeer(mixed).receive(READY);
    await vi.waitFor(() =>
      expect(mixed.out.join("")).toBe(
        `reverse device:8081 -> localhost:8081 (lease L1)\nemulator localhost:49152 -> emulator:adb (lease L1)\nadb: connected to ${target}\n`,
      ),
    );
    firstPeer(mixed).receive(open(1, 8081));
    await vi.waitFor(() =>
      expect(mixed.tcpStreams.connections.map(({ port }) => port)).toEqual([8081]),
    );

    mixed.tcpListeners.listeners[0]?.connect();
    mixed.tcpListeners.listeners[0]?.connect();
    await vi.waitFor(() =>
      expect(sentFrames(mixed).filter((f) => f.tag === TUNNEL_TAG.open)).toHaveLength(2),
    );
    const reset = (conn: number, reason: string) =>
      encodeTunnelFrame(TUNNEL_TAG.reset, conn, JSON.stringify({ reason }));
    firstPeer(mixed).receive(reset(2, "closed"));
    firstPeer(mixed).receive(reset(4, "timeout"));
    await vi.waitFor(() => expect(mixed.err.join("")).toBe("warning: emulator adb: closed\n"));
    mixed.clock.advance(9_999);
    mixed.tcpListeners.listeners[0]?.connect();
    await vi.waitFor(() => expect(sentFrames(mixed).at(-1)?.conn).toBe(6));
    firstPeer(mixed).receive(reset(6, "timeout"));
    await settle();
    expect(mixed.err.join("")).toBe("warning: emulator adb: closed\n");
    mixed.clock.advance(1);
    mixed.tcpListeners.listeners[0]?.connect();
    await vi.waitFor(() => expect(sentFrames(mixed).at(-1)?.conn).toBe(8));
    firstPeer(mixed).receive(reset(8, "timeout"));
    await vi.waitFor(() =>
      expect(mixed.err.join("")).toBe(
        "warning: emulator adb: closed\nwarning: emulator adb: timeout\n",
      ),
    );
    mixed.signals.emit("SIGINT");
    mixed.clock.advance(2_000);
    expect(await mixedExit).toBe(0);

    const disconnect = (
      output: Partial<ScriptedProcessExpectation> = {},
    ): ScriptedProcessExpectation => ({
      match: { args: ["disconnect", target], command: "adb" },
      stdoutLines: [`disconnected ${target}`],
      ...output,
    });
    const calls = (runner: CallerAdb) => runner.calls.map(({ args }) => args.join(" "));
    const endings: readonly {
      readonly end: (cli: ReturnType<typeof command>, peer: Peer) => void;
      readonly exit: number;
    }[] = [
      { end: (cli) => cli.signals.emit("SIGINT"), exit: 0 },
      { end: (_cli, ended) => ended.receive(refusedFrame("TUNNEL_BAD_PORT", "no")), exit: 1 },
      { end: (_cli, ended) => ended.dropped(4001, "device released"), exit: 14 },
      { end: (_cli, ended) => ended.dropped(1006, ""), exit: 1 },
    ];
    for (const ending of endings) {
      const runner = new CallerAdb([connect("adb"), disconnect()]);
      const leaving = command(ENV, runner);
      const leavingExit = leaving.run(["tunnel", "emulator", "adb", "--lease", "L1"]);
      await vi.waitFor(() => expect(leaving.webSocket.connections).toHaveLength(1));
      firstPeer(leaving).receive(READY);
      await vi.waitFor(() => expect(leaving.out.join("")).toContain("adb: connected"));
      ending.end(leaving, firstPeer(leaving));
      expect(await leavingExit).toBe(ending.exit);
      expect(calls(runner)).toEqual([`connect ${target}`, `disconnect ${target}`]);
    }

    const failing = new CallerAdb([
      connect("adb"),
      disconnect({ result: { code: 1, stderr: "error: no such device", stdout: "" } }),
    ]);
    const failed = command(ENV, failing);
    const failedExit = failed.run(["tunnel", "emulator", "adb", "--lease", "L1"]);
    await vi.waitFor(() => expect(failed.webSocket.connections).toHaveLength(1));
    firstPeer(failed).receive(READY);
    await vi.waitFor(() => expect(failed.out.join("")).toContain("adb: connected"));
    firstPeer(failed).dropped(4001, "device released");
    expect(await failedExit).toBe(14);
    expect(calls(failing)).toEqual([`connect ${target}`, `disconnect ${target}`]);

    const stuckAdb = new CallerAdb([connect("adb"), disconnect({ hangs: true })]);
    const stuck = command(ENV, stuckAdb);
    const stuckExit = stuck.run(["tunnel", "emulator", "adb", "--lease", "L1"]);
    await vi.waitFor(() => expect(stuck.webSocket.connections).toHaveLength(1));
    firstPeer(stuck).receive(READY);
    await vi.waitFor(() => expect(stuck.out.join("")).toContain("adb: connected"));
    stuck.signals.emit("SIGINT");
    await vi.waitFor(() => expect(stuckAdb.calls).toHaveLength(2));
    const stuckState = promiseState(stuckExit);
    stuck.clock.advance(1_999);
    await settle();
    expect(stuckState.state).toBe("pending");
    stuck.clock.advance(1);
    await settle();
    expect(stuckState.state).toBe("fulfilled");
    expect(await stuckExit).toBe(0);
    expect((await stuckAdb.handles[1]?.wait())?.code).toBeNull();

    const early = new CallerAdb([connect("adb", { hangs: true }), disconnect()]);
    const interrupted = command(ENV, early);
    const interruptedExit = interrupted.run(["tunnel", "emulator", "adb", "--lease", "L1"]);
    await vi.waitFor(() => expect(interrupted.webSocket.connections).toHaveLength(1));
    firstPeer(interrupted).receive(READY);
    await vi.waitFor(() => expect(early.calls).toHaveLength(1));
    interrupted.signals.emit("SIGINT");
    const interruptedState = promiseState(interruptedExit);
    await settle();
    expect(interruptedState.state).toBe("fulfilled");
    expect(await interruptedExit).toBe(0);
    expect(calls(early)).toEqual([`connect ${target}`, `disconnect ${target}`]);
    const killed = promiseState(Promise.resolve(early.handles[0]?.wait()));
    await settle();
    expect(killed.state).toBe("fulfilled");
    expect((await early.handles[0]?.wait())?.code).toBeNull();
    expect(interrupted.err).toEqual([]);

    const hung = new CallerAdb([connect("adb", { hangs: true })]);
    const slow = command(ENV, hung);
    const slowExit = slow.run(["tunnel", "emulator", "adb", "--lease", "L1"]);
    await vi.waitFor(() => expect(slow.webSocket.connections).toHaveLength(1));
    firstPeer(slow).receive(READY);
    await vi.waitFor(() => expect(hung.calls).toHaveLength(1));
    slow.clock.advance(9_999);
    await settle();
    expect(slow.err).toEqual([]);
    slow.clock.advance(1);
    await vi.waitFor(() =>
      expect(slow.err.join("")).toBe(
        `warning: emulator adb: adb did not answer in 10 s; ${rerun}\n`,
      ),
    );
    expect((await hung.handles[0]?.wait())?.code).toBeNull();
    slow.signals.emit("SIGINT");
    slow.clock.advance(2_000);
    expect(await slowExit).toBe(0);
  });
});
