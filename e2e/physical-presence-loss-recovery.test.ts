import { existsSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { waitFor } from "./helpers/index.js";
import {
  ABSENT,
  AGENT_APPS,
  ENROLLED,
  QUARANTINED,
  callsOn,
  changingCallsOn,
  firstPayload,
  named,
  payloadsOf,
  physicalLeaseArgs,
  physicalRecords,
  presenceReadTimes,
  queuedAtFirst,
  rowInState,
  rowOf,
  rowWhere,
  setIosScript,
  setPresence,
  startPresence,
  statusJson,
  uninstallsOf,
  until,
} from "./helpers/physical-presence.js";
import { HELD_LEASE, LEASED, READY, RECLAIMING, observeFor } from "./helpers/physical-state.js";

const SLOW_RETRY = { warmPool: { quarantine: { retryBackoffMs: 60_000 } } };
const INSTALLED = [...ENROLLED, ...AGENT_APPS];

async function releaseHeld(env: Awaited<ReturnType<typeof startPresence>>): Promise<void> {
  const released = await env.cli(["release", "lse_pheld"]);
  expect(released.code, released.stderr).toBe(0);
}

describe("a physical reclaim that fails while the device is gone makes it absent", () => {
  it("a released physical device whose reclaim fails while it is scripted not present becomes absent with the scripted reason, with no device.quarantined and no device.purge-failed, and is reclaimed once present", async () => {
    const env = await startPresence(
      [
        {
          script: { absentReason: "untrusted", installed: INSTALLED, present: false },
          seed: LEASED,
        },
      ],
      {
        config: SLOW_RETRY,
        failReclaim: true,
        health: { probeIntervalMs: 1_000 },
        leases: [HELD_LEASE(600_000)],
      },
    );
    await releaseHeld(env);

    const row = await rowInState(env, LEASED.id, "absent");

    expect(row?.state).toBe("absent");
    expect(row?.absentReason).toBe("untrusted");
    expect(await named(env, "device.quarantined", "device.purge-failed")).toEqual([]);
    expect(await firstPayload(env, "device.absence-detected")).toMatchObject({
      absentReason: "untrusted",
      deviceId: LEASED.id,
      previousState: "reclaiming",
    });
    await setPresence(env, LEASED, { installed: INSTALLED, present: true });
    const ready = await rowInState(env, LEASED.id, "ready", 15_000);
    expect(ready?.state).toBe("ready");
    expect((await named(env, "device.reclaimed")).length).toBe(1);
  });

  it("a released physical device whose reclaim fails while it is present is still quarantined", async () => {
    const env = await startPresence(
      [{ script: { installed: INSTALLED, present: true }, seed: LEASED }],
      { config: SLOW_RETRY, failReclaim: true, leases: [HELD_LEASE(600_000)] },
    );
    await releaseHeld(env);

    const row = await rowInState(env, LEASED.id, "quarantined");

    expect(row?.state).toBe("quarantined");
    expect(await payloadsOf(env, "device.purge-failed")).toContainEqual(
      expect.objectContaining({ attemptedStrategy: "uninstall", deviceId: LEASED.id }),
    );
    expect(await payloadsOf(env, "device.quarantined")).toContainEqual(
      expect.objectContaining({ deviceId: LEASED.id }),
    );
    expect(await named(env, "device.absence-detected")).toEqual([]);
  });
});

describe("a quarantined physical device that is gone keeps its retries until it is back", () => {
  it("a quarantined physical device scripted not present keeps its quarantineAttempts past several retry due times, and the fake driver log shows no reclaim call for it; status --json shows a quarantineNextRetryAt later than the first due time it passed; once present, the retry runs", async () => {
    const firstDue = Date.now() + 1_500;
    const env = await startPresence(
      [
        {
          script: { installed: INSTALLED, present: false },
          seed: { ...QUARANTINED, quarantineNextRetryAt: firstDue },
        },
      ],
      { health: { probeIntervalMs: 300 } },
    );

    await waitFor(() => Date.now() > firstDue + 1_500, { label: "several retry due times pass" });

    const row = await rowOf(env, QUARANTINED.id);
    expect(row?.state).toBe("quarantined");
    expect(row?.quarantineAttempts).toBe(1);
    expect(row?.quarantineNextRetryAt).toBeGreaterThan(firstDue);
    expect(await changingCallsOn(env, QUARANTINED.driverDeviceId)).toEqual([]);
    await setPresence(env, QUARANTINED, { installed: INSTALLED, present: true });
    const recovered = await rowInState(env, QUARANTINED.id, "ready", 15_000);
    expect(recovered?.state).toBe("ready");
    expect(await changingCallsOn(env, QUARANTINED.driverDeviceId)).toContain("reclaim");
  });
});

describe("a daemon restart alone never ends a physical lease", () => {
  it("a daemon restarted with a leased physical device present keeps the lease, and a renew succeeds", async () => {
    const env = await startPresence([{ script: { present: true }, seed: LEASED }], {
      leases: [HELD_LEASE(600_000)],
    });
    await env.restartDaemon();

    const reads = await until(
      () => presenceReadTimes(env, LEASED.driverDeviceId),
      (times) => times.length >= 3,
    );
    expect(reads.length, "the new daemon reads it present").toBeGreaterThanOrEqual(3);
    expect((await rowOf(env, LEASED.id))?.state).toBe("leased");
    const renewed = await env.cli(["lease", "renew", "lse_pheld"]);
    expect(renewed.code, renewed.stderr).toBe(0);
    expect((await rowOf(env, LEASED.id))?.state).toBe("leased");
    expect(await named(env, "lease.released", "device.absence-detected")).toEqual([]);
  });

  it("a daemon restarted with a leased physical device not present keeps the lease until the new daemon has read it not present health.stableObservations times, then ends it device-lost", async () => {
    const env = await startPresence([{ script: { present: true }, seed: LEASED }], {
      health: { probeIntervalMs: 500, stableObservations: 3 },
      leases: [HELD_LEASE(600_000)],
    });
    expect((await env.cli(["daemon", "stop"])).code).toBe(0);
    await waitFor(() => !existsSync(env.socketPath), { label: "daemon socket removed" });
    await setPresence(env, LEASED, { present: false });
    await env.driverLog.clear();
    const started = await env.startDaemon();
    expect(started.code, started.stderr).toBe(0);

    expect((await rowOf(env, LEASED.id))?.state, "the lease is kept at start").toBe("leased");
    const lost = await until(
      () => payloadsOf(env, "device.absence-detected"),
      (list) => list.length > 0,
    );

    expect(lost[0]).toMatchObject({ deviceId: LEASED.id, previousState: "leased" });
    expect(await payloadsOf(env, "lease.released")).toEqual([
      expect.objectContaining({ leaseId: "lse_pheld", reason: "device-lost" }),
    ]);
    const absenceAt = (await named(env, "device.absence-detected"))[0]?.timestamp ?? 0;
    const readsBefore = (await presenceReadTimes(env, LEASED.driverDeviceId)).filter(
      (time) => time <= absenceAt,
    );
    expect(readsBefore.length).toBeGreaterThanOrEqual(3);
  });

  it("a daemon restarted with an absent and a quarantined physical device in state.db keeps both states while they are not present", async () => {
    const env = await startPresence(
      [
        {
          script: { installed: INSTALLED, present: false },
          seed: { ...ABSENT, absentReason: "untrusted" },
        },
        { script: { installed: INSTALLED, present: false }, seed: QUARANTINED },
      ],
      { health: { probeIntervalMs: 200 } },
    );

    for (const restart of [false, true]) {
      if (restart) await env.restartDaemon();
      const reads = await until(
        () => presenceReadTimes(env, ABSENT.driverDeviceId),
        (times) => times.length >= 2,
      );
      expect(reads.length, "the watcher reads the absent device").toBeGreaterThanOrEqual(2);
      await observeFor(600, async () => {
        expect((await rowOf(env, ABSENT.id))?.state).toBe("absent");
        const quarantined = await rowOf(env, QUARANTINED.id);
        expect(quarantined?.state).toBe("quarantined");
        expect(quarantined?.quarantineAttempts).toBe(1);
      });
      expect(await changingCallsOn(env, QUARANTINED.driverDeviceId)).toEqual([]);
      expect(await changingCallsOn(env, ABSENT.driverDeviceId)).toEqual([]);
    }
  });

  it("a physical device left reclaiming in state.db stays reclaiming while not present, and is reclaimed to ready once present", async () => {
    const env = await startPresence(
      [{ script: { installed: INSTALLED, present: false }, seed: RECLAIMING }],
      { config: SLOW_RETRY },
    );
    const reads = await until(
      () => presenceReadTimes(env, RECLAIMING.driverDeviceId),
      (times) => times.length >= 2,
    );
    expect(reads.length, "the watcher reads it").toBeGreaterThanOrEqual(2);

    await observeFor(600, async () => {
      expect((await rowOf(env, RECLAIMING.id))?.state).toBe("reclaiming");
    });
    expect(await changingCallsOn(env, RECLAIMING.driverDeviceId)).toEqual([]);
    await setPresence(env, RECLAIMING, { installed: INSTALLED, present: true });

    const ready = await rowInState(env, RECLAIMING.id, "ready", 15_000);
    expect(ready?.state).toBe("ready");
    expect(await uninstallsOf(env)).toEqual([
      [RECLAIMING.driverDeviceId, "com.agent.one"],
      [RECLAIMING.driverDeviceId, "com.agent.two"],
    ]);
  });
});

describe("device add and device remove work on an absent device", () => {
  const NEW_APPS = ["com.new.one", "com.new.two"];

  it("device add of an absent device re-records its apps and makes it ready with no absentReason; the device is scripted inspectable but not present, so the watcher never reads it present and never takes its claim", async () => {
    const env = await startPresence(
      [
        {
          script: { apps: NEW_APPS, present: false },
          seed: { ...ABSENT, enrolledApps: ["com.old.app"] },
        },
      ],
      { health: { probeIntervalMs: 3_000 } },
    );

    const added = await env.cli(["device", "add", "--platform", "ios", ABSENT.driverDeviceId]);

    expect(added.code, added.stderr).toBe(0);
    const row = await rowOf(env, ABSENT.id);
    expect(row?.state).toBe("ready");
    expect(row).not.toHaveProperty("absentReason");
    const records = await until(
      () => physicalRecords(env),
      (list) => list.some((record) => record["id"] === ABSENT.id && record["state"] === "ready"),
    );
    const record = records.find((candidate) => candidate["id"] === ABSENT.id);
    expect(record?.["enrolledApps"]).toEqual(NEW_APPS);
    expect(record).not.toHaveProperty("absentReason");
    expect(await named(env, "device.returned")).toEqual([]);
    expect(await changingCallsOn(env, ABSENT.driverDeviceId)).toEqual([]);
    expect((await callsOn(env, ABSENT.driverDeviceId)).map((call) => call.operation)).toContain(
      "inspectPhysical",
    );
  });

  it("device add of an absent device that is not connected is refused as not connected, and the device stays absent", async () => {
    const env = await startPresence([{ script: { connected: false }, seed: ABSENT }], {
      health: { probeIntervalMs: 3_000 },
    });
    expect((await rowOf(env, ABSENT.id))?.state, "the record loads absent").toBe("absent");

    const added = await env.cli(["device", "add", "--platform", "ios", ABSENT.driverDeviceId]);

    expect(added.code, added.stderr).toBe(12);
    expect(added.error?.code).toBe("DEVICE_NOT_ENROLLABLE");
    expect(added.error?.message).toContain("not connected");
    expect((await rowOf(env, ABSENT.id))?.state).toBe("absent");
  });

  it("device remove of an absent device makes it deleted with device.deleted initiator operator, and a queued physical request whose last match it was fails with UNKNOWN_MODEL", async () => {
    const env = await startPresence([{ script: { present: false }, seed: ABSENT }], {
      health: { probeIntervalMs: 3_000 },
    });
    const waiter = env.cliBackground(physicalLeaseArgs("queued-agent"));
    expect(await queuedAtFirst(waiter), "the request is queued on the absent device").toBe(true);

    const removed = await env.cli(["device", "remove", ABSENT.driverDeviceId]);

    expect(removed.code, removed.stderr).toBe(0);
    const row = await rowWhere(env, ABSENT.id, (candidate) => candidate?.state !== "absent");
    expect(["deleted", undefined]).toContain(row?.state);
    expect(await firstPayload(env, "device.deleted")).toMatchObject({
      deviceId: ABSENT.id,
      initiator: "operator",
      physical: true,
    });
    const ended = await waiter.waitForExit(15_000);
    expect(ended.code, ended.stderr).toBe(12);
    expect(ended.error?.code).toBe("UNKNOWN_MODEL");
  });
});

describe("the watcher asks the driver only what it needs", () => {
  it("with no physical device enrolled, the fake driver log shows no listPresentPhysical call across several probe intervals", async () => {
    const env = await startPresence([]);
    await observeFor(600, async () => {
      const operations = (await env.driverLog.calls()).map((call) => call.operation);
      expect(operations).not.toContain("listPresentPhysical");
    });

    await setIosScript(env, [{ seed: READY }]);
    const added = await env.cli(["device", "add", "--platform", "ios", READY.driverDeviceId]);
    expect(added.code, added.stderr).toBe(0);

    const reads = await until(
      () => presenceReadTimes(env, READY.driverDeviceId),
      (times) => times.length > 0,
      5_000,
    );
    expect(reads.length, "an enrolled device is read").toBeGreaterThan(0);
  });

  it("across several probe intervals with a leased physical device present, the fake driver log names it only in listPresentPhysical calls", async () => {
    const env = await startPresence([{ script: { present: true }, seed: LEASED }], {
      leases: [HELD_LEASE(600_000)],
    });

    const reads = await until(
      () => presenceReadTimes(env, LEASED.driverDeviceId),
      (times) => times.length >= 4,
    );

    expect(reads.length, "the watcher reads it every interval").toBeGreaterThanOrEqual(4);
    const operations = (await callsOn(env, LEASED.driverDeviceId)).map((call) => call.operation);
    expect([...new Set(operations)]).toEqual(["listPresentPhysical"]);
    expect((await statusJson(env)).devices.find((row) => row.id === LEASED.id)?.state).toBe(
      "leased",
    );
  });
});
