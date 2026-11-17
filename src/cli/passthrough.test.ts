import { constants } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { spawnPassthrough } from "./passthrough.js";

/** Runs the script in a child of this process's own node, the way a real tool would run. */
function nodeCommand(script: string, env: Readonly<Record<string, string>> = {}) {
  return { args: ["-e", script], command: process.execPath, env };
}

describe("spawnPassthrough", () => {
  const originalPort = process.env.ANDROID_ADB_SERVER_PORT;

  afterEach(() => {
    if (originalPort === undefined) delete process.env.ANDROID_ADB_SERVER_PORT;
    else process.env.ANDROID_ADB_SERVER_PORT = originalPort;
  });

  it("propagates the tool's own exit code", async () => {
    await expect(spawnPassthrough(nodeCommand("process.exit(42)"))).resolves.toBe(42);
  });

  it("reports a signalled tool the way a shell does rather than as a plain failure", async () => {
    // ^C on an interactive `simlock adb shell` has to be distinguishable from the tool
    // exiting 1 on its own; a fixed code would collapse the two.
    await expect(
      spawnPassthrough(nodeCommand("process.kill(process.pid, 'SIGTERM')")),
    ).resolves.toBe(128 + (constants.signals.SIGTERM ?? 0));
  });

  it("lets the daemon's scoping win over a stale value already in the environment", async () => {
    // The merge order is the whole guarantee: a caller who exported this variable for an
    // earlier lease would otherwise aim the command at whichever server that names.
    process.env.ANDROID_ADB_SERVER_PORT = "5037";

    await expect(
      spawnPassthrough(
        nodeCommand("process.exit(process.env.ANDROID_ADB_SERVER_PORT === '5038' ? 7 : 8)", {
          ANDROID_ADB_SERVER_PORT: "5038",
        }),
      ),
    ).resolves.toBe(7);
  });

  it("keeps the caller's own environment, which the tool needs to find its SDK", async () => {
    await expect(
      spawnPassthrough(nodeCommand("process.exit(process.env.PATH ? 0 : 9)")),
    ).resolves.toBe(0);
  });

  it("leaves no signal handler behind after a tool exits, fails to start, or runs again", async () => {
    const counts = () => [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
    const before = counts();

    await spawnPassthrough(nodeCommand("process.exit(0)"));
    expect(counts(), "after a successful command").toEqual(before);

    await expect(
      spawnPassthrough({ args: [], command: "simlock-no-such-tool", env: {} }),
    ).rejects.toThrow();
    expect(counts(), "after a spawn error").toEqual(before);

    await spawnPassthrough(nodeCommand("process.exit(0)"));
    expect(counts(), "after a repeated command").toEqual(before);
  });

  it("passes a SIGTERM on as SIGINT to `simctl io recordVideo`, the only signal it finalizes its file on", async () => {
    const tool = `process.on("SIGINT",()=>process.exit(40));process.on("SIGTERM",()=>process.exit(41));setTimeout(()=>process.exit(0),1500)`;
    const known = new Set(process.listeners("SIGTERM"));
    const done = spawnPassthrough({
      args: ["-e", tool, "io", "recordVideo"],
      command: process.execPath,
      env: {},
    });
    await new Promise((resolve) => setTimeout(resolve, 600));
    for (const listener of process.listeners("SIGTERM").filter((l) => !known.has(l))) {
      listener("SIGTERM");
    }
    expect(await done).toBe(40);
  });

  it("forwards SIGINT to its tool only when stdin is not a terminal, and keeps a SIGINT listener either way, SIGTERM always forwarded", async () => {
    const tool = `process.on("SIGINT",()=>process.exit(40));process.on("SIGTERM",()=>process.exit(41));setTimeout(()=>process.exit(0),1500)`;
    const original = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    // why: a signal is delivered to our own handler only, so other listeners of the test process never run.
    const deliver = async (isTTY: boolean, signal: "SIGINT" | "SIGTERM") => {
      Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: isTTY });
      const known = new Set(process.listeners(signal));
      const done = spawnPassthrough(nodeCommand(tool));
      // why: the handlers are installed after the spawn's dynamic imports, and the tool needs time to install its own.
      await new Promise((resolve) => setTimeout(resolve, 600));
      const ours = process.listeners(signal).filter((listener) => !known.has(listener));
      // why: without our listener Node's default ends the CLI on the signal, orphaning a tool that still has to flush.
      expect(ours, `${signal} listener installed (stdin terminal: ${String(isTTY)})`).toHaveLength(
        1,
      );
      for (const listener of ours) listener(signal);
      return done;
    };
    try {
      expect(await deliver(false, "SIGINT"), "piped stdin: SIGINT forwarded").toBe(40);
      expect(await deliver(true, "SIGINT"), "terminal stdin: Ctrl-C comes from the tty").toBe(0);
      expect(await deliver(true, "SIGTERM"), "terminal stdin: SIGTERM forwarded").toBe(41);
    } finally {
      if (original) Object.defineProperty(process.stdin, "isTTY", original);
      else Reflect.deleteProperty(process.stdin, "isTTY");
    }
  });
});
