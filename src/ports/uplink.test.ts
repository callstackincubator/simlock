import { describe, expect, it, vi } from "vitest";

import { createConnectionPair, MemoryUplinkTransport, UplinkError } from "./uplink.js";
import type { AcceptedUplink } from "./uplink.js";

describe("createConnectionPair", () => {
  it("delivers what one end writes to the other end's data listeners", async () => {
    const [left, right] = createConnectionPair();
    const received: string[] = [];
    right.onData((chunk) => received.push(chunk));

    await left.write('{"id":1,"type":"hello"}\n');

    expect(received).toEqual(['{"id":1,"type":"hello"}\n']);
  });

  it("closes both ends, whichever one is closed", async () => {
    const [left, right] = createConnectionPair();
    const closed = vi.fn();
    right.onClose(closed);

    await left.close();

    expect(left.closed).toBe(true);
    expect(right.closed).toBe(true);
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it("fires an onClose listener attached after the close, rather than losing it", () => {
    const [left, right] = createConnectionPair();
    void left.close();
    const closed = vi.fn();

    right.onClose(closed);

    expect(closed).toHaveBeenCalledTimes(1);
  });

  it("drops a write to a closed peer instead of throwing", async () => {
    const [left, right] = createConnectionPair();
    const received: string[] = [];
    right.onData((chunk) => received.push(chunk));
    await right.close();

    await expect(left.write("frame\n")).resolves.toBeUndefined();
    expect(received).toEqual([]);
  });
});

describe("MemoryUplinkTransport", () => {
  function transportWithListener(authenticate: (token: string | undefined) => boolean) {
    const transport = new MemoryUplinkTransport();
    const accepted: AcceptedUplink[] = [];
    return {
      transport,
      accepted,
      listen: () =>
        transport.listen({
          accept: (uplink) => accepted.push(uplink),
          authenticate: async (credential) => authenticate(credential),
        }),
    };
  }

  it("refuses to dial when no gateway is listening", async () => {
    const transport = new MemoryUplinkTransport();

    await expect(
      transport.connect({ url: "ws://gateway/v1/uplink", token: "t", workerId: "wrk_1" }),
    ).rejects.toMatchObject({ code: "unreachable" });
  });

  it("hands the listener an accepted uplink carrying the worker id and label", async () => {
    const harness = transportWithListener(() => true);
    await harness.listen();

    const workerEnd = await harness.transport.connect({
      url: "ws://gateway/v1/uplink",
      token: "join",
      workerId: "wrk_1",
      label: "mac-mini-1",
    });

    expect(harness.accepted).toHaveLength(1);
    expect(harness.accepted[0]?.workerId).toBe("wrk_1");
    expect(harness.accepted[0]?.label).toBe("mac-mini-1");

    // The two ends are wired to each other: the gateway sees what the worker writes.
    const received: string[] = [];
    harness.accepted[0]?.connection.onData((chunk) => received.push(chunk));
    await workerEnd.write("frame\n");
    expect(received).toEqual(["frame\n"]);
  });

  it("rejects a token the gateway does not recognize, and accepts nothing", async () => {
    const harness = transportWithListener((token) => token === "good");
    await harness.listen();

    await expect(
      harness.transport.connect({
        url: "ws://gateway/v1/uplink",
        token: "revoked",
        workerId: "wrk_1",
      }),
    ).rejects.toMatchObject({ code: "rejected" });
    expect(harness.accepted).toEqual([]);
  });

  it("stops accepting once the listener is closed", async () => {
    const harness = transportWithListener(() => true);
    const listener = await harness.listen();
    await listener.close();

    await expect(
      harness.transport.connect({ url: "ws://gateway/v1/uplink", token: "t", workerId: "wrk_1" }),
    ).rejects.toBeInstanceOf(UplinkError);
  });
});
