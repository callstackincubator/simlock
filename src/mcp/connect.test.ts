// why: `main.test.ts` mocks `connect.js`, so this loop has no other test — this file holds the
// default startup deadline it shares with the CLI's own loop (#663).
import { describe, expect, it } from "vitest";

import { FakeClock, FakeDaemonLauncher, MemoryIpcTransport } from "../ports/index.js";
import { connectWithAutoLaunch } from "./connect.js";

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("MCP: auto-launch's startup deadline (#663)", () => {
  it("waits for a daemon it auto-launched to the shared 20 s deadline and past it reports a failed start as DAEMON_STARTUP_FAILED", async () => {
    // why: nothing ever listens, so this loop can end only on its deadline; 19.95 s and 20 s
    // straddle that bound (testing rule 10) and are written as numbers, not read back from the
    // constant, so a loop that falls back to a bound of its own goes red here.
    const clock = new FakeClock(0);
    const launcher = new FakeDaemonLauncher();
    let done = false;
    let connected = false;
    const connecting = connectWithAutoLaunch({
      clock,
      ipc: new MemoryIpcTransport(),
      launcher,
      principal: "agent-1",
      socketPath: "/simlock/daemon.sock",
    });
    void connecting.then(
      () => {
        connected = true;
        done = true;
      },
      () => {
        done = true;
      },
    );
    await settle();
    while (!done && clock.now() < 19_950) {
      clock.advance(50);
      await settle();
      await settle();
    }
    expect(connected, "it connected although nothing was ever listening").toBe(false);
    expect(
      done,
      `gave up at ${String(clock.now())}ms, before the 20 s deadline it defaults to`,
    ).toBe(false);
    clock.advance(50);
    await settle();
    await settle();
    expect(
      done,
      `still polling at ${String(clock.now())}ms, past the 20 s deadline it defaults to`,
    ).toBe(true);
    await expect(connecting).rejects.toMatchObject({
      code: "DAEMON_STARTUP_FAILED",
      message: expect.stringContaining("Timed out starting simlock daemon"),
    });
    expect(launcher.launches).toBe(1);
  });
});
