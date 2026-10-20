import { describe, expect, it } from "vitest";

import type { FakeDriverScript } from "./fake-driver/types.js";
import { waitFor, withDaemon, withHttpDaemon } from "./helpers/index.js";
import type { CliResult, TestEnv } from "./helpers/index.js";

const FAST = { timeout: 20_000 };
const IPHONE_16: FakeDriverScript = {
  ios: { availableOsVersions: ["26.0"], knownModels: ["iPhone 16"] },
};
const TWO_DEVICES = { limits: { maxRunning: 2, ios: { maxDevices: 2, maxRunning: 2 } } };

async function startGateway(maxPerRequester: number) {
  const { env: gateway, port } = await withHttpDaemon((port) => ({
    configOverrides: {
      http: { enabled: true, host: "127.0.0.1", port },
      lease: { maxPerRequester },
    },
    driver: "none",
    role: "gateway",
  }));
  const minted = await gateway.cli(["token", "create", "--role", "worker"]);
  expect(minted.code, minted.stderr).toBe(0);
  const { secret } = minted.json as { secret: string };
  const uplink = { token: secret, url: `ws://127.0.0.1:${port}` };
  return { gateway, uplink };
}

function lease(gateway: TestEnv, agent: string): Promise<CliResult> {
  return gateway.cli(
    [
      "lease",
      "--platform",
      "ios",
      "--device",
      "iPhone 16",
      "--os",
      "26.0",
      "--agent-id",
      agent,
      "--detach",
    ],
    FAST,
  );
}

describe("a gateway counts an agent id's leases across the fleet", () => {
  it("with the limit at 2 on the gateway and the default on the worker, one agent id holds two fleet leases on the one worker and its third request is refused by the gateway, naming the earlier lease", async () => {
    const { gateway, uplink } = await startGateway(2);
    await withDaemon({
      configOverrides: { gateway: { ...uplink, label: "worker-a" }, ...TWO_DEVICES },
      driverScript: IPHONE_16,
      fakeDriverPlatforms: ["ios"],
    });
    await waitFor(
      async () => {
        const listed = await gateway.cli(["worker", "list", "--json"]);
        const workers = (listed.json as { workers: { connection: string; catalog: unknown[] }[] })
          .workers;
        return workers.some(
          (worker) => worker.connection === "connected" && worker.catalog.length > 0,
        );
      },
      { label: "the worker connected with its catalog", timeout: 30_000 },
    );

    const first = await lease(gateway, "a");
    const second = await lease(gateway, "a");
    const third = await lease(gateway, "a");

    expect(first.code, first.stderr).toBe(0);
    expect(second.code, second.stderr).toBe(0);
    const firstId = (first.json as { lease: { id: string } }).lease.id;
    const secondId = (second.json as { lease: { id: string } }).lease.id;
    expect(secondId).not.toBe(firstId);
    expect(third.code).toBe(13);
    expect(third.error).toMatchObject({ code: "REQUESTER_ALREADY_LEASED" });
    expect(third.error?.message).toBe(
      `Requester a already holds 2 leases and lease.maxPerRequester is 2; release one (\`simlock release ${firstId}\`) before requesting another device`,
    );

    const simctl = await gateway.cli(["simctl", "list"], {
      ...FAST,
      env: { SIMLOCK_AGENT_ID: "a" },
      input: "",
    });
    expect(simctl.code).toBe(2);
    expect(simctl.stderr).toContain(firstId);
    expect(simctl.stderr).toContain(secondId);
    expect(simctl.stderr).toContain("--lease");
  });
});
