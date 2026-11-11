import { describe, expect, it } from "vitest";
import { leaseFixture, ScriptedWorkerClient } from "./test-support.js";
import { GATEWAY_REQUESTER_PREFIX, harness, session } from "./test-dispatcher.js";

describe("GatewayDispatcher: right after a gateway restart", () => {
  it("right after a gateway restart, renewing a generated lease id answers WORKER_UNREACHABLE until its worker reports, then renews the lease", async () => {
    const { clock, dispatcher, directory, workers } = harness();
    const agent = session({ principal: "alice-principal", role: "agent" });
    const renew = (leaseId: string) => dispatcher.dispatch("lease.renew", { leaseId }, agent);
    const unreachable = { code: "WORKER_UNREACHABLE", details: { workerId: "wrk_1" } };

    await expect(renew("wrk_1.lease_1"), "worker not reconnected").rejects.toMatchObject(
      unreachable,
    );

    const client = new ScriptedWorkerClient();
    directory.add("wrk_1", client);
    workers.connected("wrk_1", undefined, undefined);
    await expect(renew("wrk_1.lease_1"), "reconnected, leases unreported").rejects.toMatchObject(
      unreachable,
    );
    await expect(
      renew("chosen-id"),
      "a caller-chosen id keeps ADR 0020's answer",
    ).rejects.toMatchObject({ code: "UNKNOWN_LEASE" });

    workers.refresh("wrk_1", {
      leases: [
        {
          ...leaseFixture("lease_1", "dev_1"),
          ownerId: "alice-principal",
          requesterId: `${GATEWAY_REQUESTER_PREFIX}alice`,
        },
      ],
    });
    client.renewLeaseQueue.push({
      kind: "ok",
      record: { ...leaseFixture("lease_1", "dev_1"), ownerId: "alice-principal" },
    });
    await expect(renew("wrk_1.lease_1"), "reported").resolves.toMatchObject({
      id: "wrk_1.lease_1",
    });

    clock.advance(60_000);
    await expect(renew("wrk_1.ghost"), "past the window").rejects.toMatchObject({
      code: "UNKNOWN_LEASE",
    });
  });
});
