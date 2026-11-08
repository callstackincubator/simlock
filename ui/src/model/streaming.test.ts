import { describe, expect, it } from "vitest";

import { eventsOfDevice, eventTitle } from "./streaming";

const event = (id: string, seq: number, name: string, payload: unknown) => ({
  event: name,
  id,
  payload,
  seq,
  timestamp: seq * 1000,
});

describe("the streaming page's events", () => {
  it("keeps the device's own and its lease's events, newest first, each once", () => {
    const events = [
      event("a", 1, "device.ready", { deviceId: "dev_1" }),
      event("b", 2, "lease.granted", { deviceId: "dev_1", leaseId: "lse_1" }),
      event("c", 3, "lease.renewed", { leaseId: "lse_1" }),
      event("d", 4, "device.ready", { deviceId: "dev_2" }),
      event("e", 5, "device.ready", { deviceId: "dev_1", workerId: "wrk_2" }),
    ];

    expect(eventsOfDevice(events, "wrk_1", "dev_1", "lse_1").map((one) => one.id)).toEqual([
      "c",
      "b",
      "a",
    ]);
    expect(eventsOfDevice(events, "wrk_1", "dev_1", undefined).map((one) => one.id)).toEqual([
      "b",
      "a",
    ]);
  });

  it("words an event name as a title", () => {
    expect(eventTitle("lease.granted")).toBe("Lease granted");
  });
});
