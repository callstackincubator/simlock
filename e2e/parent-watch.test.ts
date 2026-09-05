import { spawn, type ChildProcess } from "node:child_process";

import { describe, expect, it } from "vitest";

import { waitForLeaseCount, withDaemon } from "./helpers/index.js";

/** Stands in for the agent process a running `simlock lease` watches, without pulling in a
 * real one. */
async function spawnFakeAgent(): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120_000)"], {
    stdio: "ignore",
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  return child;
}

describe("parent-watch", () => {
  it("self-terminates and releases when its --bind-pid parent dies, without itself being signaled", async () => {
    // A long TTL on purpose: ADR 0004 leaves an unreleased lease standing until its
    // deadline, so a lease freed within seconds here can only be the holder's own release
    // path running -- which is exactly what this test is about. Nothing waits on expiry.
    const env = await withDaemon({ configOverrides: { lease: { defaultTtlMs: 600_000 } } });
    await env.driverScript.set({
      ios: { knownModels: ["iPhone 16"], availableOsVersions: ["18.4"] },
    });

    // `--bind-pid` is what makes this deterministic: the CLI's *actual* OS parent is
    // this test process, which must obviously stay alive, so the holder is bound to
    // a disposable stand-in instead -- exactly the subshell-parent case the flag
    // exists for.
    const fakeAgent = await spawnFakeAgent();
    try {
      const held = env.cliBackground([
        "lease",
        "--platform",
        "ios",
        "--device",
        "iPhone 16",
        "--os",
        "18.4",
        "--agent-id",
        "flow-parent-watch",
        "--bind-pid",
        String(fakeAgent.pid),
      ]);
      const grant = JSON.parse(await held.firstStdoutLine()) as { lease: { id: string } };
      await waitForLeaseCount(env, 1);

      fakeAgent.kill("SIGKILL");

      // Nothing signals the holder itself -- it must notice on its own that the pid it is
      // bound to is gone, then release and exit through the same path a SIGTERM would take.
      // Under ADR 0004 that release is the only thing that can free the device this quickly:
      // the daemon releases nothing when the connection closes.
      const result = await held.waitForExit(15_000);
      expect(result.code).toBe(0);

      await waitForLeaseCount(env, 0);
      const recorded = await env.expectEvents(["lease.granted", "lease.released"]);
      expect(recorded).toContainEqual(
        expect.objectContaining({
          event: "lease.released",
          payload: expect.objectContaining({ leaseId: grant.lease.id, reason: "explicit" }),
        }),
      );
    } finally {
      fakeAgent.kill("SIGKILL");
    }
  });
});
