import { describe, expect, it } from "vitest";

import { release } from "./test-edge.js";
import {
  command,
  granted,
  hex,
  leaseTenant,
  principals,
  rpc,
  scope,
  send,
  setUp,
} from "./test-support.js";

describe("the agent-device front gives each lease its own tenant on a worker", () => {
  it("calls of two leases on one token reach agent-device as two tenants, and every call of one lease as one, though the client named another tenant", async () => {
    const rig = await setUp();
    const named = { tenantId: "someone-else" };
    const tenants = (method: string) =>
      rig.fake.rpcRequests(method).map((request) => request.tenant);
    const tenantOf = (n: number) => leaseTenant(principals.one, n);

    await granted(rig, 1, named);
    await granted(rig, 2, named);
    await rpc(rig, "agent_device.lease.heartbeat", { ...scope, leaseId: hex(1) });
    await command(rig, "snapshot", 1, {}, named);
    await command(rig, "snapshot", 2, {}, named);
    await command(rig, "snapshot", undefined, {}, named);
    await release(rig, 1);
    const named1 = { "x-agent-device-lease-id": hex(1) };
    await send(rig, "/upload/preflight", { body: "{}", headers: named1 });
    await send(rig, "/artifacts/a1", { headers: { "x-agent-device-lease-id": hex(2) } });
    await send(rig, "/upload/preflight", { body: "{}" });
    const byPath = (path: string) =>
      rig.fake.requests.filter((request) => request.path === path).map((request) => request.tenant);

    expect(byPath("/upload/preflight")).toEqual([tenantOf(1), principals.one]);
    expect(byPath("/artifacts/a1")).toEqual([tenantOf(2)]);
    expect(tenants("agent_device.lease.allocate")).toEqual([tenantOf(1), tenantOf(2)]);
    expect(tenants("agent_device.lease.heartbeat")).toEqual([tenantOf(1)]);
    expect(tenants("agent_device.command")).toEqual([tenantOf(1), tenantOf(2), principals.one]);
    expect(tenants("agent_device.lease.release")).toEqual([tenantOf(1)]);
  });
});
