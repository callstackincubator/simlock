import { describe, expect, it } from "vitest";
import { promiseState } from "../test-support/promise-state.js";
import { classifyError } from "../daemon/error-code.js";
import { grantFixture, leaseFixture, ScriptedWorkerClient } from "./test-support.js";
import { harness, session } from "./test-dispatcher.js";
import { connectWorker, roomierIos, saturatedIos, tick } from "./test-fleet.js";

const available = [{ name: "bank-network", state: "available" }] as const;

function fleet() {
  const { dispatcher, directory, workers } = harness();
  // why: the tagged worker has the higher id, so a pick by id alone would land on the untagged one.
  const untagged = new ScriptedWorkerClient();
  const tagged = new ScriptedWorkerClient();
  directory.add("wrk_a", untagged);
  directory.add("wrk_b", tagged);
  connectWorker(workers, "wrk_a");
  connectWorker(workers, "wrk_b");
  workers.refresh("wrk_a", { capabilities: [] });
  workers.refresh("wrk_b", { capabilities: [...available], capacity: roomierIos() });
  return { dispatcher, tagged, untagged, workers };
}

const ask = { model: "iPhone 17", platform: "ios" } as const;
const agent = session({ principal: "tok_7f3a", role: "agent" });
const grantFor = (lease: string) =>
  ({
    grant: grantFixture({ lease: { ...leaseFixture(lease, `dev_${lease}`), ownerId: "tok_7f3a" } }),
    kind: "grant",
  }) as const;
const leaseRequests = (client: ScriptedWorkerClient) =>
  client.calls.filter((call) => call.startsWith("lease.request"));

describe("GatewayDispatcher: lease.request requires a worker's tag", () => {
  it("places a request that requires a tag only on the worker that lists it, waits for it when busy, and refuses with CAPABILITY_MISSING when no worker lists it", async () => {
    const { dispatcher, tagged, untagged, workers } = fleet();
    for (const index of [1, 2, 3]) tagged.requestLeaseQueue.push(grantFor(`lse_${String(index)}`));

    for (const index of [1, 2, 3]) {
      const granted = await dispatcher.dispatch(
        "lease.request",
        { ...ask, requesterId: `r${String(index)}`, requires: ["bank-network"] },
        agent,
      );
      expect(granted.lease.id).toBe(`wrk_b.lse_${String(index)}`);
    }
    expect(leaseRequests(untagged)).toEqual([]);

    await expect(
      dispatcher.dispatch(
        "lease.request",
        { ...ask, requesterId: "r4", requires: ["vpn-eu"] },
        agent,
      ),
    ).rejects.toMatchObject({
      code: "CAPABILITY_MISSING",
      message: "No worker connected to this gateway can serve vpn-eu for this request",
    });

    workers.refresh("wrk_b", { capacity: saturatedIos() });
    const waiting = dispatcher.dispatch(
      "lease.request",
      { ...ask, requesterId: "r5", requires: ["bank-network"] },
      agent,
    );
    const state = promiseState(waiting);
    await tick();
    expect(state.state).toBe("pending");
    expect(leaseRequests(untagged)).toEqual([]);
    expect(leaseRequests(tagged)).toHaveLength(3);
  });

  it("accepts requires with an idempotencyKey, replays the first answer for the same names in any order or none for an empty list, and refuses a different set with IDEMPOTENCY_CONFLICT", async () => {
    const { dispatcher, tagged } = fleet();
    tagged.requestLeaseQueue.push(grantFor("lse_1"), grantFor("lse_2"));
    const send = (extra: Record<string, unknown>) =>
      dispatcher.dispatch(
        "lease.request",
        { ...ask, idempotencyKey: "key-1", requesterId: "r1", ...extra },
        agent,
      );
    const names = ["bank-network"];

    const first = await send({ requires: names });
    const same = await send({ requires: [...names] });
    expect(same.lease.id).toBe(first.lease.id);
    expect(leaseRequests(tagged)).toHaveLength(1);

    for (const extra of [{ requires: [...names, "vpn-eu"] }, {}]) {
      const conflict = await send(extra).catch((error: unknown) => error);
      expect(classifyError(conflict)).toBe("IDEMPOTENCY_CONFLICT");
    }

    const emptyAsk = { ...ask, idempotencyKey: "key-2", requesterId: "r2" };
    const withEmpty = await dispatcher.dispatch(
      "lease.request",
      { ...emptyAsk, requires: [] },
      agent,
    );
    const without = await dispatcher.dispatch("lease.request", emptyAsk, agent);
    expect(without.lease.id).toBe(withEmpty.lease.id);
  });
});
