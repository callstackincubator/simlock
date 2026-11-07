import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { agentDeviceLeaseMaxTtlMs } from "./shared/daemon-environment.js";
import { adminSession, granted, maxTtlMs, principals, setUp, type Rig } from "./test-support.js";

const wipeOperations = new Set(["reclaim", "shutdown", "destroy"]);

function wipes(rig: Rig): number {
  return rig.driver.calls.filter((call) => wipeOperations.has(call.operation)).length;
}

async function sessionFolder(rig: Rig, path: string, writtenAtMs: number): Promise<void> {
  const file = join(path, "events.ndjson");
  await rig.filesystem.mkdirp(path);
  await rig.filesystem.writeFileAtomic(file, '{"version":1}\n');
  rig.filesystem.defineAttributes(path, { modifiedAtMs: writtenAtMs });
  rig.filesystem.defineAttributes(file, { modifiedAtMs: writtenAtMs });
}

describe("agent-device session folders on a worker", () => {
  it("a lease end removes every agent-device session folder of both daemons that nothing wrote to for longer than the agent-device lease ceiling, and keeps one written since", async () => {
    const rig = await setUp();
    const home = dirname(rig.stateDbPath);
    const simulatorSessions = join(home, "agent-device", "sessions");
    const phoneSessions = join(home, "agent-device-phones", "sessions");
    const ceilingMs = agentDeviceLeaseMaxTtlMs(maxTtlMs);
    const writtenLongAgo = rig.clock.now();
    rig.clock.advance(ceilingMs + 60_000);
    const stale = [
      join(simulatorSessions, "adc-00000000000000000000000000000001"),
      join(simulatorSessions, `${principals.one}_adc-00000000000000000000000000000001`),
      join(phoneSessions, `${principals.two}_my-session`),
    ];
    const fresh = join(simulatorSessions, `${principals.two}_adc-00000000000000000000000000000002`);
    for (const path of stale) await sessionFolder(rig, path, writtenLongAgo);
    await sessionFolder(rig, fresh, rig.clock.now());

    await granted(rig, 1);
    await rig.daemon.dispatch("lease.release-all", {}, adminSession);
    await expect.poll(() => wipes(rig)).toBeGreaterThan(0);

    const left = await Promise.all(
      [...stale, fresh].map(async (path) => ({ exists: await rig.filesystem.exists(path), path })),
    );
    expect(left).toEqual([
      ...stale.map((path) => ({ exists: false, path })),
      { exists: true, path: fresh },
    ]);
  });
});
