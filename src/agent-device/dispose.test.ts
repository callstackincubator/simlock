import { describe, expect, it } from "vitest";
import { FakeClock } from "../ports/clock.js";
import { disposeAgentDeviceEdge, type AgentDeviceFrontParts } from "./front/edge-parts.js";
import { FrontMap } from "./front/front-map.js";
import { Renewals } from "./front/renewals.js";
import type { HostLink } from "./front/host-link.js";

describe("disposeAgentDeviceEdge", () => {
  it("disposes the renewals, so a command that begins afterwards arms no timer, and disposes the link", () => {
    const clock = new FakeClock(0);
    const renewals = new Renewals(clock);
    let linkDisposed = 0;
    const link: HostLink = {
      dispose: () => {
        linkDisposed += 1;
      },
      forward: () => Promise.reject(new Error("unused")),
      leaseRequires: [],
      readsLeaseHeader: false,
      status: () => Promise.resolve({ reason: "unused", state: "unavailable" }),
    };
    const parts: AgentDeviceFrontParts = { link, map: new FrontMap(clock), renewals };

    disposeAgentDeviceEdge(parts);

    expect(linkDisposed).toBe(1);
    const context = {
      map: { get: () => ({ endedAt: undefined, identity: { requesterId: "a" }, ttlMs: 30_000 }) },
    };
    renewals.begin(context as never, "lease", "a", 60_000);
    expect(clock.pendingTimerCount).toBe(0);
  });
});
