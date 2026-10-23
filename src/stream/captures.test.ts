import { describe, expect, it } from "vitest";

import { createCaptureRegistry, createStreamLeaseEnd } from "./captures.js";

async function flush(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) await new Promise((resolve) => setImmediate(resolve));
}

function ended(deviceId: string) {
  return { deviceId } as Parameters<ReturnType<typeof createStreamLeaseEnd>["leaseEnded"]>[0];
}

describe("the capture registry", () => {
  it("a device that stops while its capture is starting aborts the slot, waits for it to attach, and closes it", async () => {
    const captures = createCaptureRegistry();
    const slot = captures.beginOnDevice("dev_1");
    let stopped = false;
    const stopping = captures.stopOnDevice("dev_1").then(() => (stopped = true));
    expect(slot.ended.aborted).toBe(true);
    await Promise.resolve();
    expect(stopped).toBe(false);
    let closes = 0;
    slot.attach(async () => {
      closes += 1;
    });
    await stopping;
    expect(closes).toBe(1);
  });

  it("stops every capture of the device that stopped and leaves another device's running", async () => {
    const captures = createCaptureRegistry();
    const closed: string[] = [];
    captures.beginOnDevice("dev_1").attach(async () => void closed.push("a"));
    captures.beginOnDevice("dev_1").attach(async () => void closed.push("b"));
    captures.beginOnDevice("dev_2").attach(async () => void closed.push("c"));
    expect(await captures.stopOnDevice("dev_1")).toBe(2);
    expect(closed).toEqual(["a", "b"]);
    expect(await captures.stopOnDevice("dev_2")).toBe(1);
  });

  it("closes a capture once however many doors close it", async () => {
    const captures = createCaptureRegistry();
    let closes = 0;
    const slot = captures.beginOnDevice("dev_1");
    slot.attach(async () => {
      closes += 1;
    });
    await slot.release();
    await slot.release();
    await captures.stopOnDevice("dev_1");
    expect(closes).toBe(1);
  });

  it("an abandoned open no longer counts as its device's", async () => {
    const captures = createCaptureRegistry();
    captures.beginOnDevice("dev_1").abandon();
    expect(await captures.stopOnDevice("dev_1")).toBe(0);
  });

  it("a released capture counts as its device's until it is closed", async () => {
    const captures = createCaptureRegistry();
    const slot = captures.beginOnDevice("dev_1");
    let finish!: () => void;
    slot.attach(() => new Promise<void>((resolve) => (finish = resolve)));
    const releasing = slot.release();
    await flush();
    const stopping = captures.stopOnDevice("dev_1");
    await flush();
    finish();
    await releasing;
    expect(await stopping).toBe(1);
    expect(await captures.stopOnDevice("dev_1")).toBe(0);
  });

  it("a slot released before its capture attached closes that capture once it attaches", async () => {
    const captures = createCaptureRegistry();
    const slot = captures.beginOnDevice("dev_1");
    const releasing = slot.release();
    let closes = 0;
    slot.attach(async () => {
      closes += 1;
    });
    await releasing;
    expect(closes).toBe(1);
    expect(await captures.stopOnDevice("dev_1")).toBe(0);
  });
});

describe("the stream's lease-end participant", () => {
  it("returns only once the ended lease's device's captures have closed", async () => {
    const captures = createCaptureRegistry();
    let finish!: () => void;
    captures
      .beginOnDevice("dev_1")
      .attach(() => new Promise<void>((resolve) => (finish = resolve)));
    let returned = false;
    const done = createStreamLeaseEnd(captures)
      .leaseEnded(ended("dev_1"), new AbortController().signal)
      .then(() => {
        returned = true;
      });
    await flush();
    expect(returned).toBe(false);
    finish();
    await done;
    expect(returned).toBe(true);
  });

  it("stops waiting when leasing gives up on it", async () => {
    const captures = createCaptureRegistry();
    captures.beginOnDevice("dev_1").attach(() => new Promise<void>(() => undefined));
    const abort = new AbortController();
    const done = createStreamLeaseEnd(captures)
      .leaseEnded(ended("dev_1"), abort.signal)
      .then(() => "returned");
    abort.abort();
    const outcome = await Promise.race([
      done,
      new Promise<string>((resolve) => setTimeout(() => resolve("still waiting"), 50)),
    ]);
    expect(outcome).toBe("returned");
  });
});
