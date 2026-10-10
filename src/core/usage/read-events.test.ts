import { describe, expect, it } from "vitest";

import type { EventEnvelope } from "../../bus/index.js";
import { readEvents, type ReadOptions } from "./read-events.js";

const WINDOW = { from: 100, to: 200 };
const WORKER: ReadOptions = {
  answeredBefore: new Set(),
  fleet: false,
  requestedBefore: new Set(),
  self: "self",
};
const FLEET: ReadOptions = {
  answeredBefore: new Set(),
  fleet: true,
  requestedBefore: new Set(),
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
/** What a worker relays of the grant it made for a gateway's dispatch. */
const relayedGrant = (ts: number, extra: Record<string, unknown> = {}) =>
  at(ts, "lease.granted", {
    leaseId: "L",
    requestId: "worker-side",
    requester: "gw:a",
    source: "warm",
    workerId: "w1",
    ...extra,
  });
/** The gateway's own record that it handed a fleet request's grant to its caller. */
const handed = (ts: number, requestId: string, extra: Record<string, unknown> = {}) =>
  at(ts, "request.granted", {
    leaseId: "gw-lease",
    requestId,
    worker: "w1",
    workerLeaseId: "L",
    ...extra,
  });
/** The gateway's own rejection of a fleet request. */
const gatewayReject = (
  ts: number,
  requestId: string,
  reason: string,
  extra: Record<string, unknown> = {},
) =>
  at(ts, "lease.rejected", {
    reason,
    requestId,
    requestSpec: { platform: "ios" },
    requester: "a",
    ...extra,
  });
const restarted = (ts: number, extra: Record<string, unknown> = {}) =>
  at(ts, "daemon.started", { configSnapshot: {}, version: "0", ...extra });
/** What a worker relays of its refusal of a gateway's dispatch. */
const declined = (ts: number, extra: Record<string, unknown> = {}) =>
  at(ts, "lease.declined", {
    fleetRequestId: "r",
    reason: "no-wait",
    requestId: "worker-side",
    requestSpec: { platform: "ios" },
    requester: "gw:a",
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
  it("counts a grant with no source as an empty source, and takes no grant without a leaseId", () => {
    const result = read([
      request(110, "r1"),
      at(120, "lease.granted", { leaseId: "L1", requestId: "r1", requester: "a" }),
      request(130, "r2", "b"),
      at(140, "lease.granted", { requestId: "r2", requester: "b", source: "warm" }),
    ]);
    expect(result.requests[0]?.outcome).toEqual({ at: 120, kind: "granted", source: "" });
    expect(result.requests[1]).not.toHaveProperty("outcome");
  });

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
        heldMs: 10,
        outcome: { at: 120, kind: "granted", source: "" },
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
    expect(result.requests[0]).toMatchObject({ heldMs: 10, outcome: { source: "warm" } });
  });

  it("does not join an end of another lease id", () => {
    const result = read([
      request(110, "r"),
      at(120, "lease.granted", { leaseId: "L", requestId: "r" }),
      at(130, "lease.released", { leaseId: "other" }),
    ]);
    expect(result.requests[0]).not.toHaveProperty("heldMs");
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
    expect(result.requests[0]?.outcome).toEqual({ at: 200, kind: "granted", source: "cold" });
  });

  it("ignores an end with no lease id, and one outside the window", () => {
    const result = read([
      request(110, "r"),
      at(120, "lease.granted", { leaseId: "L", requestId: "r" }),
      at(130, "lease.released", {}),
      at(100, "lease.released", { leaseId: "L" }),
      at(201, "lease.released", { leaseId: "L" }),
    ]);
    expect(result.requests[0]).not.toHaveProperty("heldMs");
  });

  it("takes an end at exactly the window end", () => {
    const result = read([
      request(110, "r"),
      at(120, "lease.granted", { leaseId: "L", requestId: "r" }),
      at(200, "lease.released", { leaseId: "L" }),
    ]);
    expect(result.requests[0]?.heldMs).toBe(80);
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

  it("counts each incident event under the name the figure uses, and each `*-failed` event under its event name, a recovery failure under both", () => {
    const names: Record<string, string> = {
      "device.quarantine-abandoned": "lost",
      "device.quarantine-recovered": "quarantineRecovered",
      "device.quarantine-stranded": "lost",
      "device.quarantined": "quarantined",
      "device.recovered": "crashRecovered",
      "device.recovery-failed": "lost",
    };
    const incidents = Object.keys(names).map((name, i) => at(110 + i, name, {}));
    const failures = [
      at(130, "device.purge-failed", {}),
      at(131, "component.install-failed", {}),
      at(132, "device.some-new-failed", {}),
    ];
    const result = read([
      ...incidents,
      ...failures,
      at(133, "device.created", {}),
      at(134, "lease.other", {}),
    ]);
    expect(result.devices.map((d) => [d.kind, d.value])).toEqual([
      ...Object.values(names).map((v) => ["incident", v]),
      ["failure", "device.recovery-failed"],
      ["failure", "device.purge-failed"],
      ["failure", "component.install-failed"],
      ["failure", "device.some-new-failed"],
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

describe("requests carried into the window", () => {
  const answered = (...ids: string[]): ReadOptions => ({
    ...WORKER,
    answeredBefore: new Set(ids),
  });
  const grant = (ts: number, requestId: string, requester = "a") =>
    at(ts, "lease.granted", { leaseId: `L${requestId}`, requestId, requester, source: "warm" });

  it("carries a request made exactly at the window's start, and treats an answer the history reports as answering it", () => {
    expect(read([request(100, "edge")]).carried).toHaveLength(1);
    expect(read([request(90, "old")], answered("old")).carried).toEqual([]);
  });

  it("carries a request made before the window that nothing had answered, with its outcome inside it", () => {
    const result = read([request(90, "old"), grant(150, "old")]);
    expect(result.requests).toEqual([]);
    expect(result.carried).toHaveLength(1);
    expect(result.carried[0]).toMatchObject({
      outcome: { at: 150, kind: "granted", source: "warm" },
      requestedAt: 90,
      requester: "a",
      worker: "self",
    });
  });

  it("does not carry a request answered before the window, or one made inside it", () => {
    const result = read(
      [request(80, "done", "b"), request(85, "refused", "c"), request(110, "inside")],
      answered("done", "refused"),
    );
    expect(result.carried).toEqual([]);
    expect(result.requests).toHaveLength(1);
  });

  it("carries only a requester's latest request made before the window", () => {
    const result = read([request(80, "first"), request(90, "second")], answered("first"));
    expect(result.carried.map((fact) => fact.requestedAt)).toEqual([90]);
  });

  it("matches a carried request to its answer by request id, not by requester", () => {
    // Another request of the same requester was answered; this one was not.
    const result = read([request(90, "waits")], answered("some-other-request"));
    expect(result.carried.map((fact) => fact.requestedAt)).toEqual([90]);
  });

  it("does not carry a worker's probe, which never waits there", () => {
    const result = read([request(90, "probe", "gw:a", { fleetRequestId: "f" })]);
    expect(result.carried).toEqual([]);
  });

  it("carries a gateway request that nothing, on the gateway's own clock, had answered, with its outcome inside the window", () => {
    const result = read([request(90, "old"), handed(150, "old")], FLEET);
    expect(result.carried).toEqual([
      expect.objectContaining({ outcome: expect.objectContaining({ at: 150 }), worker: "w1" }),
    ]);
    expect(read([request(90, "old")], FLEET).carried).toHaveLength(1);
    expect(
      read([request(90, "old")], { ...FLEET, answeredBefore: new Set(["old"]) }).carried,
    ).toEqual([]);
  });

  it("settles a carried gateway request at the gateway's next start, whether that is before the window or inside it, and leaves one a start preceded open", () => {
    const before = read([request(80, "old"), restarted(90)], FLEET);
    expect(before.carried).toEqual([
      expect.objectContaining({
        outcome: { at: 90, kind: "rejected", reason: "daemon-restarted" },
      }),
    ]);
    const later = read([request(80, "old"), restarted(150)], FLEET);
    expect(later.carried).toEqual([
      expect.objectContaining({
        outcome: { at: 150, kind: "rejected", reason: "daemon-restarted" },
        requestedAt: 80,
      }),
    ]);
    const after = read([restarted(70), request(80, "old")], FLEET);
    expect(after.carried[0]).not.toHaveProperty("outcome");
  });
});

describe("a worker's probes and declines", () => {
  it("marks a request carrying fleetRequestId as a probe and a request without one as no probe", () => {
    const result = read([
      request(110, "p", "gw:a", { fleetRequestId: "f" }),
      request(111, "l", "b"),
    ]);
    expect(result.requests[0]).toHaveProperty("probe", true);
    expect(result.requests[1]).not.toHaveProperty("probe");
  });

  it("counts a probe's grant and held time like any grant", () => {
    const result = read([
      request(110, "p", "gw:a", { fleetRequestId: "f" }),
      at(120, "lease.granted", { leaseId: "L", requestId: "p", requester: "gw:a", source: "warm" }),
      at(150, "lease.released", { leaseId: "L" }),
    ]);
    expect(result.requests[0]).toMatchObject({
      heldMs: 30,
      outcome: { at: 120, kind: "granted", source: "warm" },
      probe: true,
    });
  });

  it("counts the worker's own lease.declined under itself with the platform of requestSpec", () => {
    const result = read([
      declined(110, { requestSpec: { platform: "android" } }),
      declined(111, { requestSpec: {} }),
    ]);
    expect(result.declines).toEqual([
      { platform: "android", worker: "self" },
      { platform: undefined, worker: "self" },
    ]);
    expect(result.requests).toEqual([]);
    expect([...result.workers]).toEqual(["self"]);
  });

  it("counts a decline at exactly the window end and not at its start or after", () => {
    const result = read([declined(100), declined(200), declined(201)]);
    expect(result.declines).toHaveLength(1);
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

  it("gives a request with no outcome no worker and leaves it open", () => {
    const result = read([request(110, "r")], FLEET);
    expect(result.requests).toEqual([
      { platform: "ios", requestedAt: 110, requester: "a", worker: undefined },
    ]);
    expect([...result.workers]).toEqual([]);
  });

  it("does not take a relayed lease.requested as the gateway's own request", () => {
    const result = read([request(110, "r", "a", { workerId: "w1" })], FLEET);
    expect(result.requests).toEqual([]);
  });

  describe("the outcome of a fleet request, by its request id", () => {
    it("is the gateway's request.granted, by the gateway's clock, naming the worker it handed the grant from", () => {
      const result = read(
        [relayedGrant(105), request(110, "r"), handed(150, "r", { worker: "w1" })],
        FLEET,
      );
      expect(result.requests[0]).toMatchObject({
        outcome: { at: 150, kind: "granted" },
        requestedAt: 110,
        worker: "w1",
      });
      expect([...result.workers]).toEqual(["w1"]);
    });

    it("is a request.granted at exactly the window end, and none missing a field or outside the window", () => {
      expect(read([request(110, "r"), handed(200, "r")], FLEET).requests[0]).toHaveProperty(
        "outcome",
      );
      const none = read(
        [
          request(110, "r"),
          handed(120, "r", { requestId: undefined }),
          handed(121, "r", { worker: undefined }),
          handed(122, "r", { workerLeaseId: undefined }),
          handed(100, "r"),
          handed(201, "r"),
        ],
        FLEET,
      );
      expect(none.requests[0]).not.toHaveProperty("outcome");
    });

    it("is not a request.granted that carries a workerId, which only a worker's relayed event does", () => {
      const result = read([request(110, "r"), handed(120, "r", { workerId: "w1" })], FLEET);
      expect(result.requests[0]).not.toHaveProperty("outcome");
    });

    it("is not a request.granted on a worker", () => {
      const result = read([request(110, "r"), handed(120, "r")]);
      expect(result.requests[0]).not.toHaveProperty("outcome");
    });

    it("is the gateway's own lease.rejected, under no worker, and a worker-failed one under its worker", () => {
      const result = read(
        [
          request(110, "timed-out"),
          gatewayReject(120, "timed-out", "timeout", { worker: "w1" }),
          request(111, "failed", "b"),
          gatewayReject(121, "failed", "worker-failed", {
            code: "INTERNAL",
            requester: "b",
            worker: "w2",
          }),
        ],
        FLEET,
      );
      expect(result.requests).toEqual([
        {
          outcome: { at: 120, kind: "rejected", reason: "timeout" },
          platform: "ios",
          requestedAt: 110,
          requester: "a",
          worker: undefined,
        },
        {
          outcome: { at: 121, kind: "rejected", reason: "worker-failed" },
          platform: "ios",
          requestedAt: 111,
          requester: "b",
          worker: "w2",
        },
      ]);
      expect([...result.workers]).toEqual(["w2"]);
    });

    it("is never a rejection a worker relayed, nor a grant it relayed, nor a decline", () => {
      const result = read(
        [
          request(110, "r"),
          gatewayReject(120, "r", "no-wait", { workerId: "w1" }),
          relayedGrant(121, { requestId: "r" }),
          declined(122, { requestId: "r" }),
          request(130, "r2", "b"),
          relayedGrant(131, { requester: "gw:b" }),
        ],
        FLEET,
      );
      expect(result.requests.map((fact) => fact.outcome)).toEqual([undefined, undefined]);
    });

    it("follows the request id, so another request of the same requester neither takes nor loses the outcome", () => {
      const result = read(
        [request(110, "r1"), request(112, "r2"), handed(120, "r2"), request(130, "r3")],
        FLEET,
      );
      expect(result.requests.map((fact) => fact.outcome?.kind)).toEqual([
        undefined,
        "granted",
        undefined,
      ]);
    });

    it("is, with neither, the gateway's next own daemon.started, as a rejection daemon-restarted under no worker", () => {
      const result = read([request(110, "r"), restarted(150), restarted(160)], FLEET);
      expect(result.requests[0]).toEqual({
        outcome: { at: 150, kind: "rejected", reason: "daemon-restarted" },
        platform: "ios",
        requestedAt: 110,
        requester: "a",
        worker: undefined,
      });
    });

    it("is a daemon.started at exactly the window end", () => {
      const result = read([request(110, "r"), restarted(200)], FLEET);
      expect(result.requests[0]?.outcome).toEqual({
        at: 200,
        kind: "rejected",
        reason: "daemon-restarted",
      });
    });

    it("stays open past a daemon.started before the request, a relayed one, one after the window, and one on a worker", () => {
      const open = (events: EventEnvelope[], options: ReadOptions = FLEET) =>
        read(events, options).requests[0]?.outcome;
      expect(open([restarted(105), request(110, "r")])).toBeUndefined();
      expect(open([request(110, "r"), restarted(150, { workerId: "w1" })])).toBeUndefined();
      expect(open([request(110, "r"), restarted(201)])).toBeUndefined();
      expect(open([request(110, "r"), restarted(150)], WORKER)).toBeUndefined();
    });

    it("is the request.granted or lease.rejected, not the restart that follows it", () => {
      const result = read(
        [
          request(110, "g"),
          request(111, "j", "b"),
          restarted(150),
          handed(160, "g"),
          gatewayReject(161, "j", "timeout", { requester: "b" }),
        ],
        FLEET,
      );
      expect(result.requests.map((fact) => fact.outcome?.kind)).toEqual(["granted", "rejected"]);
      expect(result.requests[1]?.outcome).toMatchObject({ reason: "timeout" });
    });
  });

  describe("the device facts of a fleet grant, from the worker it names", () => {
    const events = (endWorker: string, endLease: string) => [
      request(110, "r"),
      relayedGrant(112),
      handed(115, "r"),
      at(130, "lease.released", { leaseId: endLease, workerId: endWorker }),
    ];

    it("take the source and the held time, by the worker's clock, from the relayed lease.granted and end of the worker and lease it names", () => {
      const result = read(events("w1", "L"), FLEET);
      expect(result.requests[0]).toMatchObject({
        heldMs: 18,
        outcome: { at: 115, kind: "granted", source: "warm" },
      });
    });

    it("have no held time from an end of another worker or another lease, or one no worker relayed", () => {
      expect(read(events("w2", "L"), FLEET).requests[0]).not.toHaveProperty("heldMs");
      expect(read(events("w1", "M"), FLEET).requests[0]).not.toHaveProperty("heldMs");
      const unrelayed = read(
        [
          request(110, "r"),
          relayedGrant(112),
          handed(115, "r"),
          at(130, "lease.released", { leaseId: "L" }),
        ],
        FLEET,
      );
      expect(unrelayed.requests[0]).not.toHaveProperty("heldMs");
    });

    it("look up each grant's end under the worker its own request.granted names, when two workers use one lease id", () => {
      const result = read(
        [
          request(110, "r1"),
          request(111, "r2", "b"),
          relayedGrant(112, { workerId: "w1" }),
          relayedGrant(115, { requester: "gw:b", workerId: "w2" }),
          handed(116, "r1", { worker: "w1" }),
          handed(117, "r2", { worker: "w2" }),
          at(130, "lease.released", { leaseId: "L", workerId: "w1" }),
          at(150, "lease.released", { leaseId: "L", workerId: "w2" }),
        ],
        FLEET,
      );
      expect(result.requests.map((fact) => [fact.worker, fact.heldMs])).toEqual([
        ["w1", 18],
        ["w2", 35],
      ]);
    });

    it("are the source unknown and no held time when no worker relayed the grant, whichever of its lease id or worker is missing", () => {
      const missing = read([request(110, "r"), handed(115, "r")], FLEET);
      expect(missing.requests[0]).toMatchObject({
        outcome: { at: 115, kind: "granted", source: "unknown" },
        worker: "w1",
      });
      expect(missing.requests[0]).not.toHaveProperty("heldMs");
      const otherLease = read(
        [request(110, "r"), relayedGrant(112, { leaseId: "M" }), handed(115, "r")],
        FLEET,
      );
      expect(otherLease.requests[0]?.outcome).toMatchObject({ source: "unknown" });
      const otherWorker = read(
        [request(110, "r"), relayedGrant(112, { workerId: "w2" }), handed(115, "r")],
        FLEET,
      );
      expect(otherWorker.requests[0]?.outcome).toMatchObject({ source: "unknown" });
      // An end of the lease with no relayed grant to start from gives no held time either.
      const endOnly = read(
        [
          request(110, "r"),
          handed(115, "r"),
          at(130, "lease.released", { leaseId: "L", workerId: "w1" }),
        ],
        FLEET,
      );
      expect(endOnly.requests[0]).not.toHaveProperty("heldMs");
    });

    it("default a relayed grant's missing source to empty, and ignore a relayed grant with no lease id or worker", () => {
      const noSource = read(
        [request(110, "r"), relayedGrant(112, { source: undefined }), handed(115, "r")],
        FLEET,
      );
      expect(noSource.requests[0]?.outcome).toMatchObject({ source: "" });
      const noLease = read(
        [
          request(110, "r"),
          relayedGrant(112, { leaseId: undefined }),
          handed(115, "r", { workerLeaseId: "undefined" }),
        ],
        FLEET,
      );
      expect(noLease.requests[0]?.outcome).toMatchObject({ source: "unknown" });
      const noWorker = read(
        [
          request(110, "r"),
          relayedGrant(112, { workerId: undefined }),
          handed(115, "r", { worker: "undefined" }),
        ],
        FLEET,
      );
      expect(noWorker.requests[0]?.outcome).toMatchObject({ source: "unknown" });
    });

    it("ignore a relayed grant outside the window", () => {
      const result = read(
        [request(110, "r"), relayedGrant(100), relayedGrant(201), handed(115, "r")],
        FLEET,
      );
      expect(result.requests[0]?.outcome).toMatchObject({ source: "unknown" });
    });
  });

  it("counts a relayed lease.declined under its worker and platform, one for each, and ignores a gateway's own and one outside the window", () => {
    const result = read(
      [
        declined(110, { workerId: "w1" }),
        declined(111, { workerId: "w1" }),
        declined(112, { requestSpec: { platform: "android" }, workerId: "w2" }),
        declined(113),
        declined(100, { workerId: "w1" }),
        declined(201, { workerId: "w1" }),
      ],
      FLEET,
    );
    expect(result.declines).toEqual([
      { platform: "ios", worker: "w1" },
      { platform: "ios", worker: "w1" },
      { platform: "android", worker: "w2" },
    ]);
    expect(result.requests).toEqual([]);
    expect([...result.workers].sort()).toEqual(["w1", "w2"]);
  });

  it("counts a gateway's own refused-at-admission rejection with no worker, including lease-id-taken", () => {
    for (const reason of ["killed", "already-leased", "lease-id-taken"]) {
      const result = read(
        [at(120, "lease.rejected", { reason, requestId: "x", requester: "a" })],
        FLEET,
      );
      expect(result.requests).toEqual([
        {
          outcome: { at: 120, kind: "rejected", reason },
          platform: undefined,
          requestedAt: undefined,
          requester: "a",
          worker: undefined,
        },
      ]);
    }
  });

  it("does not count a relayed rejection with a refused-at-admission reason as the gateway's own", () => {
    const result = read([gatewayReject(120, "x", "killed", { workerId: "w1" })], FLEET);
    expect(result.requests).toEqual([]);
  });
});

describe("keys that look like missing ids", () => {
  it("does not join an end with no lease id to a grant of a lease named undefined", () => {
    const result = read([
      request(110, "r"),
      at(120, "lease.granted", { leaseId: "undefined", requestId: "r" }),
      at(130, "lease.released", {}),
    ]);
    expect(result.requests[0]).not.toHaveProperty("heldMs");
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
