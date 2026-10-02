import { describe, expect, it } from "vitest";

import { freeLoopbackPort, waitFor, withDaemon, type TestEnv } from "./helpers/index.js";

/**
 * `simlock list --requests`: every request waiting for a device, one line each, on a single host
 * and on a gateway, where a request in a worker's own queue names that worker.
 */

const IOS = { availableOsVersions: ["18.4"], knownModels: ["iPhone 16"] };
const LEASE = ["lease", "--platform", "ios", "--device", "iPhone 16", "--os", "18.4"] as const;
/** One iOS device and no more, so a second request waits. */
const ONE_DEVICE = { ios: { maxDevices: 1, maxRunning: 1 }, maxRunning: 1 };

/** The lines `simlock list --requests` prints, once there are `count` of them. */
async function requestLines(env: TestEnv, count: number): Promise<string[]> {
  let lines: string[] = [];
  await waitFor(
    async () => {
      const listed = await env.cli(["list", "--requests"]);
      expect(listed.code, listed.stderr).toBe(0);
      lines = listed.stdout.trimEnd().split("\n");
      return lines.length === count && lines.every((line) => line.startsWith("Request "));
    },
    { label: `${String(count)} waiting request lines` },
  );
  return lines;
}

describe("simlock list --requests", () => {
  it("simlock list --requests prints one line per waiting request", async () => {
    const env = await withDaemon({
      configOverrides: { limits: ONE_DEVICE },
      driverScript: { ios: IOS },
    });
    expect((await env.cli([...LEASE, "--agent-id", "holder", "--detach"])).code).toBe(0);
    const empty = await env.cli(["list", "--requests"]);
    expect(empty.stdout).toBe("No requests are waiting.\n");

    env.cliBackground([...LEASE, "--agent-id", "agent-b"]);
    await requestLines(env, 1);
    env.cliBackground([...LEASE, "--agent-id", "agent-c", "--mode", "slim"]);
    const lines = await requestLines(env, 2);

    expect(lines[0]).toMatch(
      /^Request \S+: agent-b, ios iPhone 16 18\.4, queued at 1, waiting \d+s$/,
    );
    expect(lines[1]).toMatch(
      /^Request \S+: agent-c, ios iPhone 16 18\.4 mode slim, queued at 2, waiting \d+s$/,
    );
  });

  it("on a gateway, lists the fleet queue and a request in a worker's own queue with that worker", async () => {
    const port = await freeLoopbackPort();
    const gateway = await withDaemon({
      configOverrides: { http: { enabled: true, host: "127.0.0.1", port }, mode: "gateway" },
      driver: "none",
    });
    const minted = await gateway.cli(["token", "create", "--role", "worker"]);
    expect(minted.code).toBe(0);
    const worker = await withDaemon({
      configOverrides: {
        gateway: {
          label: "worker-a",
          token: (minted.json as { secret: string }).secret,
          url: `ws://127.0.0.1:${String(port)}`,
        },
        limits: ONE_DEVICE,
      },
      driverScript: { ios: IOS },
    });
    let workerId = "";
    await waitFor(
      async () => {
        const listed = await gateway.cli(["worker", "list", "--json"]);
        const views = (listed.json as { workers?: { id: string; catalog: unknown[] }[] }).workers;
        workerId = views?.[0]?.id ?? "";
        return views?.length === 1 && JSON.stringify(views[0]?.catalog).includes("iPhone 16");
      },
      { label: "the worker joined the gateway and its catalog arrived", timeout: 30_000 },
    );

    // A local agent on the worker takes its one device, and a second one waits in the worker's
    // own queue. A fleet request then waits in the gateway's.
    expect((await worker.cli([...LEASE, "--agent-id", "local-a", "--detach"])).code).toBe(0);
    worker.cliBackground([...LEASE, "--agent-id", "local-b"]);
    await requestLines(worker, 1);
    gateway.cliBackground([...LEASE, "--agent-id", "fleet-c"]);

    const lines = await requestLines(gateway, 2);

    expect(lines).toEqual([
      expect.stringMatching(
        /^Request \S+: fleet-c, ios iPhone 16 18\.4, queued at 1, waiting \d+s$/,
      ),
      expect.stringMatching(
        new RegExp(
          `^Request \\S+: local-b on ${workerId}, ios iPhone 16 18\\.4, queued at 1, waiting \\d+s$`,
        ),
      ),
    ]);
  });
});
