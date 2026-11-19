import { describe, expect, it } from "vitest";

import { buildDispatcher, session } from "./test-dispatcher.js";

describe("Dispatcher: lease.request with a label", () => {
  it("a lease requested with a label carries it in the grant and in every later read, and a request without one carries none", async () => {
    const { dispatcher } = await buildDispatcher();
    const ask = { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" } as const;
    const agent = session({ principal: "tok_owner" });

    const labelled = await dispatcher.dispatch(
      "lease.request",
      { ...ask, label: "feature-x", requesterId: "labelled" },
      agent,
    );
    const plain = await dispatcher.dispatch(
      "lease.request",
      { ...ask, requesterId: "plain" },
      agent,
    );

    const listed = (await dispatcher.dispatch("lease.list", {}, agent)).leases;
    const status = (await dispatcher.dispatch("status.get", {}, agent)).leases;
    const got = (await dispatcher.dispatch("lease.get", { leaseId: labelled.lease.id }, agent))
      .lease;
    expect(labelled.lease.label).toBe("feature-x");
    expect(got.label).toBe("feature-x");
    expect(listed.find((lease) => lease.id === labelled.lease.id)?.label).toBe("feature-x");
    expect(status?.find((lease) => lease.id === labelled.lease.id)?.label).toBe("feature-x");
    expect(plain.lease).not.toHaveProperty("label");
    expect(listed.find((lease) => lease.id === plain.lease.id)).not.toHaveProperty("label");
  });
});
