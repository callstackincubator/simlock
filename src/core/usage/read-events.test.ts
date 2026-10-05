import { describe, expect, it } from "vitest";

import type { EventEnvelope } from "../../bus/index.js";
import { readEvents, type ReadOptions } from "./read-events.js";

const WINDOW = { from: 100, to: 200 };
const WORKER: ReadOptions = {
  fleet: false,
  requestedBefore: new Set(),
  requesterPrefix: "",
  self: "self",
};
const FLEET: ReadOptions = {
  fleet: true,
  requestedBefore: new Set(),
  requesterPrefix: "gw:",
  self: "gateway",
};

let sequence = 0;

function at(timestamp: number, event: string, payload: Record<string, unknown>): EventEnvelope {
  sequence += 1;
  return {
    event,
    id: `evt_${sequence}`,
    module: "test",
    payload,
    seq: sequence,
    timestamp,
  } as unknown as EventEnvelope;
}

const read = (events: EventEnvelope[], options: ReadOptions = WORKER) =>
  readEvents(events, WINDOW, options);

const entry = (running: number, reserved: number, maxRunning: number) => ({
  maxRunning,
  reserved,
  running,
});
const capacityPayload = (extra: Record<string, unknown> = {}) => ({
  android: entry(0, 0, 2),
  global: entry(1, 2, 5),
  ios: entry(1, 0, 3),
  ...extra,
});
const request = (ts: number, requestId: string, requester = "a", extra = {}) =>
  at(ts, "lease.requested", { requestId, requestSpec: { platform: "ios" }, requester, ...extra });
const dispatch = (ts: number, requestId: string, requesterId = "a", workerId = "w1") =>
  at(ts, "request.dispatched", { requestId, requesterId, workerId });
const relayedGrant = (ts: number, extra: Record<string, unknown> = {}) =>
  at(ts, "lease.granted", {
    leaseId: "L",
    requester: "gw:a",
    source: "warm",
    workerId: "w1",
    ...extra,
  });
const relayedReject = (ts: number, extra: Record<string, unknown> = {}) =>
  at(ts, "lease.rejected", {
    reason: "no-capacity",
    requester: "gw:a",
    requestId: "r",
    workerId: "w1",
    ...extra,
  });

describe("payload guards", () => {
  it("ignores a deviceId, spec platform and duration of the wrong types when provisioning", () => {
    const result = read([
      at(150, "device.provisioned", { deviceId: 5, duration: "12", spec: { platform: "ios" } }),
      at(151, "device.provisioned", { duration: Number.NaN, spec: { platform: "ios" } }),
      at(152, "device.provisioned", { duration: Infinity, spec: { platform: "ios" } }),
      at(153, "device.provisioned", { duration: -Infinity, spec: { platform: "ios" } }),
      at(154, "device.provisioned", { duration: 7, spec: ["ios"] }),
      at(155, "device.provisioned", { duration: 8, spec: null }),
      at(156, "device.provisioned", { duration: 9, spec: { platform: "windows" } }),
      at(157, "device.provisioned", { duration: 0, spec: { platform: "android" } }),
    ]);
    expect(result.devices).toEqual([
      { kind: "provisioning", platform: undefined, value: 7, worker: "self" },
      { kind: "provisioning", platform: undefined, value: 8, worker: "self" },
      { kind: "provisioning", platform: undefined, value: 9, worker: "self" },
      { kind: "provisioning", platform: "android", value: 0, worker: "self" },
    ]);
  });

  it("does not count a boot whose duration is not a finite number", () => {
    const result = read([
      at(150, "device.ready", { bootDuration: "5", deviceId: "d" }),
      at(151, "device.ready", { bootDuration: Number.NaN, deviceId: "d" }),
      at(152, "device.ready", { bootDuration: Infinity, deviceId: "d" }),
      at(153, "device.ready", { deviceId: "d" }),
      at(154, "device.ready", { bootDuration: 4, deviceId: "d" }),
    ]);
    expect(result.devices).toEqual([
      { kind: "boot", platform: undefined, value: 4, worker: "self" },
    ]);
  });
});

describe("capacity steps", () => {
  const stepFor = (payload: Record<string, unknown>) =>
    read([at(150, "capacity.changed", payload)]).capacity;

  it("turns a complete capacity.changed into a step with used = running + reserved", () => {
    expect(stepFor(capacityPayload())).toEqual([
      {
        at: 150,
        key: "self",
        value: {
          max: 5,
          platforms: {
            android: { max: 2, ram: undefined, used: 0 },
            ios: { max: 3, ram: undefined, used: 1 },
          },
          ram: undefined,
          used: 3,
        },
      },
    ]);
  });

  it.each(["global", "ios", "android"])("ignores a step when %s is missing", (missing) => {
    const payload: Record<string, unknown> = capacityPayload();
    delete payload[missing];
    expect(stepFor(payload)).toEqual([]);
  });

  it.each(["global", "ios", "android"])("ignores a step when %s is not an object", (name) => {
    expect(stepFor(capacityPayload({ [name]: null }))).toEqual([]);
    expect(stepFor(capacityPayload({ [name]: 3 }))).toEqual([]);
  });

  it.each(["running", "reserved", "maxRunning"])(
    "ignores a step when %s is missing in an entry",
    (field) => {
      const bad: Record<string, unknown> = entry(1, 1, 1);
      delete bad[field];
      for (const name of ["global", "ios", "android"]) {
        expect(stepFor(capacityPayload({ [name]: bad }))).toEqual([]);
      }
    },
  );

  it("ignores a step whose entry figure is not a finite number", () => {
    expect(stepFor(capacityPayload({ global: { ...entry(1, 1, 1), running: "1" } }))).toEqual([]);
    expect(
      stepFor(capacityPayload({ global: { ...entry(1, 1, 1), reserved: Number.NaN } })),
    ).toEqual([]);
    expect(
      stepFor(capacityPayload({ global: { ...entry(1, 1, 1), maxRunning: Infinity } })),
    ).toEqual([]);
  });

  it("reads the ram figure from ramBudget and drops it when either side is missing", () => {
    const ramOf = (budget: unknown) => stepFor(capacityPayload({ ramBudget: budget }))[0]?.value;
    expect(ramOf({ limitBytes: 100, usedBytes: 40 })?.ram).toEqual({ limit: 100, used: 40 });
    expect(ramOf({ limitBytes: 100, usedBytes: 40 })?.platforms.ios.ram).toEqual({
      limit: 100,
      used: 40,
    });
    expect(ramOf({ limitBytes: 100 })).toMatchObject({ ram: undefined, used: 3 });
    expect(ramOf({ usedBytes: 40 })).toMatchObject({ ram: undefined, used: 3 });
    expect(ramOf({ limitBytes: "100", usedBytes: 40 })).toMatchObject({ ram: undefined });
    expect(ramOf({ limitBytes: 100, usedBytes: Number.NaN })).toMatchObject({ ram: undefined });
    expect(ramOf(null)).toMatchObject({ ram: undefined });
    expect(ramOf([1])).toMatchObject({ ram: undefined, used: 3 });
  });

  it("keeps a step at exactly the end of the window, ignores one after it", () => {
    const result = read([
      at(200, "capacity.changed", capacityPayload()),
      at(201, "capacity.changed", capacityPayload()),
    ]);
    expect(result.capacity.map((s) => s.at)).toEqual([200]);
  });

  it("keeps a step from before the window start so the opening level is known", () => {
    expect(read([at(50, "capacity.changed", capacityPayload())]).capacity).toHaveLength(1);
  });

  it("keys a relayed step by its worker and records the worker", () => {
    const result = read([at(150, "capacity.changed", capacityPayload({ workerId: "w1" }))], FLEET);
    expect(result.capacity.map((s) => s.key)).toEqual(["w1"]);
    expect([...result.workers]).toEqual(["w1"]);
  });

  it("ignores a gateway capacity.changed with no workerId", () => {
    const result = read([at(150, "capacity.changed", capacityPayload())], FLEET);
    expect(result.capacity).toEqual([]);
    expect([...result.workers]).toEqual([]);
  });

  it("records the worker of a malformed capacity.changed without adding a step", () => {
    const result = read([at(150, "capacity.changed", { workerId: "w1" })], FLEET);
    expect(result.capacity).toEqual([]);
    expect([...result.workers]).toEqual(["w1"]);
  });

  it("records the worker of a worker's own malformed capacity.changed", () => {
    const result = read([at(150, "capacity.changed", {})]);
    expect([...result.workers]).toEqual(["self"]);
  });
});

describe("queue steps", () => {
  it("records a depth at exactly the window end and ignores one after it", () => {
    const result = read([
      at(50, "queue.changed", { depth: 1 }),
      at(200, "queue.changed", { depth: 2 }),
      at(201, "queue.changed", { depth: 3 }),
    ]);
    expect(result.queue).toEqual([
      { at: 50, key: "queue", value: 1 },
      { at: 200, key: "queue", value: 2 },
    ]);
  });

  it("ignores a depth that is not a finite number", () => {
    const result = read([
      at(150, "queue.changed", { depth: "3" }),
      at(151, "queue.changed", { depth: Number.NaN }),
      at(152, "queue.changed", { depth: Infinity }),
      at(153, "queue.changed", {}),
      at(154, "queue.changed", { depth: 0 }),
    ]);
    expect(result.queue).toEqual([{ at: 154, key: "queue", value: 0 }]);
  });

  it("ignores a queue.changed a worker relayed to the gateway", () => {
    const result = read(
      [
        at(150, "queue.changed", { depth: 4, workerId: "w1" }),
        at(151, "queue.changed", { depth: 5 }),
      ],
      FLEET,
    );
    expect(result.queue).toEqual([{ at: 151, key: "queue", value: 5 }]);
  });
});

describe("requests on a worker", () => {
  it("makes no request of an event at exactly the window start and one of an event at its end", () => {
    const result = read([request(100, "r0"), request(200, "r1"), request(201, "r2")]);
    expect(result.requests.map((r) => r.requestedAt)).toEqual([200]);
  });

  it("is not a request when requestId or requester is missing or not a string", () => {
    const result = read([
      at(150, "lease.requested", { requester: "a" }),
      at(151, "lease.requested", { requestId: "r" }),
      at(152, "lease.requested", { requestId: 1, requester: "a" }),
      at(153, "lease.requested", { requestId: "r", requester: 2 }),
      request(154, "ok"),
    ]);
    expect(result.requests).toEqual([
      { platform: "ios", requestedAt: 154, requester: "a", worker: "self" },
    ]);
  });

  it("reads the platform from requestSpec and leaves it undefined otherwise", () => {
    const result = read([
      at(150, "lease.requested", {
        requestId: "a",
        requestSpec: { platform: "android" },
        requester: "x",
      }),
      at(151, "lease.requested", { requestId: "b", requestSpec: ["ios"], requester: "x" }),
      at(152, "lease.requested", { requestId: "c", requestSpec: null, requester: "x" }),
      at(153, "lease.requested", {
        requestId: "d",
        requestSpec: { platform: "tv" },
        requester: "x",
      }),
    ]);
    expect(result.requests.map((r) => r.platform)).toEqual([
      "android",
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("joins a grant with its end by lease id and defaults a missing source to empty", () => {
    const result = read([
      request(110, "r"),
      at(120, "lease.granted", { leaseId: "L", requestId: "r" }),
      at(130, "lease.released", { leaseId: "L" }),
    ]);
    expect(result.requests).toEqual([
      {
        endedAt: 130,
        outcome: { at: 120, kind: "granted", leaseId: "L", source: "" },
        platform: "ios",
        requestedAt: 110,
        requester: "a",
        worker: "self",
      },
    ]);
  });

  it("keeps the source of a grant and joins an expiry as an end", () => {
    const result = read([
      request(110, "r"),
      at(120, "lease.granted", { leaseId: "L", requestId: "r", source: "warm" }),
      at(130, "lease.expired", { leaseId: "L" }),
    ]);
    expect(result.requests[0]).toMatchObject({ endedAt: 130, outcome: { source: "warm" } });
  });

  it("does not join an end of another lease id", () => {
    const result = read([
      request(110, "r"),
      at(120, "lease.granted", { leaseId: "L", requestId: "r" }),
      at(130, "lease.released", { leaseId: "other" }),
    ]);
    expect(result.requests[0]).not.toHaveProperty("endedAt");
  });

  it("ignores a grant missing requestId or leaseId, and one outside the window", () => {
    const result = read([
      request(110, "r"),
      at(120, "lease.granted", { leaseId: "L" }),
      at(121, "lease.granted", { requestId: "r" }),
      at(100, "lease.granted", { leaseId: "L", requestId: "r" }),
      at(201, "lease.granted", { leaseId: "L", requestId: "r" }),
    ]);
    expect(result.requests[0]).not.toHaveProperty("outcome");
  });

  it("takes a grant at exactly the window end", () => {
    const result = read([
      request(110, "r"),
      at(200, "lease.granted", { leaseId: "L", requestId: "r", source: "cold" }),
    ]);
    expect(result.requests[0]?.outcome).toEqual({
      at: 200,
      kind: "granted",
      leaseId: "L",
      source: "cold",
    });
  });

  it("ignores an end with no lease id, and one outside the window", () => {
    const result = read([
      request(110, "r"),
      at(120, "lease.granted", { leaseId: "L", requestId: "r" }),
      at(130, "lease.released", {}),
      at(100, "lease.released", { leaseId: "L" }),
      at(201, "lease.released", { leaseId: "L" }),
    ]);
    expect(result.requests[0]).not.toHaveProperty("endedAt");
  });

  it("takes an end at exactly the window end", () => {
    const result = read([
      request(110, "r"),
      at(120, "lease.granted", { leaseId: "L", requestId: "r" }),
      at(200, "lease.released", { leaseId: "L" }),
    ]);
    expect(result.requests[0]?.endedAt).toBe(200);
  });

  it("outcome of a rejection of a seen request is the rejection with its reason", () => {
    const result = read([
      request(110, "r"),
      at(120, "lease.rejected", { reason: "no-capacity", requestId: "r", requester: "a" }),
    ]);
    expect(result.requests).toEqual([
      {
        outcome: { at: 120, kind: "rejected", reason: "no-capacity" },
        platform: "ios",
        requestedAt: 110,
        requester: "a",
        worker: "self",
      },
    ]);
  });

  it("ignores a rejection missing requestId, reason or requester, or outside the window", () => {
    const result = read([
      request(110, "r"),
      at(120, "lease.rejected", { reason: "killed", requester: "a" }),
      at(121, "lease.rejected", { requestId: "r", requester: "a" }),
      at(122, "lease.rejected", { reason: "killed", requestId: "r" }),
      at(123, "lease.rejected", { reason: 4, requestId: "r", requester: "a" }),
      at(100, "lease.rejected", { reason: "killed", requestId: "r", requester: "a" }),
      at(201, "lease.rejected", { reason: "killed", requestId: "r", requester: "a" }),
    ]);
    expect(result.requests).toHaveLength(1);
    expect(result.requests[0]).not.toHaveProperty("outcome");
  });

  it("takes a rejection at exactly the window end", () => {
    const result = read([
      request(110, "r"),
      at(200, "lease.rejected", { reason: "killed", requestId: "r", requester: "a" }),
    ]);
    expect(result.requests[0]?.outcome).toEqual({ at: 200, kind: "rejected", reason: "killed" });
  });

  it("counts a refused-at-admission rejection of an unseen request, with its platform", () => {
    const result = read([
      at(150, "lease.rejected", {
        reason: "already-leased",
        requestId: "x",
        requestSpec: { platform: "android" },
        requester: "b",
      }),
      at(151, "lease.rejected", { reason: "killed", requestId: "y", requester: "b" }),
      at(152, "lease.rejected", { reason: "no-capacity", requestId: "z", requester: "b" }),
    ]);
    expect(result.requests).toEqual([
      {
        outcome: { at: 150, kind: "rejected", reason: "already-leased" },
        platform: "android",
        requestedAt: undefined,
        requester: "b",
        worker: "self",
      },
      {
        outcome: { at: 151, kind: "rejected", reason: "killed" },
        platform: undefined,
        requestedAt: undefined,
        requester: "b",
        worker: "self",
      },
    ]);
  });

  it("does not double count a refused-at-admission rejection whose request was seen", () => {
    const result = read([
      request(110, "r"),
      at(120, "lease.rejected", { reason: "killed", requestId: "r", requester: "a" }),
    ]);
    expect(result.requests).toHaveLength(1);
  });

  it("counts a killed rejection of a request made before the window in no count, and one made inside it with that request", () => {
    const before = read(
      [at(120, "lease.rejected", { reason: "killed", requestId: "old", requester: "a" })],
      { ...WORKER, requestedBefore: new Set(["old"]) },
    );
    expect(before.requests).toEqual([]);

    const inside = read([
      request(110, "r"),
      at(120, "lease.rejected", { reason: "killed", requestId: "r", requester: "a" }),
    ]);
    expect(inside.requests).toHaveLength(1);
    expect(inside.requests[0]).toMatchObject({ requestedAt: 110 });
  });

  it("an empty payload is read as no facts instead of throwing", () => {
    const envelope = { event: "lease.requested", id: "e", module: "t", seq: 1, timestamp: 150 };
    expect(read([envelope as unknown as EventEnvelope]).requests).toEqual([]);
  });
});

describe("device facts", () => {
  it("counts a provisioning at exactly the window end and not at its start or after", () => {
    const result = read([
      at(100, "device.provisioned", { duration: 1 }),
      at(200, "device.provisioned", { duration: 2 }),
      at(201, "device.provisioned", { duration: 3 }),
    ]);
    expect(result.devices.map((d) => d.value)).toEqual([2]);
  });

  it("takes the boot platform from the earlier provisioning of the same device on the same worker", () => {
    const result = read([
      at(110, "device.provisioned", { deviceId: "d", duration: 1, spec: { platform: "android" } }),
      at(120, "device.ready", { bootDuration: 5, deviceId: "d" }),
      at(121, "device.ready", { bootDuration: 6, deviceId: "other" }),
      at(122, "device.ready", { bootDuration: 7 }),
    ]);
    expect(result.devices.map((d) => [d.kind, d.platform, d.value])).toEqual([
      ["provisioning", "android", 1],
      ["boot", "android", 5],
      ["boot", undefined, 6],
      ["boot", undefined, 7],
    ]);
  });

  it("remembers the platform even when the provisioning is before the window or has no duration", () => {
    const result = read([
      at(50, "device.provisioned", { deviceId: "d", duration: 1, spec: { platform: "ios" } }),
      at(60, "device.provisioned", { deviceId: "e", spec: { platform: "android" } }),
      at(120, "device.ready", { bootDuration: 5, deviceId: "d" }),
      at(121, "device.ready", { bootDuration: 6, deviceId: "e" }),
    ]);
    expect(result.devices.map((d) => d.platform)).toEqual(["ios", "android"]);
  });

  it("does not remember a platform for a provisioning with no device id or no platform", () => {
    const result = read([
      at(110, "device.provisioned", { duration: 1, spec: { platform: "ios" } }),
      at(111, "device.provisioned", { deviceId: "d", duration: 1 }),
      at(120, "device.ready", { bootDuration: 5, deviceId: "d" }),
    ]);
    expect(result.devices.at(-1)).toEqual({
      kind: "boot",
      platform: undefined,
      value: 5,
      worker: "self",
    });
  });

  it("counts each incident event under the name the figure uses, and each error under its event name", () => {
    const names: Record<string, string> = {
      "device.quarantine-abandoned": "lost",
      "device.quarantine-recovered": "quarantineRecovered",
      "device.quarantine-stranded": "lost",
      "device.quarantined": "quarantined",
      "device.recovered": "crashRecovered",
      "device.recovery-failed": "lost",
    };
    const incidents = Object.keys(names).map((name, i) => at(110 + i, name, {}));
    const errors = [at(130, "device.purge-failed", {}), at(131, "component.install-failed", {})];
    const result = read([
      ...incidents,
      ...errors,
      at(132, "device.created", {}),
      at(133, "lease.other", {}),
    ]);
    expect(result.devices.map((d) => [d.kind, d.value])).toEqual([
      ...Object.values(names).map((v) => ["incident", v]),
      ["error", "device.purge-failed"],
      ["error", "component.install-failed"],
    ]);
  });

  it("does not count incidents outside the window", () => {
    const result = read([at(100, "device.quarantined", {}), at(201, "device.quarantined", {})]);
    expect(result.devices).toEqual([]);
  });

  it("takes an incident's platform from its payload, else from the provisioned device", () => {
    const result = read([
      at(110, "device.provisioned", { deviceId: "d", spec: { platform: "android" } }),
      at(120, "device.quarantined", { deviceId: "d", platform: "ios" }),
      at(121, "device.quarantined", { deviceId: "d" }),
      at(122, "device.quarantined", { deviceId: "d", platform: "tv" }),
      at(123, "device.quarantined", {}),
    ]);
    expect(result.devices.map((d) => d.platform)).toEqual(["ios", "android", "android", undefined]);
  });

  it("adds the worker to the workers set from a device fact", () => {
    expect([...read([at(110, "device.quarantined", {})]).workers]).toEqual(["self"]);
  });
});

describe("a gateway", () => {
  it("counts a relayed device fact against its worker and ignores one with no worker", () => {
    const result = read(
      [
        at(110, "device.provisioned", {
          deviceId: "d",
          duration: 1,
          spec: { platform: "ios" },
          workerId: "w1",
        }),
        at(111, "device.provisioned", {
          deviceId: "d",
          duration: 2,
          spec: { platform: "android" },
          workerId: "w2",
        }),
        at(112, "device.provisioned", { deviceId: "d", duration: 3, spec: { platform: "ios" } }),
        at(120, "device.ready", { bootDuration: 5, deviceId: "d", workerId: "w2" }),
        at(121, "device.ready", { bootDuration: 6, deviceId: "d", workerId: "w3" }),
        at(122, "device.ready", { bootDuration: 7, deviceId: "d" }),
        at(123, "device.quarantined", { workerId: "w1" }),
        at(124, "device.quarantined", {}),
      ],
      FLEET,
    );
    expect(result.devices.map((d) => [d.kind, d.worker, d.platform, d.value])).toEqual([
      ["provisioning", "w1", "ios", 1],
      ["provisioning", "w2", "android", 2],
      ["boot", "w2", "android", 5],
      ["boot", "w3", undefined, 6],
      ["incident", "w1", undefined, "quarantined"],
    ]);
    expect([...result.workers].sort()).toEqual(["w1", "w2", "w3"]);
  });

  it("ignores a lease end that no worker relayed", () => {
    const result = read(
      [
        request(110, "r"),
        dispatch(111, "r"),
        relayedGrant(112),
        at(130, "lease.released", { leaseId: "L" }),
      ],
      FLEET,
    );
    expect(result.requests[0]).not.toHaveProperty("endedAt");
  });

  it("joins a relayed grant with the end of the same worker and lease id only", () => {
    const events = (endWorker: string, endLease: string) => [
      request(110, "r"),
      dispatch(111, "r"),
      relayedGrant(112),
      at(130, "lease.released", { leaseId: endLease, workerId: endWorker }),
    ];
    expect(read(events("w1", "L"), FLEET).requests[0]?.endedAt).toBe(130);
    expect(read(events("w2", "L"), FLEET).requests[0]).not.toHaveProperty("endedAt");
    expect(read(events("w1", "M"), FLEET).requests[0]).not.toHaveProperty("endedAt");
  });

  it("gives a request with no dispatch no worker and no outcome, and does not count its grant", () => {
    const result = read([request(110, "r"), relayedGrant(112)], FLEET);
    expect(result.requests).toEqual([
      { platform: "ios", requestedAt: 110, requester: "a", worker: undefined },
    ]);
    expect([...result.workers]).toEqual([]);
  });

  it("serves a request through its dispatch, and records the worker it was dispatched to", () => {
    const result = read([request(110, "r"), dispatch(111, "r", "a", "w9")], FLEET);
    expect(result.requests).toEqual([
      { platform: "ios", requestedAt: 110, requester: "a", worker: "w9" },
    ]);
    expect([...result.workers]).toEqual(["w9"]);
  });

  it("ignores a dispatch missing requestId, requesterId or workerId, or outside the window", () => {
    const result = read(
      [
        request(110, "r"),
        at(111, "request.dispatched", { requesterId: "a", workerId: "w1" }),
        at(112, "request.dispatched", { requestId: "r", workerId: "w1" }),
        at(113, "request.dispatched", { requestId: "r", requesterId: "a" }),
        dispatch(100, "r"),
        dispatch(201, "r"),
      ],
      FLEET,
    );
    expect(result.requests[0]?.worker).toBeUndefined();
  });

  it("takes a dispatch at exactly the window end", () => {
    const result = read([request(110, "r"), dispatch(200, "r")], FLEET);
    expect(result.requests[0]?.worker).toBe("w1");
  });

  it("ignores a dispatch on a worker", () => {
    const result = read([request(110, "r"), dispatch(111, "r")]);
    expect(result.requests[0]?.worker).toBe("self");
    expect(result.requests[0]).not.toHaveProperty("outcome");
  });

  it("counts a relayed grant with its source and lease id, and defaults both to empty", () => {
    const withEnd = read(
      [
        request(110, "r"),
        dispatch(111, "r"),
        relayedGrant(112, { leaseId: undefined, source: undefined }),
        at(130, "lease.released", { leaseId: "", workerId: "w1" }),
      ],
      FLEET,
    );
    expect(withEnd.requests[0]).toMatchObject({
      endedAt: 130,
      outcome: { at: 112, kind: "granted", source: "" },
    });
    const plain = read(
      [request(110, "r"), dispatch(111, "r"), relayedGrant(112, { source: "cold" })],
      FLEET,
    );
    expect(plain.requests[0]?.outcome).toEqual({ at: 112, kind: "granted", source: "cold" });
  });

  it("counts a relayed rejection with its reason, defaulting a missing reason to empty is impossible so it is ignored", () => {
    const rejection = read([request(110, "r"), dispatch(111, "r"), relayedReject(112)], FLEET);
    expect(rejection.requests[0]?.outcome).toEqual({
      at: 112,
      kind: "rejected",
      reason: "no-capacity",
    });
    const reasonless = read(
      [request(110, "r"), dispatch(111, "r"), relayedReject(112, { reason: undefined })],
      FLEET,
    );
    expect(reasonless.requests[0]).not.toHaveProperty("outcome");
  });

  it("ignores a relayed grant or rejection without a requester, and one outside the window", () => {
    const result = read(
      [
        request(110, "r"),
        dispatch(111, "r"),
        relayedGrant(112, { requester: undefined }),
        relayedReject(113, { requester: undefined }),
        relayedGrant(100),
        relayedGrant(201),
        relayedReject(100),
        relayedReject(201),
      ],
      FLEET,
    );
    expect(result.requests[0]).not.toHaveProperty("outcome");
  });

  it("ignores a relayed grant of another worker or another requester", () => {
    const result = read(
      [
        request(110, "r"),
        dispatch(111, "r"),
        relayedGrant(112, { workerId: "w2" }),
        relayedGrant(113, { requester: "gw:b" }),
        relayedGrant(114, { requester: "a" }),
      ],
      FLEET,
    );
    expect(result.requests[0]).not.toHaveProperty("outcome");
  });

  it("takes the first relayed answer, in event order", () => {
    const result = read(
      [
        request(110, "r"),
        dispatch(111, "r"),
        relayedGrant(112, { source: "first" }),
        relayedGrant(113, { source: "second" }),
      ],
      FLEET,
    );
    expect(result.requests[0]?.outcome).toMatchObject({ source: "first" });
  });

  it("lets a grant that came before the dispatch count, but not a rejection", () => {
    const grant = read([request(110, "r"), relayedGrant(111), dispatch(112, "r")], FLEET);
    expect(grant.requests[0]?.outcome).toMatchObject({ kind: "granted" });
    const rejection = read([request(110, "r"), relayedReject(111), dispatch(112, "r")], FLEET);
    expect(rejection.requests[0]).not.toHaveProperty("outcome");
  });

  it("does not let a grant from before the request count", () => {
    const result = read([relayedGrant(105), request(110, "r"), dispatch(111, "r")], FLEET);
    expect(result.requests[0]).not.toHaveProperty("outcome");
  });

  it("counts a rejection arriving right after the dispatch", () => {
    const result = read([request(110, "r"), dispatch(111, "r"), relayedReject(112)], FLEET);
    expect(result.requests[0]?.outcome).toMatchObject({ kind: "rejected" });
  });

  it("cuts off relayed answers at the requester's next request", () => {
    const result = read(
      [
        request(110, "r1"),
        dispatch(111, "r1"),
        request(112, "r2"),
        dispatch(113, "r2"),
        relayedGrant(114, { leaseId: "L2", source: "late" }),
      ],
      FLEET,
    );
    const [first, second] = result.requests;
    expect(first).not.toHaveProperty("outcome");
    expect(second?.outcome).toMatchObject({ source: "late" });
  });

  it("cuts off at a next dispatch of the requester even when its request was not seen", () => {
    const result = read(
      [request(110, "r1"), dispatch(111, "r1"), dispatch(112, "r2"), relayedGrant(113)],
      FLEET,
    );
    expect(result.requests[0]).not.toHaveProperty("outcome");
  });

  it("does not cut off at another requester's request", () => {
    const result = read(
      [request(110, "r1"), dispatch(111, "r1"), request(112, "r2", "b"), relayedGrant(113)],
      FLEET,
    );
    expect(result.requests[0]?.outcome).toMatchObject({ kind: "granted" });
  });

  it("does not cut off at a request with no requester or a dispatch with no requesterId", () => {
    const result = read(
      [
        request(110, "r1"),
        dispatch(111, "r1"),
        at(112, "lease.requested", { requestId: "x" }),
        at(113, "request.dispatched", { requestId: "x", workerId: "w1" }),
        relayedGrant(114),
      ],
      FLEET,
    );
    expect(result.requests[0]?.outcome).toMatchObject({ kind: "granted" });
  });

  it("does not cut off at an earlier request of the same requester", () => {
    const result = read(
      [request(105, "r0"), request(110, "r1"), dispatch(111, "r1"), relayedGrant(112)],
      FLEET,
    );
    expect(result.requests.map((r) => r.outcome?.kind)).toEqual([undefined, "granted"]);
  });

  it("does not treat a relayed lease.requested as a request or a boundary", () => {
    const result = read(
      [
        request(110, "r1"),
        dispatch(111, "r1"),
        request(112, "r9", "a", { workerId: "w1" }),
        relayedGrant(113),
      ],
      FLEET,
    );
    expect(result.requests).toHaveLength(1);
    expect(result.requests[0]?.outcome).toMatchObject({ kind: "granted" });
  });

  it("settles a gateway's own rejection of a seen request without a worker", () => {
    const result = read(
      [
        request(110, "r"),
        at(120, "lease.rejected", { reason: "no-capacity", requestId: "r", requester: "a" }),
      ],
      FLEET,
    );
    expect(result.requests).toEqual([
      {
        outcome: { at: 120, kind: "rejected", reason: "no-capacity" },
        platform: "ios",
        requestedAt: 110,
        requester: "a",
        worker: undefined,
      },
    ]);
  });

  it("counts a gateway's own refused-at-admission rejection with no worker", () => {
    const result = read(
      [at(120, "lease.rejected", { reason: "killed", requestId: "x", requester: "a" })],
      FLEET,
    );
    expect(result.requests).toEqual([
      {
        outcome: { at: 120, kind: "rejected", reason: "killed" },
        platform: undefined,
        requestedAt: undefined,
        requester: "a",
        worker: undefined,
      },
    ]);
  });

  it("does not count a relayed rejection with a refused-at-admission reason as the gateway's own", () => {
    const result = read([relayedReject(120, { reason: "killed", requestId: "x" })], FLEET);
    expect(result.requests).toEqual([]);
  });

  it("does not take a relayed lease.requested as the gateway's own request", () => {
    const result = read([request(110, "r", "a", { workerId: "w1" })], FLEET);
    expect(result.requests).toEqual([]);
  });

  it("ignores a dispatch missing requesterId or workerId, recording no worker for it", () => {
    const noRequester = read(
      [request(110, "r"), at(111, "request.dispatched", { requestId: "r", workerId: "w1" })],
      FLEET,
    );
    expect(noRequester.requests[0]?.worker).toBeUndefined();
    expect([...noRequester.workers]).toEqual([]);
    const noWorker = read(
      [request(110, "r"), at(111, "request.dispatched", { requestId: "r", requesterId: "a" })],
      FLEET,
    );
    expect(noWorker.requests[0]?.worker).toBeUndefined();
    expect([...noWorker.workers]).toEqual([]);
  });

  it("keeps a grant answering a request before the requester's next request", () => {
    const result = read(
      [
        request(110, "r1"),
        dispatch(111, "r1"),
        relayedGrant(112, { source: "mine" }),
        request(113, "r2"),
        dispatch(114, "r2"),
      ],
      FLEET,
    );
    expect(result.requests[0]?.outcome).toMatchObject({ source: "mine" });
    expect(result.requests[1]).not.toHaveProperty("outcome");
  });

  it("does not match a worker-less relayed grant to a dispatch to a worker named undefined", () => {
    const result = read(
      [
        request(110, "r"),
        dispatch(111, "r", "a", "undefined"),
        at(112, "lease.granted", { leaseId: "L", requester: "gw:a" }),
      ],
      FLEET,
    );
    expect(result.requests[0]).not.toHaveProperty("outcome");
  });

  it("does not match a relayed grant with no requester to a requester named undefined", () => {
    const result = read(
      [
        request(110, "r", "undefined"),
        dispatch(111, "r", "undefined"),
        relayedGrant(112, { requester: undefined }),
      ],
      { ...FLEET, requesterPrefix: "" },
    );
    expect(result.requests[0]).not.toHaveProperty("outcome");
  });
});

describe("keys that look like missing ids", () => {
  it("does not join an end with no lease id to a grant of a lease named undefined", () => {
    const result = read([
      request(110, "r"),
      at(120, "lease.granted", { leaseId: "undefined", requestId: "r" }),
      at(130, "lease.released", {}),
    ]);
    expect(result.requests[0]).not.toHaveProperty("endedAt");
  });

  it("does not remember a platform for a provisioning with no device id under the name undefined", () => {
    const result = read([
      at(110, "device.provisioned", { duration: 1, spec: { platform: "android" } }),
      at(120, "device.ready", { bootDuration: 5, deviceId: "undefined" }),
    ]);
    expect(result.devices.at(-1)?.platform).toBeUndefined();
  });

  it("gives a boot with no device id no platform even if a device was named undefined", () => {
    const result = read([
      at(110, "device.provisioned", {
        deviceId: "undefined",
        duration: 1,
        spec: { platform: "android" },
      }),
      at(120, "device.ready", { bootDuration: 5 }),
    ]);
    expect(result.devices.at(-1)?.platform).toBeUndefined();
  });

  it("does not share a platform between a worker-less provisioning and a worker named undefined", () => {
    const result = read(
      [
        at(110, "device.provisioned", {
          deviceId: "d",
          duration: 1,
          spec: { platform: "android" },
        }),
        at(120, "device.ready", { bootDuration: 5, deviceId: "d", workerId: "undefined" }),
      ],
      FLEET,
    );
    expect(result.devices).toEqual([
      { kind: "boot", platform: undefined, value: 5, worker: "undefined" },
    ]);
  });
});
