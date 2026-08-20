import { describe, expect, it } from "vitest";

import { withDaemon } from "./helpers/index.js";
import { waitForLeaseCount } from "./helpers/status.js";

const AGENT_IDS = Array.from({ length: 8 }, (_, index) => `parallel-agent-${index}`);

interface LeaseRow {
  readonly id: string;
  readonly deviceId: string;
  readonly requesterId: string;
}

describe("parallel contention invariant", () => {
  it("never over-grants capacity or double-grants a device, and eventually serves every requester", async () => {
    const env = await withDaemon({
      configOverrides: { limits: { maxRunning: 2, ios: { maxDevices: 2, maxRunning: 2 } } },
    });
    await env.driverScript.set({
      ios: { knownModels: ["iPhone 16"], availableOsVersions: ["18.4"] },
    });

    const handles = AGENT_IDS.map((agentId) =>
      env.cliBackground([
        "lease",
        "--platform",
        "ios",
        "--device",
        "iPhone 16",
        "--os",
        "18.4",
        "--agent-id",
        agentId,
      ]),
    );

    const servedDeviceByAgent = new Map<string, string>();

    // As soon as each holder is granted, immediately kill it -- releasing capacity so
    // the remaining queued agents can be served in turn. All eight are started
    // concurrently; none is awaited before the next starts.
    const releaseChains = handles.map(async (handle, index) => {
      const line = await handle.firstStdoutLine(60_000);
      const grant = JSON.parse(line) as { lease: string; udid: string };
      servedDeviceByAgent.set(AGENT_IDS[index] as string, grant.udid);
      handle.kill("SIGKILL");
      await handle.waitForExit(15_000).catch(() => undefined);
    });

    let maxObservedLeaseCount = 0;
    let duplicateDeviceObservation: LeaseRow[] | undefined;
    const invariantPoll = (async () => {
      while (servedDeviceByAgent.size < AGENT_IDS.length) {
        const result = await env.cli(["list", "--leases"]);
        if (result.code === 0) {
          const rows = result.json as LeaseRow[];
          maxObservedLeaseCount = Math.max(maxObservedLeaseCount, rows.length);
          const deviceIds = rows.map((row) => row.deviceId);
          if (new Set(deviceIds).size !== deviceIds.length) duplicateDeviceObservation = rows;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    })();

    await Promise.all([...releaseChains, invariantPoll]);

    expect(
      maxObservedLeaseCount,
      "never observed more than the configured maxRunning=2 leases active at once",
    ).toBeLessThanOrEqual(2);
    expect(
      duplicateDeviceObservation,
      `a device was observed granted to two leases at once: ${JSON.stringify(duplicateDeviceObservation)}`,
    ).toBeUndefined();
    expect(servedDeviceByAgent.size, "every requester was eventually served").toBe(
      AGENT_IDS.length,
    );

    await waitForLeaseCount(env, 0);
    const finalStatus = await env.cli(["status", "--json"]);
    expect(finalStatus.code).toBe(0);
    expect((finalStatus.json as { health: string }).health).toBe("running");
  });
});
