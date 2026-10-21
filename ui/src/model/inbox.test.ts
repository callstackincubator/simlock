import { describe, expect, it } from "vitest";

import { filterInboxRows, inboxItems, inboxPageOf } from "./inbox";
import type { ConsoleEvent } from "./events";
import { filterLeaseRows, type LeaseRecord, leaseRows, type TokenRecord } from "./leases";
import type { WaitingRequest } from "./waiting";
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
  return inboxItems(workers).map((item) =>
    [
      "worker" in item ? item.worker.id : "-",
      "device" in item ? item.device.id : "-",
      item.condition,
    ].join(" "),
  );
}

function pageOf(
  workers: readonly WorkerView[],
  key?: string,
  events: readonly ConsoleEvent[] = [],
) {
  return inboxPageOf({ events, key, now: NOW, workers });
}

function shownOf(page: ReturnType<typeof pageOf>) {
  if (typeof page.shown !== "object") throw new Error("no item is shown");
  return page.shown;
}

function factsOf(w: WorkerView, key: string) {
  return shownOf(pageOf([w], key)).facts;
}

describe("the Inbox items", () => {
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
    expect(inboxItems([before])).toHaveLength(5);

    const cleared: [string, WorkerView][] = [
      ["disconnected", { ...before, connection: "connected" }],
      ["drained", { ...before, drained: false }],
      ["over RAM budget", { ...before, capacity: capacity({ ...ramBudget, overLimit: false }) }],
      ["quarantined", { ...before, devices: [{ ...quarantined, state: "ready" }, stalled] }],
      ["stalled", { ...before, devices: [quarantined, device("dev_2", { state: "ready" })] }],
    ];
    for (const [condition, after] of cleared) {
      const conditions = inboxItems([after]).map((item) => item.condition);
      expect(conditions, condition).toHaveLength(4);
      expect(conditions, condition).not.toContain(condition);
    }
  });
});

describe("the Inbox items of an absent phone", () => {
  it("hold an absent phone titled with its model and why, and not a phone in another state", () => {
    const phone = (
      id: string,
      state: WorkerDevice["state"],
      absentReason?: "locked" | "untrusted" | "not-present",
    ) =>
      Object.assign(
        device(id, {
          class: "phone",
          physical: true,
          servesDefaultMode: false,
          spec: { model: "iPhone 15 Pro", osVersion: "18.4", physical: true, platform: "ios" },
          state,
        }),
        absentReason === undefined ? {} : { absentReason },
      );
    const workers = [
      worker({
        devices: [
          phone("dev_locked", "absent", "locked"),
          phone("dev_untrusted", "absent", "untrusted"),
          phone("dev_gone", "absent", "not-present"),
          phone("dev_bare", "absent"),
          phone("dev_ready", "ready"),
          phone("dev_shut", "shutdown"),
        ],
      }),
    ];

    expect(pageOf(workers).rows.map((row) => [row.key, row.word, row.tone, row.subject])).toEqual([
      ["wrk_1/dev_locked/absent", "absent", "warn", "iPhone 15 Pro is absent (locked)"],
      ["wrk_1/dev_untrusted/absent", "absent", "warn", "iPhone 15 Pro is absent (untrusted)"],
      ["wrk_1/dev_gone/absent", "absent", "warn", "iPhone 15 Pro is absent (not-present)"],
      ["wrk_1/dev_bare/absent", "absent", "warn", "iPhone 15 Pro is absent (not-present)"],
    ]);
  });
});

describe("the Inbox items of a long wait", () => {
  it("hold a request that has waited over 60 s by the daemon's now, titled with its requester and the wait", () => {
    const waiting = (waitedMs: number): WaitingRequest => ({
      createdAt: NOW - waitedMs,
      id: "req_1",
      queuePosition: 1,
      requesterId: "agent-b",
      spec: { model: "iPhone 16", platform: "ios" },
      stage: "queued",
    });
    const rowsAt = (waitedMs: number) =>
      inboxPageOf({
        events: [],
        key: undefined,
        now: NOW,
        requests: [waiting(waitedMs)],
        workers: [worker()],
      }).rows.map((row) => [row.key, row.word, row.tone, row.subject]);

    expect(rowsAt(59_999)).toEqual([]);
    expect(rowsAt(60_000)).toEqual([]);
    expect(rowsAt(60_001)).toEqual([
      ["request/req_1/waiting", "waiting", "warn", "agent-b has waited 1 min"],
    ]);
    expect(
      inboxItems([worker()], { now: NOW, requests: [waiting(61_000)] }).map((item) => item.key),
    ).toEqual(["request/req_1/waiting"]);
  });
});

describe("the Inbox items of a lease about to end", () => {
  it("hold a lease with under 5 minutes left as a heads-up, not one with more, and the Leases filter agrees", () => {
    const lease = (id: string, leftMs: number): LeaseRecord => ({
      deviceId: "dev_1",
      grantedAt: NOW - 60_000,
      id,
      idChosenByRequester: false,
      lastRenewedAt: NOW - 30_000,
      ownerId: "tok_1",
      requesterId: "tok_1",
      ttlDeadline: NOW + leftMs,
      ttlMs: 900_000,
    });
    const tokens: TokenRecord[] = [
      { createdAt: NOW - 1_000_000, id: "tok_1", label: "ci-runner-3", role: "agent" },
    ];
    const workers = [worker({ devices: [device("dev_1")] })];
    const leases = [
      lease("lse_far", 301_000),
      lease("lse_edge", 300_000),
      lease("lse_near", 299_000),
      lease("lse_four_oh_five", 245_000),
      lease("lse_now", 0),
      lease("lse_past", -1_000),
      { ...lease("lse_lost", 10_000), deviceId: "dev_gone" },
    ];

    const page = inboxPageOf({ events: [], key: undefined, leases, now: NOW, tokens, workers });

    expect(page.rows.map((row) => [row.key, row.word, row.subject])).toEqual([
      ["lease/lse_past/ending", "ending", "ci-runner-3 · iPhone 16 ends now"],
      ["lease/lse_now/ending", "ending", "ci-runner-3 · iPhone 16 ends now"],
      ["lease/lse_lost/ending", "ending", "ci-runner-3 · dev_gone ends in 0:10"],
      ["lease/lse_four_oh_five/ending", "ending", "ci-runner-3 · iPhone 16 ends in 4:05"],
      ["lease/lse_near/ending", "ending", "ci-runner-3 · iPhone 16 ends in 4:59"],
    ]);
    expect(
      filterLeaseRows(leaseRows({ leases, now: NOW, tokens, workers }), "expiring").map(
        (row) => row.id,
      ),
    ).toEqual(["lse_four_oh_five", "lse_lost", "lse_near", "lse_now", "lse_past"]);
  });
});

describe("the drawer of a waiting request and of a lease about to end", () => {
  it("says what happened, lists the details and links to the request's and the lease's own page", () => {
    const requests: WaitingRequest[] = [
      {
        createdAt: NOW - 125_000,
        id: "req_1",
        queuePosition: 1,
        requesterId: "agent-b",
        spec: { model: "iPhone 16", platform: "ios" },
        stage: "queued",
      },
    ];
    const leases: LeaseRecord[] = [
      {
        deviceId: "dev_1",
        grantedAt: NOW - 60_000,
        id: "wrk_1.lse_1",
        idChosenByRequester: false,
        lastRenewedAt: NOW - 30_000,
        ownerId: "tok_1",
        requesterId: "tok_1",
        ttlDeadline: NOW + 90_000,
        ttlMs: 900_000,
      },
    ];
    const workers = [worker({ devices: [device("dev_1")] })];
    const shown = (key: string) =>
      shownOf(inboxPageOf({ events: [], key, leases, now: NOW, requests, workers }));

    const waiting = shown("request/req_1/waiting");
    const ending = shown("lease/wrk_1.lse_1/ending");

    expect(waiting.what).toBe("agent-b has waited 2 min 5 s for a device.");
    expect(waiting.facts.map((fact) => [fact.label, fact.value])).toEqual([
      ["Waited", "2 min 5 s"],
      ["Device", "iOS iPhone 16"],
      ["Request", "req_1"],
    ]);
    expect(waiting.about).toEqual({
      name: "agent-b",
      open: "Open request",
      to: "/queue/req_1",
    });
    expect(ending.what).toBe("tok_1's lease on iPhone 16 ends in 1:30.");
    expect(ending.facts.map((fact) => [fact.label, fact.value])).toEqual([
      ["Time left", "1:30"],
      ["Device", "iPhone 16"],
      ["Holder", "tok_1"],
      ["Lease", "wrk_1.lse_1"],
    ]);
    expect(ending.about).toEqual({
      name: "tok_1 · iPhone 16",
      open: "Open lease",
      to: "/leases/wrk_1.lse_1/",
    });
  });
});

describe("the order of the Inbox items", () => {
  it("keeps the order given for problems, puts the longest wait first and the least time left first", () => {
    const request = (id: string, waitedMs: number): WaitingRequest => ({
      createdAt: NOW - waitedMs,
      id,
      queuePosition: 1,
      requesterId: "agent-b",
      spec: { model: "iPhone 16", platform: "ios" },
      stage: "queued",
    });
    const lease = (id: string, leftMs: number): LeaseRecord => ({
      deviceId: "dev_1",
      grantedAt: NOW - 60_000,
      id,
      idChosenByRequester: false,
      lastRenewedAt: NOW - 30_000,
      ownerId: "tok_1",
      requesterId: "tok_1",
      ttlDeadline: NOW + leftMs,
      ttlMs: 900_000,
    });
    const workers = [
      worker({ drained: true, id: "wrk_z" }),
      worker({ drained: true, id: "wrk_a", devices: [device("dev_2", { state: "quarantined" })] }),
    ];

    const keys = inboxItems(workers, {
      leases: [lease("lse_b", 200_000), lease("lse_a", 100_000)],
      now: NOW,
      requests: [request("req_new", 70_000), request("req_old", 90_000)],
    }).map((item) => item.key);

    expect(keys).toEqual([
      "wrk_z/drained",
      "wrk_a/drained",
      "wrk_a/dev_2/quarantined",
      "request/req_old/waiting",
      "request/req_new/waiting",
      "lease/lse_a/ending",
      "lease/lse_b/ending",
    ]);
  });
});

describe("the Inbox groups", () => {
  it("group the rows as Broken, Needs a look, Heads-up, and count problems without the heads-ups", () => {
    const workers = [
      worker({ drained: true, id: "wrk_a" }),
      worker({ connection: "disconnected", id: "wrk_b" }),
    ];
    const request: WaitingRequest = {
      createdAt: NOW - 90_000,
      id: "req_1",
      queuePosition: 1,
      requesterId: "agent-b",
      spec: { model: "iPhone 16", platform: "ios" },
      stage: "queued",
    };
    const lease: LeaseRecord = {
      deviceId: "dev_1",
      grantedAt: NOW - 60_000,
      id: "lse_1",
      idChosenByRequester: false,
      lastRenewedAt: NOW - 30_000,
      ownerId: "tok_1",
      requesterId: "tok_1",
      ttlDeadline: NOW + 100_000,
      ttlMs: 900_000,
    };

    const page = inboxPageOf({
      events: [],
      key: undefined,
      leases: [lease, { ...lease, id: "lse_2", ttlDeadline: NOW + 200_000 }],
      now: NOW,
      requests: [request],
      workers,
    });

    expect(page.rows.map((row) => [row.group, row.key])).toEqual([
      ["Broken", "wrk_b/disconnected"],
      ["Needs a look", "wrk_a/drained"],
      ["Needs a look", "request/req_1/waiting"],
      ["Heads-up", "lease/lse_1/ending"],
      ["Heads-up", "lease/lse_2/ending"],
    ]);
    expect(page.problems).toBe(3);
    expect(filterInboxRows(page.rows, "Needs a look").map((row) => row.key)).toEqual([
      "wrk_a/drained",
      "request/req_1/waiting",
    ]);
    expect(filterInboxRows(page.rows, "all")).toHaveLength(5);
  });
});

describe("the Inbox page", () => {
  it("lists a row per item, naming the worker or the device on its worker", () => {
    const page = pageOf([
      worker({ connection: "disconnected", id: "wrk/1", label: "mac-mini-1" }),
      worker({ devices: [device("dev_q", { state: "quarantined" })], id: "wrk_2" }),
    ]);

    expect(page.rows.map((row) => [row.word, row.tone, row.subject, row.to])).toEqual([
      ["disconnected", "error", "mac-mini-1", "/inbox/wrk%2F1%2Fdisconnected"],
      ["quarantined", "error", "iPhone 16 on wrk_2", "/inbox/wrk_2%2Fdev_q%2Fquarantined"],
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

  it("shows nothing when the Inbox is empty and the URL names nothing", () => {
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

  it("ends a quarantined device's facts with Cause for each kind", () => {
    const cases = [
      [
        { kind: "purge-failed", message: "Error: erase failed" },
        "Purge failed: Error: erase failed",
      ],
      [
        { kind: "shutdown-failed", message: "Error: no shutdown" },
        "Shutdown failed: Error: no shutdown",
      ],
      [{ kind: "delete-failed", message: "Error: no delete" }, "Delete failed: Error: no delete"],
      [{ kind: "purge-failed" }, "Purge failed"],
      [{ kind: "stalled", stalledState: "provisioning" }, "Stalled while provisioning"],
      [{ kind: "stalled", stalledState: "reclaiming" }, "Stalled while reclaiming"],
    ] as const;

    for (const [quarantineCause, text] of cases) {
      const w = worker({
        devices: [Object.assign(device("dev_q", { state: "quarantined" }), { quarantineCause })],
      });

      expect(factsOf(w, "wrk_1/dev_q/quarantined"), text).toEqual([
        { label: "Device", value: "dev_q" },
        { label: "State", value: "quarantined" },
        { label: "Cause", value: text },
      ]);
    }
  });

  it("gives a stalled device that is not quarantined no Cause, even when its record still carries one", () => {
    const w = worker({
      devices: [
        Object.assign(device("dev_stuck", { stalled: true, state: "reclaiming" }), {
          quarantineCause: { kind: "purge-failed", message: "Error: erase failed" },
        }),
      ],
    });

    const labels = factsOf(w, "wrk_1/dev_stuck/stalled").map((fact) => fact.label);

    expect(labels).not.toContain("Cause");
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
      to: "/activity/e2",
      tone: "error",
    });
  });

  it("links each item to its worker's page", () => {
    const page = pageOf([worker({ drained: true, id: "wrk/1", label: "mac-mini-1" })]);

    expect(shownOf(page).about).toEqual({
      name: "mac-mini-1",
      open: "Open worker",
      to: "/fleet/wrk%2F1",
    });
  });
});
