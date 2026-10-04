import { describe, expect, it } from "vitest";

import { eventEnvelopeSchema } from "./schemas.js";

describe("eventEnvelopeSchema", () => {
  const valid = {
    id: "evt_abc",
    seq: 1,
    timestamp: 1_000,
    event: "daemon.stopping",
    payload: { reason: "x" },
    module: "daemon",
  };

  it("the event envelope schema refuses a missing id, an id over 68 characters, an id without evt_, and a non-finite timestamp", () => {
    expect(eventEnvelopeSchema.safeParse(valid).success).toBe(true);
    expect(eventEnvelopeSchema.safeParse({ ...valid, id: `evt_${"a".repeat(64)}` }).success).toBe(
      true,
    );

    const { id: _id, ...withoutId } = valid;
    expect(eventEnvelopeSchema.safeParse(withoutId).success).toBe(false);
    expect(eventEnvelopeSchema.safeParse({ ...valid, id: `evt_${"a".repeat(65)}` }).success).toBe(
      false,
    );
    expect(eventEnvelopeSchema.safeParse({ ...valid, id: "evt_" }).success).toBe(false);
    expect(eventEnvelopeSchema.safeParse({ ...valid, id: "abc" }).success).toBe(false);
    expect(eventEnvelopeSchema.safeParse({ ...valid, id: "evt_a b" }).success).toBe(false);
    expect(eventEnvelopeSchema.safeParse({ ...valid, id: 7 }).success).toBe(false);
    for (const timestamp of [Number.POSITIVE_INFINITY, Number.NaN]) {
      expect(eventEnvelopeSchema.safeParse({ ...valid, timestamp }).success).toBe(false);
    }
  });
});
