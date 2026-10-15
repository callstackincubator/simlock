import { describe, expect, it } from "vitest";

import { createCaptureRegistry, createStreamLeaseEnd } from "./captures.js";

function ended(leaseId: string) {
  return { leaseId } as Parameters<ReturnType<typeof createStreamLeaseEnd>["leaseEnded"]>[0];
}

describe("the capture registry", () => {
  it("a lease that ends while its capture is starting aborts the slot and closes the capture once it attaches", async () => {
    const captures = createCaptureRegistry();
    const slot = captures.begin("lse_1");
    await captures.stop("lse_1");
    expect(slot.ended.aborted).toBe(true);
    let closes = 0;
    slot.attach(async () => {
      closes += 1;
    });
    await Promise.resolve();
    expect(closes).toBe(1);
  });

  it("stops every capture of the lease that ended and leaves another lease's running", async () => {
    const captures = createCaptureRegistry();
    const closed: string[] = [];
    captures.begin("lse_1").attach(async () => void closed.push("a"));
    captures.begin("lse_1").attach(async () => void closed.push("b"));
    captures.begin("lse_2").attach(async () => void closed.push("c"));
    expect(await captures.stop("lse_1")).toBe(2);
    expect(closed).toEqual(["a", "b"]);
    expect(captures.leases()).toEqual(["lse_2"]);
  });

  it("closes a capture once however many doors close it", async () => {
    const captures = createCaptureRegistry();
    let closes = 0;
    const slot = captures.begin("lse_1");
    slot.attach(async () => {
      closes += 1;
    });
    await slot.release();
    await slot.release();
    await captures.stop("lse_1");
    expect(closes).toBe(1);
  });

  it("a released capture no longer counts as its lease's", async () => {
    const captures = createCaptureRegistry();
    await captures.begin("lse_1").release();
    expect(captures.leases()).toEqual([]);
    expect(await captures.stop("lse_1")).toBe(0);
  });
});

describe("the stream's lease-end participant", () => {
  it("returns only once the ended lease's captures have closed", async () => {
    const captures = createCaptureRegistry();
    let finish!: () => void;
    captures.begin("lse_1").attach(() => new Promise<void>((resolve) => (finish = resolve)));
    let returned = false;
    const done = createStreamLeaseEnd(captures)
      .leaseEnded(ended("lse_1"), new AbortController().signal)
      .then(() => {
        returned = true;
      });
    await Promise.resolve();
    expect(returned).toBe(false);
    finish();
    await done;
    expect(returned).toBe(true);
  });

  it("stops waiting when leasing gives up on it", async () => {
    const captures = createCaptureRegistry();
    captures.begin("lse_1").attach(() => new Promise<void>(() => undefined));
    const abort = new AbortController();
    const done = createStreamLeaseEnd(captures).leaseEnded(ended("lse_1"), abort.signal);
    abort.abort();
    await expect(done).resolves.toBeUndefined();
  });
});
