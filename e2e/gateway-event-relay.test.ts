import { describe, expect, it } from "vitest";

import { freeLoopbackPort, waitFor, withDaemon } from "./helpers/index.js";
import type { RecordedEvent } from "./helpers/events.js";

/**
 * ADR 0014 §2 and §5 with real processes: a gateway and one worker, the CLI an operator uses.
 * A worker's event keeps its `id` and `timestamp` on the gateway, which is what lets the two
 * event files be joined; `workerId` is the only mark of the relay.
 */

async function gatewayWithWorker() {
  const port = await freeLoopbackPort();
  const gateway = await withDaemon({
    configOverrides: { http: { host: "127.0.0.1", port }, mode: "gateway" },
    driver: "none",
  });
  const minted = await gateway.cli(["token", "create", "--role", "worker"]);
  const { secret } = minted.json as { secret: string };
  const worker = await withDaemon({
    configOverrides: { gateway: { token: secret, url: `ws://127.0.0.1:${port}` } },
    driverScript: { ios: { knownModels: ["iPhone 17"], availableOsVersions: ["18.4"] } },
  });
  await waitFor(
    async () => (await gateway.events()).some((event) => event.event === "worker.connected"),
    { label: "the worker joined the gateway", timeout: 30_000 },
  );
  return { gateway, worker };
}

function leaseArgs(agentId: string): string[] {
  return [
    "lease",
    "--platform",
    "ios",
    "--device",
    "iPhone 17",
    "--os",
    "18.4",
    "--agent-id",
    agentId,
  ];
}

/** The lines of a stream: a replayed event is printed as itself, a pushed one inside its push. */
function parse(stdout: string): RecordedEvent[] {
  return stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as RecordedEvent | { readonly event: RecordedEvent })
    .map(
      (printed) => (typeof printed.event === "object" ? printed.event : printed) as RecordedEvent,
    );
}

describe("gateway event relay", () => {
  it("a lease taken on a worker appears in the gateway's simlock events with the worker's id and timestamp plus workerId", async () => {
    const { gateway, worker } = await gatewayWithWorker();

    const held = worker.cliBackground(leaseArgs("relay-join"));
    const grant = JSON.parse(await held.firstStdoutLine()) as { lease: { id: string } };
    const leaseId = grant.lease.id;
    const isGrant = (event: RecordedEvent) =>
      event.event === "lease.granted" &&
      (event.payload as { leaseId?: string }).leaseId === leaseId;

    let relayed: RecordedEvent | undefined;
    await waitFor(
      async () => {
        relayed = (await gateway.events()).find(isGrant);
        return relayed !== undefined;
      },
      { label: "the worker's lease.granted reached the gateway", timeout: 20_000 },
    );
    const own = (await worker.events()).find(isGrant);

    expect(own).toBeDefined();
    expect(relayed?.id).toBe(own?.id);
    expect(relayed?.timestamp).toBe(own?.timestamp);
    expect(relayed?.payload).toEqual({
      ...(own?.payload as object),
      workerId: expect.stringMatching(/\S/),
    });
    expect(own?.payload).not.toHaveProperty("workerId");

    held.kill("SIGTERM");
    await held.waitForExit(15_000);
  });

  it("simlock events --follow on a gateway prints an event that arrives during the replay once", async () => {
    const { gateway, worker } = await gatewayWithWorker();
    const follower = gateway.cliBackground(["events", "--follow", "--since", "1h"]);

    // Leases churn on the worker while the follower replays and then streams, so some events
    // are both in the replay and pushed.
    const holders = [0, 1, 2].map((index) =>
      worker.cliBackground(leaseArgs(`relay-follow-${index}`)),
    );
    await Promise.all(holders.map((holder) => holder.firstStdoutLine()));
    for (const holder of holders) holder.kill("SIGTERM");
    await Promise.all(holders.map((holder) => holder.waitForExit(15_000)));

    await waitFor(
      () => parse(follower.stdoutSoFar()).filter((e) => e.event === "lease.released").length >= 3,
      {
        label: () =>
          `the follower printed the releases: ${parse(follower.stdoutSoFar())
            .map((e) => e.event)
            .join(",")}`,
        timeout: 20_000,
      },
    );
    follower.kill("SIGTERM");
    await follower.waitForExit(15_000);

    const printed = parse(follower.stdoutSoFar());
    const ids = printed.map((event) => event.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(printed.filter((event) => event.event === "lease.granted")).toHaveLength(3);
  });
});
