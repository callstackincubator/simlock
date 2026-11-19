import { describe, expect, it } from "vitest";
import {
  secrets,
  notAvailable,
  holderCannot,
  tooOld,
  adminSession,
  setUp,
  turn,
  send,
  rpc,
  envelopeOf,
  hex,
  grantedOnGateway,
  release,
  heartbeat,
  command,
  fleetLeases,
  tenantOf,
  track,
  expectEndedBySimlock,
  tapDispatch,
  heartbeatsReceived,
  first,
  leaveOutOfNextListing,
} from "./test-gateway.js";
import {
  LEASE_HEADER,
  notYoursOnGateway,
  leased,
  holderOf,
  listedByGateway,
  twoLeasesOnTwoWorkers,
  addressOfLease,
  pathsReceived,
  listedNames,
} from "./test-gateway-front.js";

const notALeaseId = "refused: the x-agent-device-lease-id header is not a lease id";

describe("the agent-device front, through a gateway: the lease header", { timeout: 60_000 }, () => {
  it("through the gateway, an upload preflight with the header naming the token's lease on W2 reaches W2's agent-device daemon and not W1's", async () => {
    const rig = await twoLeasesOnTwoWorkers();
    const target = holderOf(rig, 2);
    const other = holderOf(rig, 1);
    const before = pathsReceived(other);

    const preflight = await send(rig, "/upload/preflight", { body: "{}", headers: leased(2) });

    expect(preflight.status).toBe(200);
    expect(pathsReceived(target)).toContain("/upload/preflight");
    expect(target.fake.requests.find((seen) => seen.path === "/upload/preflight")?.tenant).toBe(
      await tenantOf(target, 2),
    );
    expect(pathsReceived(other)).toEqual(before);
  });

  it("the preflight's ticket URL names the gateway's origin, its `upload.headers` carry the caller's own `authorization`, W2 received its own daemon's token in `authorization` and `x-agent-device-token` and none of the caller's credentials, and a `PUT` to it with the lease header and those headers reaches W2", async () => {
    const rig = await twoLeasesOnTwoWorkers();
    const target = holderOf(rig, 2);

    const preflight = await send(rig, "/upload/preflight", {
      body: "{}",
      headers: { ...leased(2), "x-agent-device-token": "caller-token" },
    });

    const ticket = (
      (await preflight.json()) as { upload: { url: string; headers: Record<string, string> } }
    ).upload;
    expect(ticket.url.startsWith(`${rig.origin}/v1/agent-device/upload/direct/`)).toBe(true);
    const named = (name: string) =>
      Object.entries(ticket.headers).find(([key]) => key.toLowerCase() === name)?.[1];
    expect(named("authorization")).toBe(`Bearer ${secrets.one}`);
    expect(named("x-agent-device-token")).toBe("caller-token");
    const seen = target.fake.preflightHeaders[0] ?? {};
    expect(seen["authorization"]).toBe(`Bearer ${target.fake.token}`);
    // why: the proxy sends its own daemon token in both headers, never the caller's.
    expect(seen["x-agent-device-token"]).toBe(target.fake.token);
    expect(Object.values(seen).join("\n")).not.toContain(secrets.one);
    expect(Object.values(seen).join("\n")).not.toContain("caller-token");

    const put = await fetch(ticket.url, {
      body: "artifact bytes",
      headers: { ...ticket.headers, ...leased(2) },
      method: "PUT",
    });

    expect(put.status).toBe(200);
    expect(target.fake.uploads).toEqual(["artifact bytes"]);
    expect(holderOf(rig, 1).fake.uploads).toEqual([]);
  });

  it("a finalize, a `POST /upload`, a `GET artifacts/<id>` and a diagnostics `GET`, each with the header, reach the lease's worker", async () => {
    const rig = await twoLeasesOnTwoWorkers();
    const target = holderOf(rig, 2);
    const other = holderOf(rig, 1);
    const before = pathsReceived(other);

    await send(rig, "/upload/finalize", { body: "{}", headers: leased(2) });
    // why: the proxy confines diagnostics to sessions under the caller's tenant, which the gateway names.
    const tenant = target.fake.requests.at(-1)?.tenant;
    expect(tenant).toBeDefined();
    const diagnostics = `/sessions/${String(tenant)}:s1/requests/r1/diagnostics`;
    await send(rig, "/upload", { body: "{}", headers: leased(2) });
    await send(rig, "/artifacts/a.png", { headers: leased(2) });
    await send(rig, diagnostics, { headers: leased(2) });

    const paths = pathsReceived(target);
    expect(paths).toContain("/upload/finalize");
    expect(paths).toContain("/upload");
    expect(paths).toContain("/artifacts/a.png");
    expect(paths).toContain(diagnostics);
    expect(pathsReceived(other)).toEqual(before);
  });

  it("through the gateway, the same requests without the header, or with an empty one, and a `GET artifacts` list, are refused with `refused: this agent-device is too old to use through a gateway; update it`", async () => {
    const rig = await twoLeasesOnTwoWorkers();
    const diagnostics = `/sessions/${await tenantOf(holderOf(rig, 2), 2)}:s1/requests/r1/diagnostics`;
    const calls: readonly { path: string; body?: string }[] = [
      { body: "{}", path: "/upload/preflight" },
      { body: "{}", path: "/upload/finalize" },
      { body: "{}", path: "/upload" },
      { path: "/artifacts/a.png" },
      { path: diagnostics },
    ];
    for (const call of calls) {
      const accepted = await send(rig, call.path, {
        ...(call.body === undefined ? {} : { body: call.body }),
        headers: leased(2),
      });
      expect(await accepted.text()).not.toContain(tooOld);
      expect(pathsReceived(holderOf(rig, 2))).toContain(call.path);
    }
    const before = rig.members.map((member) => member.fake.requests.length);

    for (const call of calls) {
      for (const headers of [{}, { [LEASE_HEADER]: "" }]) {
        const answer = await send(rig, call.path, {
          ...(call.body === undefined ? {} : { body: call.body }),
          headers,
        });
        expect(await answer.text()).toContain(tooOld);
      }
    }
    const list = await send(rig, "/artifacts");
    expect(await list.text()).toContain(tooOld);

    expect(rig.members.map((member) => member.fake.requests.length)).toEqual(before);
  });

  it("through the gateway, a header naming another token's lease is refused `refused: lease <id> is not one of yours on this gateway` with status 403, and no agent-device daemon receives it", async () => {
    const rig = await twoLeasesOnTwoWorkers();
    const own = await send(rig, "/upload/preflight", { body: "{}", headers: leased(2) });
    expect(own.status).toBe(200);
    const before = rig.members.map((member) => member.fake.requests.length);

    const other = await send(rig, "/upload/preflight", {
      body: "{}",
      headers: leased(2),
      token: secrets.two,
    });

    expect(other.status).toBe(403);
    expect(await other.text()).toContain(notYoursOnGateway(2));
    expect(rig.members.map((member) => member.fake.requests.length)).toEqual(before);
  });

  it("through the gateway, a header of 40 characters, and one with upper-case hex, are refused `refused: the x-agent-device-lease-id header is not a lease id` with status 400, and the reply does not contain the value", async () => {
    const rig = await twoLeasesOnTwoWorkers();
    const accepted = await send(rig, "/upload/preflight", { body: "{}", headers: leased(2) });
    expect(accepted.status).toBe(200);
    const before = rig.members.map((member) => member.fake.requests.length);

    for (const value of ["a".repeat(40), `ABCDEF${"0".repeat(26)}`]) {
      const answer = await send(rig, "/upload/preflight", {
        body: "{}",
        headers: { [LEASE_HEADER]: value },
      });
      const text = await answer.text();
      expect(answer.status).toBe(400);
      expect(text).toContain(notALeaseId);
      expect(text).not.toContain(value);
    }

    expect(rig.members.map((member) => member.fake.requests.length)).toEqual(before);
  });

  it("through the gateway, a header naming the token's lease whose worker stopped being capable answers the notAvailable reply naming that reason", async () => {
    const rig = await twoLeasesOnTwoWorkers();
    const accepted = await send(rig, "/upload/preflight", { body: "{}", headers: leased(2) });
    expect(accepted.status).toBe(200);
    const target = holderOf(rig, 2);
    await turn(rig, target, "unavailable");
    const before = pathsReceived(target);

    const answer = await send(rig, "/upload/preflight", { body: "{}", headers: leased(2) });

    expect(await answer.text()).toContain(`${notAvailable}${holderCannot}`);
    expect(pathsReceived(target)).toEqual(before);
  });

  it("through the gateway, `/health` with a header naming another token's lease answers the proxy's health", async () => {
    const rig = await twoLeasesOnTwoWorkers();

    const health = await send(rig, "/health", { headers: leased(2), token: secrets.two });

    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ service: "agent-device-proxy" });
  });

  it("through the gateway, an upload naming the token's lease after `simlock release --all` reaches that lease's worker", async () => {
    const rig = await twoLeasesOnTwoWorkers();
    const target = holderOf(rig, 2);
    await rig.gateway.dispatch("lease.release-all", {}, adminSession);
    await expect.poll(async () => (await fleetLeases(rig)).length).toBe(0);
    const before = pathsReceived(target).filter((path) => path === "/upload/preflight").length;

    const preflight = await send(rig, "/upload/preflight", { body: "{}", headers: leased(2) });

    expect(await preflight.text()).not.toContain(notYoursOnGateway(2));
    expect(pathsReceived(target).filter((path) => path === "/upload/preflight").length).toBe(
      before + 1,
    );
  });

  it("through the gateway, `devices` with no lease held answers an empty list and no agent-device daemon receives it", async () => {
    const rig = await setUp({ workers: [{ label: "w1" }, { label: "w2" }] });
    for (const member of rig.members) member.fake.listDevices([{ id: "stray", name: "stray" }]);

    const answer = await envelopeOf(await command(rig, "devices", undefined));

    expect(answer.result).toMatchObject({ data: { devices: [] }, ok: true });
    for (const member of rig.members) {
      expect(member.fake.rpcRequests("agent_device.command")).toEqual([]);
    }
  });

  it("through the gateway, `devices` with leases on W1 and W2 answers both devices, each once, and no device of another token", async () => {
    const rig = await twoLeasesOnTwoWorkers();
    for (const [index, n] of [1, 2].entries()) {
      holderOf(rig, n).fake.listDevices([
        { id: addressOfLease(rig, n), name: `mine-${String(index)}` },
        { id: "another-token-device", name: "foreign" },
      ]);
    }

    expect(await listedNames(await command(rig, "devices", undefined))).toEqual([
      "mine-0",
      "mine-1",
    ]);
  });

  it("through the gateway, `devices` with leases on W1 and W2 whose emulators are both `emulator-5554` answers both, each from its own worker", async () => {
    const rig = await twoLeasesOnTwoWorkers();
    expect(addressOfLease(rig, 1)).toBe(addressOfLease(rig, 2));
    holderOf(rig, 1).fake.listDevices([{ id: addressOfLease(rig, 1), name: "from-first" }]);
    holderOf(rig, 2).fake.listDevices([{ id: addressOfLease(rig, 2), name: "from-second" }]);

    expect(await listedNames(await command(rig, "devices", undefined))).toEqual([
      "from-first",
      "from-second",
    ]);
  });

  it("through the gateway, `devices` with two leases on one worker answers both devices, each once", async () => {
    const rig = await setUp({ workers: [{ label: "w1", maxRunning: 2 }] });
    await grantedOnGateway(rig, 1);
    await grantedOnGateway(rig, 2);
    await listedByGateway(rig, 2);
    const member = first(rig);
    member.fake.listDevices([
      { id: addressOfLease(rig, 1), name: "first" },
      { id: addressOfLease(rig, 2), name: "second" },
      { id: "another-token-device", name: "foreign" },
    ]);

    expect(await listedNames(await command(rig, "devices", undefined))).toEqual([
      "first",
      "second",
    ]);
  });

  it("through the gateway, `devices` with two leases on one worker, sent with a `meta.requestId` as the agent-device CLI does, answers both devices", async () => {
    const rig = await setUp({ workers: [{ label: "w1", maxRunning: 2 }] });
    await grantedOnGateway(rig, 1);
    await grantedOnGateway(rig, 2);
    await listedByGateway(rig, 2);
    const member = first(rig);
    member.fake.listDevices([
      { id: addressOfLease(rig, 1), name: "first" },
      { id: addressOfLease(rig, 2), name: "second" },
    ]);
    member.fake.holdCommand();
    const answer = track(
      command(rig, "devices", undefined, {}, { meta: { requestId: "req-devices-1" } }),
    );
    await expect.poll(() => member.fake.rpcRequests("agent_device.command").length).toBe(2);
    member.fake.releaseCommand();

    expect(await listedNames(await answer.promise)).toEqual(["first", "second"]);
  });

  it("through the gateway, `devices` leaves out a lease that was released, and a lease the gateway's `lease.list` omits from that one answer while still holding it", async () => {
    const rig = await setUp({ workers: [{ label: "w1", maxRunning: 3 }] });
    for (const n of [1, 2, 3]) await grantedOnGateway(rig, n);
    await listedByGateway(rig, 3);
    first(rig).fake.listDevices(
      [1, 2, 3].map((n) => ({ id: addressOfLease(rig, n), name: `lease-${String(n)}` })),
    );
    expect((await envelopeOf(await release(rig, 1))).result).toMatchObject({ ok: true });
    const listing = leaveOutOfNextListing(rig.gateway, hex(2));

    expect(await listedNames(await command(rig, "devices", undefined))).toEqual(["lease-3"]);
    expect(listing.cut()).toBe(1);
    expect(await listedNames(await command(rig, "devices", undefined))).toEqual([
      "lease-2",
      "lease-3",
    ]);
  });

  it("through the gateway, `devices` after `simlock release --all` on the gateway leaves the ended lease out and ends it for the front, so the next heartbeat answers the ended-by-simlock reply without reaching the worker", async () => {
    const rig = await setUp({ workers: [{ label: "w1", maxRunning: 2 }] });
    await grantedOnGateway(rig, 1);
    await listedByGateway(rig, 1);
    first(rig).fake.listDevices([{ id: addressOfLease(rig, 1), name: "lease-1" }]);
    await rig.gateway.dispatch("lease.release-all", {}, adminSession);

    expect(await listedNames(await command(rig, "devices", undefined))).toEqual([]);
    const received = heartbeatsReceived(first(rig));
    expectEndedBySimlock(await envelopeOf(await heartbeat(rig, 1)));
    expect(heartbeatsReceived(first(rig))).toBe(received);
  });

  it("through the gateway, `devices` when W2's agent-device answers an error passes that error on", async () => {
    const rig = await twoLeasesOnTwoWorkers();
    holderOf(rig, 1).fake.listDevices([{ id: addressOfLease(rig, 1), name: "first" }]);
    const second = holderOf(rig, 2).fake;
    second.answerDevicesWith(
      JSON.stringify({
        error: {
          code: -32000,
          data: { code: "COMMAND_FAILED", message: "inventory down" },
          message: "inventory down",
        },
        id: 1,
        jsonrpc: "2.0",
      }),
    );

    const failed = await envelopeOf(await command(rig, "devices", undefined));

    expect(failed.error?.message).toBe("inventory down");
  });

  it("through the gateway, `devices` whose lease check fails answers `could not check your leases; try again`, not an empty list, and no daemon receives the command", async () => {
    const rig = await twoLeasesOnTwoWorkers();
    for (const n of [1, 2]) {
      holderOf(rig, n).fake.listDevices([
        { id: addressOfLease(rig, n), name: `mine-${String(n)}` },
      ]);
    }
    const tap = tapDispatch(rig.gateway);
    tap.rejectNext("lease.list");
    const before = rig.members.map(
      (member) => member.fake.rpcRequests("agent_device.command").length,
    );

    const answer = await envelopeOf(await command(rig, "devices", undefined));

    expect(answer.error?.data).toMatchObject({
      details: { reason: "SIMLOCK_FAILED" },
      retriable: true,
    });
    expect(answer.error?.message).toBe("could not check your leases; try again");
    expect(
      rig.members.map((member) => member.fake.rpcRequests("agent_device.command").length),
    ).toEqual(before);
  });

  it("through the gateway, `devices` when W2 answers a body with no list aborts the forward still waiting on W1", async () => {
    const rig = await twoLeasesOnTwoWorkers();
    const slow = holderOf(rig, 1).fake;
    slow.holdCommand();
    holderOf(rig, 2).fake.answerDevicesWith(
      JSON.stringify({ id: 1, jsonrpc: "2.0", result: { data: {}, ok: true } }),
    );

    const answer = await command(rig, "devices", undefined);

    expect(answer.status).toBe(502);
    expect((await envelopeOf(answer)).error?.message).toBe(
      `could not read the device list from the worker holding lease ${hex(2)}`,
    );
    await expect.poll(() => slow.abortedCommands).toEqual(["devices"]);
  });

  it("through the gateway, a CLI that hangs up during `devices` aborts every forward", async () => {
    const rig = await twoLeasesOnTwoWorkers();
    for (const member of rig.members) member.fake.holdCommand();
    const hangUp = new AbortController();
    const held = track(command(rig, "devices", undefined, { signal: hangUp.signal }));
    // why: the default 1 s poll is shorter than a loaded Windows runner needs to relay a call to two workers and back.
    await expect
      .poll(
        () => rig.members.map((member) => member.fake.rpcRequests("agent_device.command").length),
        { timeout: 10_000 },
      )
      .toEqual([1, 1]);

    hangUp.abort();
    await held.promise.catch(() => undefined);

    await expect
      .poll(() => rig.members.map((member) => member.fake.abortedCommands), { timeout: 10_000 })
      .toEqual([["devices"], ["devices"]]);
  });

  it("through the gateway, `release_materialized_paths` and an `install_from_source` naming the token's lease are refused `refused: unknown method <method>`, and no worker sees either", async () => {
    const rig = await twoLeasesOnTwoWorkers();
    const before = rig.members.map((member) => member.fake.requests.length);

    const released = await envelopeOf(
      await rpc(rig, "agent_device.release_materialized_paths", {
        materializationId: "m-1",
      }),
    );
    const installed = await envelopeOf(
      await rpc(rig, "agent_device.install_from_source", {
        meta: { leaseId: hex(2) },
        platform: "ios",
        source: { kind: "url", url: "https://example.com/App.zip" },
      }),
    );

    expect(released.error?.message).toBe(
      "refused: unknown method agent_device.release_materialized_paths",
    );
    expect(installed.error?.message).toBe(
      "refused: unknown method agent_device.install_from_source",
    );
    expect(rig.members.map((member) => member.fake.requests.length)).toEqual(before);
  });
});
