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
});
