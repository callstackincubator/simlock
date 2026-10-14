import { describe, expect, it } from "vitest";

import { createCaptureRegistry, createStreamLeaseEnd, type RunningCapture } from "./captures.js";

// why: a capture that remembers being stopped, so a test can say that this capture stopped and not
// another -- a registry that only cleared its map would pass a test that counted the map.
function spy(): RunningCapture & { stops(): number } {
  let stopped = 0;
  return {
    close: () => {
      stopped += 1;
    },
    stops: () => stopped,
  };
}

describe("createCaptureRegistry", () => {
  it("stops the captures of one lease and none of another", () => {
    const registry = createCaptureRegistry();
    const first = spy();
    const second = spy();
    registry.track("lse_a", first);
    registry.track("lse_b", second);

    expect(registry.stop("lse_a")).toBe(1);
    expect(first.stops()).toBe(1);
    expect(second.stops()).toBe(0);
    expect(registry.leases()).toEqual(["lse_b"]);
  });

  it("stops every capture of a lease, because one device can be watched from more than one page", () => {
    const registry = createCaptureRegistry();
    const viewers = [spy(), spy(), spy()];
    for (const viewer of viewers) registry.track("lse_a", viewer);

    expect(registry.stop("lse_a")).toBe(3);
    expect(viewers.map((viewer) => viewer.stops())).toEqual([1, 1, 1]);
    expect(registry.leases()).toEqual([]);
  });

  it("forgets a capture closed through its own handle, so a stop does not close it twice", () => {
    const registry = createCaptureRegistry();
    const capture = spy();
    const handle = registry.track("lse_a", capture);

    handle.close();
    expect(registry.leases()).toEqual([]);
    expect(registry.stop("lse_a")).toBe(0);
    // why: one stop is the tool seeing its stdin close once; a second close here is the registry still
    // naming a capture it should have let go of, aimed at a process that may be somebody else's by now.
    expect(capture.stops()).toBe(1);
  });

  it("keeps the lease's other captures when one viewer goes away", () => {
    const registry = createCaptureRegistry();
    const staying = spy();
    const leaving = spy();
    const handle = registry.track("lse_a", leaving);
    registry.track("lse_a", staying);

    handle.close();
    expect(leaving.stops()).toBe(1);
    expect(staying.stops()).toBe(0);
    expect(registry.leases()).toEqual(["lse_a"]);
  });

  it("stops nothing for a lease it never heard of", () => {
    const registry = createCaptureRegistry();
    registry.track("lse_a", spy());
    expect(registry.stop("lse_nope")).toBe(0);
    expect(registry.leases()).toEqual(["lse_a"]);
  });
});

describe("createStreamLeaseEnd", () => {
  it("ends a picture the moment the lease ends, with the viewer still connected", () => {
    const registry = createCaptureRegistry();
    const capture = spy();
    registry.track("lse_a", capture);
    const leaseEnd = createStreamLeaseEnd(registry);

    // why: this is the case an aborted request cannot cover -- a lease ended somewhere else (released by
    // a CLI, expired, its device lost) while a browser still holds the stream open. Without this the
    // viewer keeps watching a simulator this worker has already handed back to the pool, and the next
    // lease of that device is someone else's screen.
    void leaseEnd.leaseEnded(ended("lse_a"), new AbortController().signal);
    expect(capture.stops()).toBe(1);
    expect(registry.leases()).toEqual([]);
  });

  it("is idle for a lease that never streamed anything", async () => {
    const registry = createCaptureRegistry();
    await expect(
      createStreamLeaseEnd(registry).leaseEnded(ended("lse_a"), new AbortController().signal),
    ).resolves.toBeUndefined();
  });
});

function ended(leaseId: string) {
  return {
    deviceId: "dev_1",
    leaseId,
    ownerId: "agent-1",
    platform: "ios" as const,
    reason: "explicit" as const,
  };
}
