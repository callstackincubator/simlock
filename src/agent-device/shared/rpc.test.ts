import { describe, expect, it } from "vitest";

import { commandLeaseId, readReply } from "./rpc.js";

const first = "a".repeat(32);
const second = "b".repeat(32);

describe("a command's lease ID", () => {
  it("is read from params.meta.leaseId, else params.flags.leaseId, and a value that is not 32 lowercase hex is no lease ID", () => {
    expect(commandLeaseId({ meta: { leaseId: first } })).toBe(first);
    expect(commandLeaseId({ flags: { leaseId: second } })).toBe(second);
    expect(commandLeaseId({ flags: { leaseId: second }, meta: { leaseId: first } })).toBe(first);

    expect(commandLeaseId({ meta: { leaseId: first.toUpperCase() } })).toBeUndefined();
    expect(commandLeaseId({ meta: { leaseId: first.slice(1) } })).toBeUndefined();
    expect(commandLeaseId({ meta: { leaseId: `${first}0` } })).toBeUndefined();
    expect(commandLeaseId({ meta: { leaseId: `${"g".repeat(32)}` } })).toBeUndefined();
    expect(commandLeaseId({ meta: { leaseId: 7 } })).toBeUndefined();
    expect(commandLeaseId({})).toBeUndefined();
  });
});

describe("readReply on the allocate reply agent-device sends", () => {
  const lease = {
    backend: "ios-instance",
    clientId: "c902297e635eb082",
    createdAt: 1791894026484,
    deviceKey: "ios:mobile:45C1194B-0BE5-4BAE-AAC9-F48070759060",
    expiresAt: 1791980426486,
    heartbeatAt: 1791894026486,
    leaseId: "278f30d59b069c0dde98555b9103b962",
    leaseProvider: "proxy",
    runId: "proxy-c902297e635eb082",
    tenantId: "tok_04c37a6e",
  };

  it("a reply with the lease under `result.data`, as the slow lane recorded it, is a success", () => {
    const text = JSON.stringify({
      id: "x",
      jsonrpc: "2.0",
      result: { data: { device: { platform: "ios", target: "mobile" }, lease }, ok: true },
    });

    expect(readReply(text, "allocate").kind).toBe("success");
  });

  it("a reply with the lease directly under `result` is unusable, since agent-device never sends that", () => {
    const text = JSON.stringify({ id: "x", jsonrpc: "2.0", result: { lease, ok: true } });

    expect(readReply(text, "allocate").kind).toBe("unusable");
  });
});
