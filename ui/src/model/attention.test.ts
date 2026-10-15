import { describe, expect, it } from "vitest";

import { attentionItems, attentionPageOf } from "./attention";
import type { ConsoleEvent } from "./events";
import type { WorkerDevice, WorkerView } from "./workers";

const NOW = Date.parse("2026-10-02T12:00:00Z");
const GIB = 1024 ** 3;

function worker(overrides: Partial<WorkerView> = {}): WorkerView {
  return {
    catalog: [],
    connection: "connected",
    devices: [],
    drained: false,
    id: "wrk_1",
    lastSeenAt: NOW,
    leases: [],
    ...overrides,
  };
}

function device(id: string, overrides: Partial<WorkerDevice> = {}): WorkerDevice {
  return {
    physical: false,
    id,
    mode: "full",
    servesDefaultMode: true,
    spec: { physical: false, model: "iPhone 16", osVersion: "18.4", platform: "ios" },
    state: "ready",
    ...overrides,
  };
}

function capacity(ramBudget?: { usedBytes: number; limitBytes: number; overLimit: boolean }) {
  const entry = {
    atRamBudget: false,
    limit: 4,
    maxRunning: 4,
    overLimit: false,
    reserved: 0,
    running: 1,
    used: 1,
  };
  return {
    android: { ...entry, warm: 0 },
    global: { maxRunning: 4, overLimit: false, reserved: 0, running: 1, warm: 0 },
    ios: { ...entry, warm: 0 },
    ...(ramBudget === undefined ? {} : { ramBudget }),
  };
}

function event(seq: number, name: string, at: number, payload: unknown = {}): ConsoleEvent {
  return { event: name, id: `e${seq}`, payload, seq, timestamp: at };
}

function summary(workers: readonly WorkerView[]): string[] {
  return attentionItems(workers).map((item) =>
    [item.worker.id, "device" in item ? item.device.id : "-", item.condition].join(" "),
  );
}

function pageOf(
  workers: readonly WorkerView[],
  key?: string,
  events: readonly ConsoleEvent[] = [],
) {
  return attentionPageOf({ events, key, now: NOW, workers });
}

function shownOf(page: ReturnType<typeof pageOf>) {
  if (typeof page.shown !== "object") throw new Error("no item is shown");
  return page.shown;
}

function factsOf(w: WorkerView, key: string) {
  return shownOf(pageOf([w], key)).facts;
}

describe("the items that need attention", () => {
  it("hold a disconnected, an incompatible and a drained worker, one item per condition", () => {
    const workers = [
      worker({ id: "wrk_ok" }),
      worker({ connection: "disconnected", id: "wrk_gone" }),
      worker({ connection: "incompatible", id: "wrk_old" }),
      worker({ drained: true, id: "wrk_drained" }),
      worker({ connection: "disconnected", drained: true, id: "wrk_both" }),
    ];

    expect(summary(workers)).toEqual([
      "wrk_gone - disconnected",
      "wrk_old - incompatible",
      "wrk_drained - drained",
      "wrk_both - disconnected",
      "wrk_both - drained",
    ]);
  });

  it("hold a quarantined device and a stalled device, not one mid-transition", () => {
    const workers = [
      worker({
        devices: [
          device("dev_ready"),
          device("dev_quarantined", { state: "quarantined" }),
          device("dev_stuck", { stalled: true, state: "reclaiming", transitionAgeMs: 300_000 }),
          device("dev_busy", { state: "provisioning", transitionAgeMs: 2_000 }),
        ],
      }),
    ];

    expect(summary(workers)).toEqual([
      "wrk_1 dev_quarantined quarantined",
      "wrk_1 dev_stuck stalled",
    ]);
  });

  it("hold a quarantined physical device like any quarantined device", () => {
    const physical: WorkerDevice = {
      class: "phone",
      id: "dev_phone",
      physical: true,
      servesDefaultMode: false,
      spec: { model: "iPhone 15 Pro", osVersion: "18.4", physical: true, platform: "ios" },
      state: "quarantined",
    };

    expect(summary([worker({ devices: [physical] })])).toEqual(["wrk_1 dev_phone quarantined"]);
  });

  it("hold a worker over its RAM budget, not one under it or with no budget", () => {
    const workers = [
      worker({
        capacity: capacity({ limitBytes: 12 * GIB, overLimit: true, usedBytes: 13 * GIB }),
        id: "wrk_over",
      }),
      worker({
        capacity: capacity({ limitBytes: 12 * GIB, overLimit: false, usedBytes: 4 * GIB }),
        id: "wrk_under",
      }),
      worker({ capacity: capacity(), id: "wrk_none" }),
      worker({ id: "wrk_unread" }),
    ];

    expect(summary(workers)).toEqual(["wrk_over - over RAM budget"]);
  });

  it("lose an item when its condition clears", () => {
    const quarantined = device("dev_1", { state: "quarantined" });
    const stalled = device("dev_2", { stalled: true, state: "provisioning" });
    const ramBudget = { limitBytes: 12 * GIB, usedBytes: 13 * GIB };
    const before = worker({
      capacity: capacity({ ...ramBudget, overLimit: true }),
      connection: "disconnected",
      devices: [quarantined, stalled],
      drained: true,
    });
    expect(attentionItems([before])).toHaveLength(5);

    const cleared: [string, WorkerView][] = [
      ["disconnected", { ...before, connection: "connected" }],
      ["drained", { ...before, drained: false }],
      ["over RAM budget", { ...before, capacity: capacity({ ...ramBudget, overLimit: false }) }],
      ["quarantined", { ...before, devices: [{ ...quarantined, state: "ready" }, stalled] }],
      ["stalled", { ...before, devices: [quarantined, device("dev_2", { state: "ready" })] }],
    ];
    for (const [condition, after] of cleared) {
      const conditions = attentionItems([after]).map((item) => item.condition);
      expect(conditions, condition).toHaveLength(4);
      expect(conditions, condition).not.toContain(condition);
    }
  });
});

describe("the attention page", () => {
  it("lists a row per item, naming the worker or the device on its worker", () => {
    const page = pageOf([
      worker({ connection: "disconnected", id: "wrk/1", label: "mac-mini-1" }),
      worker({ devices: [device("dev_q", { state: "quarantined" })], id: "wrk_2" }),
    ]);

    expect(page.rows.map((row) => [row.word, row.tone, row.subject, row.to])).toEqual([
      ["disconnected", "error", "mac-mini-1", "/attention/wrk%2F1%2Fdisconnected"],
      ["quarantined", "error", "iPhone 16 on wrk_2", "/attention/wrk_2%2Fdev_q%2Fquarantined"],
    ]);
  });

  it("shows the first item when the URL names none", () => {
    const page = pageOf([worker({ drained: true }), worker({ drained: true, id: "wrk_2" })]);

    expect(page.named).toBe(false);
    expect(shownOf(page).key).toBe("wrk_1/drained");
  });

  it("shows the item the URL names", () => {
    const page = pageOf(
      [worker({ drained: true }), worker({ drained: true, id: "wrk_2" })],
      "wrk_2/drained",
    );

    expect(page.named).toBe(true);
    expect(shownOf(page).key).toBe("wrk_2/drained");
  });

  it("says an item the URL names is resolved once the daemon stops reporting it", () => {
    const page = pageOf([worker()], "wrk_1/drained");

    expect(page.shown).toBe("resolved");
  });

  it("shows nothing when nothing needs attention and the URL names nothing", () => {
    const page = pageOf([worker()]);

    expect(page.rows).toEqual([]);
    expect(page.shown).toBeUndefined();
  });

  it("titles a worker item by the worker and a device item by its model and runtime", () => {
    const workers = [
      worker({ drained: true, label: "mac-mini-1" }),
      worker({ devices: [device("dev_q", { state: "quarantined" })], id: "wrk_2" }),
    ];

    expect(shownOf(pageOf(workers)).title).toBe("mac-mini-1");
    expect(shownOf(pageOf(workers, "wrk_2/dev_q/quarantined")).title).toBe("iPhone 16 18.4");
  });

  it("gives a disconnected worker the time since it was last seen", () => {
    const w = worker({ connection: "disconnected", lastSeenAt: NOW - 100_000 });

    expect(factsOf(w, "wrk_1/disconnected")).toEqual([
      { label: "Last seen", value: "1 min 40 s ago" },
    ]);
  });

  it("gives an incompatible worker both protocol ranges", () => {
    const w = worker({
      connection: "incompatible",
      protocol: { gateway: { max: 3, min: 2 }, worker: { max: 1, min: 1 } },
    });

    expect(factsOf(w, "wrk_1/incompatible")).toEqual([
      { label: "Gateway protocol", value: "2–3" },
      { label: "Worker protocol", value: "1" },
    ]);
  });

  it("gives a drained worker the leases it still holds", () => {
    const lease = { deviceId: "d", grantedAt: NOW, id: "l" } as unknown as never;
    const w = worker({ drained: true, leases: [lease] });

    expect(factsOf(w, "wrk_1/drained")).toEqual([{ label: "Leases still held", value: "1" }]);
  });

  it("gives a worker over its RAM budget what it uses and its limit", () => {
    const ramBudget = { limitBytes: 12 * GIB, overLimit: true, usedBytes: 13 * GIB };

    expect(factsOf(worker({ capacity: capacity(ramBudget) }), "wrk_1/ram")).toEqual([
      { label: "Used", value: "13.00 GiB" },
      { label: "Limit", value: "12.00 GiB" },
    ]);
  });

  it("gives a stalled device its id, state and time in that state", () => {
    const w = worker({
      devices: [
        device("dev_stuck", { stalled: true, state: "provisioning", transitionAgeMs: 90_000 }),
      ],
      lastSeenAt: NOW - 10_000,
    });

    expect(factsOf(w, "wrk_1/dev_stuck/stalled")).toEqual([
      { label: "Device", value: "dev_stuck" },
      { label: "State", value: "provisioning" },
      { label: "In this state for", value: "1 min 40 s" },
    ]);
  });

  it("gives a quarantined device no time in its state", () => {
    const w = worker({ devices: [device("dev_q", { state: "quarantined" })] });

    expect(factsOf(w, "wrk_1/dev_q/quarantined")).toEqual([
      { label: "Device", value: "dev_q" },
      { label: "State", value: "quarantined" },
    ]);
  });

  it("gives a stalled device on a disconnected worker no time in its state", () => {
    // why: a gateway keeps a disconnected worker's devices as last reported, with an age it can no
    // longer count from.
    const w = worker({
      connection: "disconnected",
      devices: [
        device("dev_stuck", { stalled: true, state: "reclaiming", transitionAgeMs: 90_000 }),
      ],
    });

    const labels = factsOf(w, "wrk_1/dev_stuck/stalled").map((fact) => fact.label);

    expect(labels).toEqual(["Device", "State"]);
  });

  it("lists the last hour's events naming the worker or the device, newest first", () => {
    const w = worker({ devices: [device("dev_1", { state: "quarantined" })], drained: true });
    const events = [
      event(1, "worker.drain-started", NOW - 50 * 60_000, { workerId: "wrk_1" }),
      event(2, "device.quarantined", NOW - 5 * 60_000, { deviceId: "dev_1" }),
      event(3, "lease.granted", NOW - 60_000, { deviceId: "dev_other" }),
      event(4, "worker.drain-started", NOW - 2 * 60 * 60_000, { workerId: "wrk_1" }),
      event(5, "worker.rejected", NOW - 60_000, { workerId: "wrk_1" }),
    ];

    const ofWorker = shownOf(pageOf([w], "wrk_1/drained", events));
    const ofDevice = shownOf(pageOf([w], "wrk_1/dev_1/quarantined", events));

    expect(ofWorker.events.map((entry) => entry.key)).toEqual(["e1"]);
    expect(ofDevice.events.map((entry) => entry.key)).toEqual(["e2", "e1"]);
    expect(ofDevice.events[0]).toMatchObject({
      name: "device.quarantined",
      to: "/events/e2",
      tone: "error",
    });
  });

  it("links each item to its worker's page", () => {
    const page = pageOf([worker({ drained: true, id: "wrk/1", label: "mac-mini-1" })]);

    expect(shownOf(page).worker).toEqual({ name: "mac-mini-1", to: "/workers/wrk%2F1" });
  });
});
