import { describe, expect, it } from "vitest";

import { buildDispatcher, session } from "./test-dispatcher.js";

describe("Dispatcher: lease.request with a run id", () => {
  it("a lease requested with a run id carries it in the grant and in every later read, and a request without one carries none", async () => {
    const { dispatcher, state } = await buildDispatcher();
    const ask = { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" } as const;
    const agent = session({ principal: "tok_owner" });

    const tagged = await dispatcher.dispatch(
      "lease.request",
      { ...ask, requesterId: "tagged", runId: "123-1" },
      agent,
    );
    const plain = await dispatcher.dispatch(
      "lease.request",
      { ...ask, requesterId: "plain" },
      agent,
    );

    const listed = (await dispatcher.dispatch("lease.list", {}, agent)).leases;
    const status = (await dispatcher.dispatch("status.get", {}, agent)).leases;
    const got = (await dispatcher.dispatch("lease.get", { leaseId: tagged.lease.id }, agent)).lease;
    expect(tagged.lease.runId).toBe("123-1");
    expect(got.runId).toBe("123-1");
    expect(listed.find((lease) => lease.id === tagged.lease.id)?.runId).toBe("123-1");
    expect(status?.find((lease) => lease.id === tagged.lease.id)?.runId).toBe("123-1");
    expect(plain.lease).not.toHaveProperty("runId");
    expect(listed.find((lease) => lease.id === plain.lease.id)).not.toHaveProperty("runId");

    const restarted = (await buildDispatcher({ state })).dispatcher;
    const afterRestart = (await restarted.dispatch("lease.list", {}, agent)).leases;
    expect(afterRestart.find((lease) => lease.id === tagged.lease.id)).toMatchObject({
      runId: "123-1",
    });
    expect(afterRestart.find((lease) => lease.id === plain.lease.id)).not.toHaveProperty("runId");
  });
});
