import { describe, expect, it } from "vitest";

import {
  READY_TWO,
  firstPayload,
  leaseDetached,
  named,
  payloadsOf,
  physicalLeaseArgs,
  presenceReadTimes,
  queuedAtFirst,
  rowInState,
  rowOf,
  rowWhere,
  setPresence,
  startPresence,
  statusJson,
  until,
  type Grant,
} from "./helpers/physical-presence.js";
import { READY, observeFor } from "./helpers/physical-state.js";

describe("a physical device that is gone for the grace period becomes absent and status says why", () => {
  it("a ready physical device scripted not present for health.stableObservations reads becomes absent and emits device.absence-detected with previousState ready and absentReason not-present", async () => {
    const env = await startPresence([{ script: { present: false }, seed: READY }]);

    const row = await rowInState(env, READY.id, "absent");

    expect(row?.state).toBe("absent");
    expect(row?.absentReason).toBe("not-present");
    expect(await firstPayload(env, "device.absence-detected")).toEqual({
      absentReason: "not-present",
      deviceId: READY.id,
      previousState: "ready",
    });
    expect((await presenceReadTimes(env, READY.driverDeviceId)).length).toBeGreaterThanOrEqual(2);
  });

  it("a device scripted not present with reason locked, and one with untrusted, show absentReason locked and untrusted in status --json, and simlock status prints absent (locked)", async () => {
    const env = await startPresence([
      { script: { absentReason: "locked", present: false }, seed: READY },
      { script: { absentReason: "untrusted", present: false }, seed: READY_TWO },
    ]);

    const locked = await rowInState(env, READY.id, "absent");
    const untrusted = await rowInState(env, READY_TWO.id, "absent");

    expect(locked?.state).toBe("absent");
    expect(untrusted?.state).toBe("absent");
    expect(locked?.absentReason).toBe("locked");
    expect(untrusted?.absentReason).toBe("untrusted");
    const text = await env.cli(["status"]);
    expect(text.code, text.stderr).toBe(0);
    expect(text.stdout).toMatch(
      new RegExp(`^Device ${READY.id}\\b.*: absent \\(locked\\), physical`, "m"),
    );
    expect(text.stdout).toMatch(
      new RegExp(`^Device ${READY_TWO.id}\\b.*: absent \\(untrusted\\), physical`, "m"),
    );
  });

  it("an absent device that is reclaimed back to ready has no absentReason in status --json", async () => {
    const env = await startPresence([
      { script: { absentReason: "locked", present: false }, seed: READY },
    ]);
    const absent = await rowInState(env, READY.id, "absent");
    expect(absent?.absentReason, "the absent device says why").toBe("locked");

    await setPresence(env, READY, { present: true });

    const ready = await rowInState(env, READY.id, "ready");
    expect(ready?.state).toBe("ready");
    expect(ready).not.toHaveProperty("absentReason");
    const raw = await env.cli(["status", "--json"]);
    expect(raw.stdout).not.toContain("absentReason");
  });

  it("an absent device whose reason changes from locked to not-present shows not-present in status --json on the next read, and emits no second device.absence-detected", async () => {
    const env = await startPresence([
      { script: { absentReason: "locked", present: false }, seed: READY },
    ]);
    const first = await rowInState(env, READY.id, "absent");
    expect(first?.absentReason).toBe("locked");

    await setPresence(env, READY, { absentReason: "not-present", present: false });

    const changed = await rowWhere(env, READY.id, (row) => row?.absentReason === "not-present");
    expect(changed?.state).toBe("absent");
    expect(changed?.absentReason).toBe("not-present");
    await observeFor(800, async () => {
      expect(await payloadsOf(env, "device.absence-detected")).toHaveLength(1);
    });
  });
});

describe("a leased physical device that is gone for the grace period loses its lease", () => {
  it("a leased physical device scripted not present for the grace period ends its lease: the holder gets lease-lost with reason device-lost, status shows the device absent with no lease, and the events are lease.released (device-lost) then device.absence-detected (previousState leased)", async () => {
    const env = await startPresence([{ seed: READY }]);
    const held = env.cliBackground(physicalLeaseArgs("holder"));
    const grant = JSON.parse(await held.firstStdoutLine(15_000)) as Grant;
    expect(grant.device.id).toBe(READY.id);

    await setPresence(env, READY, { present: false });

    const row = await rowInState(env, READY.id, "absent");
    expect(row?.state).toBe("absent");
    const pushes = await until(
      async () => held.progressEvents().filter((event) => isPush(event, "lease-lost")),
      (list) => list.length > 0,
      5_000,
    );
    expect(pushes[0]).toMatchObject({
      deviceId: READY.id,
      leaseId: grant.lease.id,
      reason: "device-lost",
    });
    expect((await held.waitForExit(5_000)).code).toBe(14);
    expect((await statusJson(env)).leases).toEqual([]);
    const events = await named(env, "lease.released", "device.absence-detected");
    expect(events.map((entry) => entry.event)).toEqual([
      "lease.released",
      "device.absence-detected",
    ]);
    expect(events[0]?.payload).toMatchObject({ leaseId: grant.lease.id, reason: "device-lost" });
    expect(events[1]?.payload).toMatchObject({ deviceId: READY.id, previousState: "leased" });
  });

  it("a leased physical device not present for one read fewer than health.stableObservations keeps its lease and its state", async () => {
    const env = await startPresence([{ seed: READY }], {
      health: { probeIntervalMs: 1_000, stableObservations: 3 },
    });
    const grant = await leaseDetached(env);
    expect(grant.device.id).toBe(READY.id);

    await setPresence(env, READY, { present: false });
    const flippedAt = Date.now();
    const reads = await until(
      async () =>
        (await presenceReadTimes(env, READY.driverDeviceId)).filter((time) => time > flippedAt),
      (times) => times.length >= 2,
      10_000,
    );
    expect(reads.length, "two not-present reads happened").toBeGreaterThanOrEqual(2);
    await setPresence(env, READY, { present: true });

    await observeFor(2_500, async () => {
      const row = await rowOf(env, READY.id);
      expect(row?.state).toBe("leased");
      expect((await statusJson(env)).leases).toHaveLength(1);
    });
    expect(await named(env, "lease.released", "device.absence-detected")).toEqual([]);
  });
});

describe("an absent physical device that is back is reclaimed and leasable again", () => {
  it("an absent device scripted present again emits device.returned, then device.reclaimed with strategy uninstall, becomes ready, and a physical request is granted it", async () => {
    const env = await startPresence([{ script: { present: false }, seed: READY }]);
    const absent = await rowInState(env, READY.id, "absent");
    expect(absent?.state).toBe("absent");

    await setPresence(env, READY, { present: true });

    const ready = await rowInState(env, READY.id, "ready");
    expect(ready?.state).toBe("ready");
    const events = await named(env, "device.returned", "device.reclaimed");
    expect(events.map((entry) => entry.event)).toEqual(["device.returned", "device.reclaimed"]);
    expect(events[1]?.payload).toMatchObject({ deviceId: READY.id, strategy: "uninstall" });
    const grant = await leaseDetached(env);
    expect(grant.device.id).toBe(READY.id);
  });

  it("an absent device that comes back on another OS version shows the new osVersion in status, and device.returned carries it", async () => {
    const env = await startPresence([{ script: { present: false }, seed: READY }]);
    const absent = await rowInState(env, READY.id, "absent");
    expect(absent?.state).toBe("absent");

    await setPresence(env, READY, { osVersion: "18.5", present: true });

    const ready = await rowInState(env, READY.id, "ready");
    expect(ready?.spec.osVersion).toBe("18.5");
    expect(await firstPayload(env, "device.returned")).toEqual({
      deviceId: READY.id,
      osVersion: "18.5",
    });
  });

  it("a physical request whose only match is absent is queued, and is granted once the device is back and reclaimed", async () => {
    const env = await startPresence([{ script: { present: false }, seed: READY }]);
    const absent = await rowInState(env, READY.id, "absent");
    expect(absent?.state).toBe("absent");

    const waiter = env.cliBackground(physicalLeaseArgs("waiting-agent"));
    expect(await queuedAtFirst(waiter), "the request is queued, not refused").toBe(true);
    await setPresence(env, READY, { present: true });

    const grant = JSON.parse(await waiter.firstStdoutLine(30_000)) as Grant;
    expect(grant.device.id).toBe(READY.id);
    const events = await named(env, "device.returned", "device.reclaimed", "lease.granted");
    expect(events.map((entry) => entry.event)).toEqual([
      "device.returned",
      "device.reclaimed",
      "lease.granted",
    ]);
  });
});

describe("the watcher runs whatever health.enabled says", () => {
  it("with health.enabled: false, a leased physical device scripted not present still ends its lease device-lost and becomes absent; scripted present again, it emits device.returned, then device.reclaimed, and becomes ready", async () => {
    const env = await startPresence([{ seed: READY }], { health: { enabled: false } });
    const grant = await leaseDetached(env);

    await setPresence(env, READY, { present: false });

    const absent = await rowInState(env, READY.id, "absent");
    expect(absent?.state).toBe("absent");
    const released = await named(env, "lease.released");
    expect(released.map((entry) => entry.payload)).toEqual([
      expect.objectContaining({ leaseId: grant.lease.id, reason: "device-lost" }),
    ]);
    await setPresence(env, READY, { present: true });
    const ready = await rowInState(env, READY.id, "ready");
    expect(ready?.state).toBe("ready");
    const events = await named(env, "device.returned", "device.reclaimed");
    expect(events.map((entry) => entry.event)).toEqual(["device.returned", "device.reclaimed"]);
  });
});

function isPush(event: unknown, push: string): boolean {
  return (event as { push?: string }).push === push;
}
