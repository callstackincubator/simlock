import { describe, expect, it } from "vitest";

import { FakeInputFactory } from "../core/testing.js";
import { createLeaseInputs } from "./lease-inputs.js";

const device = { id: "device-1", platform: "ios" } as never;
const ended = {
  deviceId: "device-1",
  leaseId: "lease-1",
  ownerId: "owner-1",
  platform: "ios",
  reason: "explicit",
} as const;

// why: the surface cannot force a user that holds the input past its lease's end: the input module and `device.rotate` both release at once, so only the registry's own lease-end participant is left to close it.
describe("createLeaseInputs", () => {
  it("closes the input of a lease whose user never releases it when the lease ends, and gives the next user of that lease a fresh one", async () => {
    const factory = new FakeInputFactory({ height: 2556, orientation: "portrait", width: 1179 });
    const inputs = createLeaseInputs({ openInput: () => factory.open() });
    await inputs.leaseInput("lease-1", "ios", device);
    await inputs.leaseInput("lease-1", "ios", device);
    expect(factory.opened).toHaveLength(1);
    expect(factory.opened[0]?.closes).toBe(0);

    await inputs.leaseEnd.leaseEnded(ended, new AbortController().signal);
    await Promise.resolve();

    expect(factory.opened[0]?.closes).toBe(1);
    await inputs.leaseInput("lease-1", "ios", device);
    expect(factory.opened).toHaveLength(2);
  });

  it("drops an input that failed while another user still holds it, so the next user opens a fresh one", async () => {
    const factory = new FakeInputFactory({ height: 2556, orientation: "portrait", width: 1179 });
    const inputs = createLeaseInputs({ openInput: () => factory.open() });
    await inputs.leaseInput("lease-1", "ios", device);
    await inputs.leaseInput("lease-1", "ios", device);

    factory.opened[0]?.fail(new Error("pipe closed"));
    await Promise.resolve();

    expect(factory.opened[0]?.closes).toBe(1);
    const fresh = await inputs.leaseInput("lease-1", "ios", device);
    expect(factory.opened).toHaveLength(2);
    expect(fresh.input).toBe(factory.opened[1]);
  });
});
