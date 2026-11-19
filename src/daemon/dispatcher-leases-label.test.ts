import { describe, expect, it } from "vitest";

import { classifyError } from "./error-code.js";
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

  it("a bad label is refused BAD_REQUEST with the same words, and grants nothing", async () => {
    const { dispatcher } = await buildDispatcher();
    const ask = { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" } as const;
    const agent = session({ principal: "tok_owner" });
    const length = "label must be 1 to 64 characters";
    const control = "label must not contain control characters";

    const refused = [
      ["empty", "", length],
      ["65 characters", "a".repeat(65), length],
      ["a newline", "a\nb", control],
      ["a tab", "\t", control],
      ["NUL", "a\u0000b", control],
      ["U+2028", "a\u2028b", control],
      ["U+2029", "a\u2029b", control],
    ] as const;
    for (const [name, label, message] of refused) {
      const error = await dispatcher
        .dispatch("lease.request", { ...ask, label, noWait: true, requesterId: "bad" }, agent)
        .catch((caught: unknown) => caught);
      expect(classifyError(error), name).toBe("BAD_REQUEST");
      expect((error as Error).message, name).toBe(message);
    }

    const accepted = await dispatcher.dispatch(
      "lease.request",
      { ...ask, label: "a".repeat(64), requesterId: "good" },
      agent,
    );
    expect(accepted.lease.label).toBe("a".repeat(64));
    const held = (await dispatcher.dispatch("status.get", {}, agent)).leases;
    expect(held).toHaveLength(1);
  });

  it("an idempotent repeat replays when the labels match and is an IDEMPOTENCY_CONFLICT when they differ", async () => {
    const { dispatcher } = await buildDispatcher();
    const ask = { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" } as const;
    const agent = session({ principal: "tok_owner" });

    const cases = [
      ["same label", "feature-x", "feature-x", "replay"],
      ["other label", "feature-x", "feature-y", "conflict"],
      ["label on the repeat only", undefined, "feature-x", "conflict"],
      ["label on the first only", "feature-x", undefined, "conflict"],
      ["neither", undefined, undefined, "replay"],
    ] as const;
    for (const [name, first, repeat, outcome] of cases) {
      const base = { ...ask, idempotencyKey: name, requesterId: name };
      const granted = await dispatcher.dispatch(
        "lease.request",
        { ...base, ...(first === undefined ? {} : { label: first }) },
        agent,
      );
      const again = await dispatcher
        .dispatch(
          "lease.request",
          { ...base, ...(repeat === undefined ? {} : { label: repeat }) },
          agent,
        )
        .catch((caught: unknown) => caught);
      if (outcome === "replay") {
        expect((again as typeof granted).lease, name).toEqual(granted.lease);
      } else {
        expect(classifyError(again), name).toBe("IDEMPOTENCY_CONFLICT");
      }
      await dispatcher.dispatch("lease.release", { leaseId: granted.lease.id }, agent);
    }
  });
});
