import { describe, expect, it } from "vitest";

import { eventSummary, eventTone } from "./activity";
import type { ConsoleEvent } from "./events";
import type { WorkerView } from "./workers";

const studio = {
  catalog: [],
  connection: "connected",
  devices: [
    {
      id: "dev_1",
      mode: "full",
      physical: false,
      spec: { model: "Pixel 8", osVersion: "35", physical: false, platform: "android" },
      state: "leased",
    },
  ],
  drained: false,
  id: "wrk_studio",
  label: "mac-studio-01",
  lastSeenAt: 0,
  leases: [],
} as unknown as WorkerView;

function event(name: string, payload: unknown): ConsoleEvent {
  return { event: name, id: "e1", payload, seq: 1, timestamp: 0 };
}

describe("an event's one-line summary", () => {
  it("names who, which device and where, from the fields the payload has", () => {
    const granted = event("lease.granted", {
      deviceId: "dev_1",
      requester: "claude-ios-4",
      workerId: "wrk_studio",
    });

    expect(eventSummary(granted, [studio])).toBe("claude-ios-4 · Pixel 8 35 · mac-studio-01");
  });

  it("falls back to the event's name when the payload names nothing it knows", () => {
    expect(eventSummary(event("daemon.started", { pid: 4 }), [studio])).toBe("daemon.started");
    expect(eventSummary(event("daemon.started", "text"), [])).toBe("daemon.started");
  });

  it("keeps a device id it cannot place out of the line rather than guessing", () => {
    const reclaimed = event("device.reclaimed", { deviceId: "dev_gone", reason: "erase" });

    expect(eventSummary(reclaimed, [studio])).toBe("erase");
  });
});

describe("an event's tone", () => {
  it("is red for trouble, yellow for a warning, and none for an ordinary event", () => {
    expect(eventTone("device.quarantined")).toBe("error");
    expect(eventTone("worker.disconnected")).toBe("error");
    expect(eventTone("lease.expired")).toBe("warn");
    expect(eventTone("worker.drain-started")).toBe("warn");
    expect(eventTone("lease.granted")).toBeUndefined();
  });
});

describe("a requester a gateway relayed", () => {
  it("is named by the agent behind the gateway's prefix", () => {
    const relayed = event("lease.granted", { requester: "gw:03787a13-4eac:claude-ios-3" });

    expect(eventSummary(relayed, [])).toBe("claude-ios-3");
  });
});
