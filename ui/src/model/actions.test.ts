import { describe, expect, it } from "vitest";

import { inboxActions, leaseActions, requestActions, workerActions } from "./actions";
import { inboxItems } from "./inbox";
import type { LeaseRecord } from "./leases";
import type { UpdateFacts } from "./versions";
import type { WaitingRequest } from "./waiting";
import type { WorkerView } from "./workers";

const NOW = Date.parse("2026-10-02T12:00:00Z");

function worker(overrides: Partial<WorkerView> = {}): WorkerView {
  return {
    catalog: [],
    connection: "connected",
    devices: [],
    drained: false,
    id: "wrk_1",
    label: "mac-mini-1",
    lastSeenAt: NOW,
    leases: [],
    ...overrides,
  };
}

const LEASE = {
  deviceTo: "/fleet/wrk_1/dev_1",
  holder: "agent-1",
  id: "lse_1",
  key: " lse_1",
  model: "iPhone 16",
  worker: "mac-mini-1",
} as const;

function shape(actions: readonly { readonly id: string; readonly danger: boolean }[]) {
  return actions.map((action) => `${action.id}${action.danger ? "!" : ""}`);
}

function checksLease(): void {
  const lease = leaseActions(LEASE);
  expect(shape(lease)).toEqual(["release-lease!"]);
  expect(lease[0]?.method).toBe("DELETE");
  expect(lease[0]?.path).toBe("/v1/leases/lse_1");
  expect(lease[0]?.confirm).toEqual({
    body: "iPhone 16 on mac-mini-1 goes back to the pool now, and agent-1's next command on it fails.",
    busy: "Releasing…",
    confirm: "Release lease",
    title: "Release agent-1's lease?",
  });
  expect(lease[0]?.success).toEqual({
    description: "iPhone 16 on mac-mini-1 goes back to the pool.",
    title: "Released agent-1's lease",
    view: { label: "View device", to: "/fleet/wrk_1/dev_1" },
  });
}

function checksRequest(): void {
  const cancel = requestActions({
    device: "iOS iPhone 16",
    id: "req_1",
    key: "/req_1",
    requester: "agent-2",
  });
  expect(shape(cancel)).toEqual(["cancel-request!"]);
  expect(cancel[0]?.method).toBe("DELETE");
  expect(cancel[0]?.path).toBe("/v1/lease-requests/req_1");
  expect(cancel[0]?.confirm).toEqual({
    body: "agent-2 stops waiting for iOS iPhone 16 and gets an error.",
    busy: "Cancelling…",
    confirm: "Cancel request",
    title: "Cancel agent-2's request?",
  });
  expect(cancel[0]?.success).toEqual({ title: "Cancelled agent-2's request" });
}

function checksWorker(): void {
  const named = (connection: WorkerView["connection"], drained: boolean) =>
    workerActions({ connection, drained, id: "wrk_1", name: "mac-mini-1" }, "gateway");
  expect(shape(named("connected", false))).toEqual(["drain"]);
  expect(shape(named("connected", true))).toEqual(["undrain"]);
  expect(shape(named("disconnected", false))).toEqual(["drain", "remove-worker!"]);
  expect(shape(named("disconnected", true))).toEqual(["undrain", "remove-worker!"]);
  expect(shape(named("incompatible", false))).toEqual(["drain"]);
  const [drain] = named("connected", false);
  expect(drain).toMatchObject({ method: "POST", path: "/v1/workers/wrk_1/drain" });
  expect(drain?.confirm).toBeUndefined();
  expect(drain?.success).toEqual({
    description: "Its leases keep running. New leases go to other workers.",
    title: "mac-mini-1 drained",
  });
  const [undrain] = named("connected", true);
  expect(undrain).toMatchObject({ method: "DELETE", path: "/v1/workers/wrk_1/drain" });
  expect(undrain?.success).toEqual({ title: "mac-mini-1 takes leases again" });
  const [, remove] = named("disconnected", false);
  expect(remove).toMatchObject({ method: "DELETE", path: "/v1/workers/wrk_1" });
  expect(remove?.confirm).toEqual({
    body: "It leaves the fleet and its devices are forgotten. It can join again with a worker token.",
    busy: "Removing…",
    confirm: "Remove worker",
    title: "Remove mac-mini-1?",
    typeToConfirm: "mac-mini-1",
  });
  expect(remove?.success).toEqual({ title: "mac-mini-1 removed" });
}

function checksNoWorkerActionOffHost(): void {
  for (const mode of ["worker", undefined] as const) {
    expect(
      workerActions(
        { connection: "disconnected", drained: false, id: "wrk_1", name: "mac-mini-1" },
        mode,
      ),
    ).toEqual([]);
  }
}

function checksInbox(): void {
  const waiting = {
    createdAt: NOW - 120_000,
    id: "req_1",
    requesterId: "agent-2",
    spec: { platform: "ios", model: "iPhone 16" },
  } as unknown as WaitingRequest;
  const ending = {
    deviceId: "dev_1",
    grantedAt: NOW - 600_000,
    id: "lse_1",
    requesterId: "agent-1",
    ttlDeadline: NOW + 30_000,
    ttlMs: 900_000,
    workerId: "wrk_1",
  } as unknown as LeaseRecord;
  const workers = [
    worker({ drained: true, id: "wrk_drained" }),
    worker({ connection: "disconnected", id: "wrk_gone" }),
    worker({ connection: "incompatible", id: "wrk_old" }),
    worker({ connection: "incompatible", drained: true, id: "wrk_old_drained" }),
    worker({
      devices: [
        { id: "dev_a", spec: { model: "iPhone 16", platform: "ios" }, state: "leased" },
        { id: "dev_b", spec: { model: "iPhone 16", platform: "ios" }, state: "ready" },
      ] as unknown as WorkerView["devices"],
      id: "wrk_failed",
      lastUpdateFailure: { at: NOW, from: "0.3.0", message: "x", stage: "installing", to: "0.4.0" },
      latestVersion: "0.4.0",
      version: "0.3.0",
    }),
    worker({
      connection: "disconnected",
      id: "wrk_failed_gone",
      lastUpdateFailure: { at: NOW, from: "0.3.0", message: "x", stage: "installing", to: "0.4.0" },
    }),
    worker({
      devices: [
        {
          id: "dev_1",
          mode: "full",
          physical: false,
          servesDefaultMode: true,
          spec: { model: "iPhone 16", osVersion: "18.4", physical: false, platform: "ios" },
          state: "leased",
        },
      ],
    }),
  ];
  const context = { mode: "gateway", now: NOW, tokens: [], workers } as const;
  const items = inboxItems(workers, { leases: [ending], now: NOW, requests: [waiting] });
  const of = (key: string) => {
    const item = items.find((candidate) => candidate.key === key);
    if (item === undefined) throw new Error(`no item ${key}`);
    return inboxActions(item, context);
  };
  const drained = of("wrk_drained/drained");
  expect(drained.fix?.id).toBe("undrain");
  expect(shape(drained.menu)).toEqual(["undrain"]);
  expect(of("wrk_gone/disconnected").fix).toBeUndefined();
  expect(shape(of("wrk_gone/disconnected").menu)).toEqual(["drain", "remove-worker!"]);
  expect(of("wrk_old/incompatible").fix).toBeUndefined();
  expect(of("wrk_old_drained/incompatible").fix).toBeUndefined();
  expect(shape(of("wrk_old_drained/incompatible").menu)).toEqual(["undrain", "update-worker"]);
  expect(shape(of("wrk_old/incompatible").menu)).toEqual(["drain", "update-worker"]);
  const failed = of("wrk_failed/update-failed");
  expect(failed.fix?.id).toBe("update-worker");
  expect(failed.fix?.confirm?.body).toBe(
    "It takes no new leases and waits for its 1 lease to end. It restarts by itself.",
  );
  expect(shape(failed.menu)).toEqual(["drain", "update-worker"]);
  expect(of("wrk_failed_gone/update-failed").fix).toBeUndefined();
  expect(of("request/req_1/waiting").fix).toBeUndefined();
  expect(shape(of("request/req_1/waiting").menu)).toEqual(["cancel-request!"]);
  const heldLease = of("lease/lse_1/ending");
  expect(heldLease.fix).toBeUndefined();
  expect(shape(heldLease.menu)).toEqual(["release-lease!"]);
  expect(heldLease.menu[0]?.confirm?.body).toBe(
    "iPhone 16 on mac-mini-1 goes back to the pool now, and agent-1's next command on it fails.",
  );
  const drainedItem = items.find((item) => item.key === "wrk_drained/drained");
  if (drainedItem === undefined) throw new Error("no drained item");
  expect(inboxActions(drainedItem, { ...context, mode: undefined })).toEqual({ menu: [] });
}

function facts(overrides: Partial<UpdateFacts> = {}): UpdateFacts {
  return { latestVersion: "0.4.0", leased: 0, update: null, version: "0.3.0", ...overrides };
}

const STARTED = { forced: false, from: "0.3.0", startedAt: 1, to: "0.4.0" } as const;

describe("the update actions a worker offers", () => {
  it("offers Update… and Update now as the table says, and keeps Drain and Undrain", () => {
    const cases: readonly {
      readonly name: string;
      readonly connection?: WorkerView["connection"];
      readonly mode?: "gateway" | "worker";
      readonly facts: UpdateFacts;
      readonly offered: readonly string[];
    }[] = [
      { name: "a worker's mode", mode: "worker", facts: facts(), offered: [] },
      {
        name: "disconnected",
        connection: "disconnected",
        facts: facts(),
        offered: ["drain", "remove-worker"],
      },
      {
        name: "waiting",
        facts: facts({ update: { ...STARTED, leases: 2, stage: "waiting" } }),
        offered: ["drain", "force-update"],
      },
      {
        name: "disconnected and waiting",
        connection: "disconnected",
        facts: facts({ update: { ...STARTED, leases: 2, stage: "waiting" } }),
        offered: ["drain", "remove-worker"],
      },
      {
        name: "installing",
        facts: facts({ update: { ...STARTED, stage: "installing" } }),
        offered: ["drain"],
      },
      {
        name: "restarting",
        facts: facts({ update: { ...STARTED, stage: "restarting" } }),
        offered: ["drain"],
      },
      {
        name: "incompatible whatever the latest",
        connection: "incompatible",
        facts: facts({ latestVersion: null }),
        offered: ["drain", "update-worker"],
      },
      { name: "newer", facts: facts(), offered: ["drain", "update-worker"] },
      { name: "equal", facts: facts({ latestVersion: "0.3.0" }), offered: ["drain"] },
      { name: "older", facts: facts({ latestVersion: "0.2.0" }), offered: ["drain"] },
      { name: "no latest", facts: facts({ latestVersion: null }), offered: ["drain"] },
      {
        name: "no version",
        facts: { latestVersion: "0.4.0", leased: 0, update: null },
        offered: ["drain"],
      },
    ];
    for (const row of cases) {
      const offered = workerActions(
        {
          connection: row.connection ?? "connected",
          drained: false,
          id: "wrk_1",
          name: "mac-mini-1",
          updateFacts: row.facts,
        },
        row.mode ?? "gateway",
      ).map((action) => action.id);
      expect(offered, row.name).toEqual(row.offered);
    }
    const drained = workerActions(
      { connection: "connected", drained: true, id: "wrk_1", name: "m", updateFacts: facts() },
      "gateway",
    );
    expect(drained.map((action) => action.id)).toEqual(["undrain", "update-worker"]);
  });
});

describe("the Update… dialog", () => {
  it("words its title and body for leases, none, an incompatible worker, no version and no latest, and sends {} to the worker's update route", () => {
    const update = (connection: WorkerView["connection"], updateFacts: UpdateFacts) =>
      workerActions(
        { connection, drained: false, id: "wrk/1", name: "mac-mini-1", updateFacts },
        "gateway",
      ).find((action) => action.id === "update-worker");
    const cases: readonly [string, WorkerView["connection"], UpdateFacts, string, string][] = [
      [
        "2 leased devices",
        "connected",
        facts({ leased: 2 }),
        "Update mac-mini-1 from 0.3.0 to 0.4.0?",
        "It takes no new leases and waits for its 2 leases to end. It restarts by itself.",
      ],
      [
        "1 leased device",
        "connected",
        facts({ leased: 1 }),
        "Update mac-mini-1 from 0.3.0 to 0.4.0?",
        "It takes no new leases and waits for its 1 lease to end. It restarts by itself.",
      ],
      [
        "no leases",
        "connected",
        facts(),
        "Update mac-mini-1 from 0.3.0 to 0.4.0?",
        "It has no leases, so it installs at once. It restarts by itself.",
      ],
      [
        "incompatible",
        "incompatible",
        facts({ leased: 2 }),
        "Update mac-mini-1 from 0.3.0 to 0.4.0?",
        "The gateway can't talk to it until then. It finishes its leases first.",
      ],
      [
        "incompatible, no version",
        "incompatible",
        { latestVersion: "0.4.0", leased: 0, update: null },
        "Update mac-mini-1 to 0.4.0?",
        "The gateway can't talk to it until then. It finishes its leases first.",
      ],
      [
        "incompatible, no latest",
        "incompatible",
        facts({ latestVersion: null }),
        "Update mac-mini-1 from 0.3.0 to the latest version?",
        "The gateway can't talk to it until then. It finishes its leases first.",
      ],
    ];
    for (const [name, connection, given, title, body] of cases) {
      const action = update(connection, given);
      expect(action?.confirm, name).toEqual({ body, busy: "Starting…", confirm: "Update", title });
      expect([action?.method, action?.path, action?.body], name).toEqual([
        "POST",
        "/v1/workers/wrk%2F1/update",
        {},
      ]);
    }
  });
});

describe("the Update now dialog", () => {
  it("counts the update's leases in its body and sends {\"force\":true} to the worker's update route", () => {
    const cases: readonly [number, string][] = [
      [2, "Its 2 leases keep running through the restart."],
      [1, "Its lease keeps running through the restart."],
    ];
    for (const [leases, body] of cases) {
      const action = workerActions(
        {
          connection: "connected",
          drained: false,
          id: "wrk/1",
          name: "mac-mini-1",
          updateFacts: facts({ update: { ...STARTED, leases, stage: "waiting" } }),
        },
        "gateway",
      ).find((candidate) => candidate.id === "force-update");
      expect(action?.confirm, String(leases)).toEqual({
        body,
        busy: "Starting…",
        confirm: "Install now",
        title: "Install 0.4.0 on mac-mini-1 now?",
      });
      expect([action?.method, action?.path, action?.body]).toEqual([
        "POST",
        "/v1/workers/wrk%2F1/update",
        { force: true },
      ]);
    }
  });
});

describe("the toast an update earns", () => {
  it("words the daemon's answer: started, following, upToDate and Update now accepted, and a refusal's title", () => {
    const running = { ...STARTED, stage: "installing" } as const;
    const offered = (updateFacts: UpdateFacts) => {
      const [, action] = workerActions(
        { connection: "connected", drained: false, id: "wrk_1", name: "mac-mini-1", updateFacts },
        "gateway",
      );
      if (action?.outcome === undefined) throw new Error("no update action");
      return { ...action, outcome: action.outcome };
    };
    const update = offered(facts());
    const force = offered(facts({ update: { ...STARTED, leases: 2, stage: "waiting" } }));
    const upToDate = { started: false, update: null, upToDate: true, version: "0.3.0" };
    const cases: readonly [typeof update, string, unknown, string][] = [
      [
        update,
        "started",
        { started: true, update: running, upToDate: false, version: "0.3.0" },
        "Updating mac-mini-1 to 0.4.0",
      ],
      [
        update,
        "following",
        { started: false, update: running, upToDate: false, version: "0.3.0" },
        "mac-mini-1 is already updating to 0.4.0",
      ],
      [update, "upToDate", upToDate, "mac-mini-1 already runs 0.3.0"],
      [update, "no body", undefined, "Updating mac-mini-1 to the latest version"],
      [
        force,
        "force accepted",
        { started: true, update: running, upToDate: false },
        "mac-mini-1 installs 0.4.0 now",
      ],
      [force, "force upToDate", upToDate, "mac-mini-1 already runs 0.3.0"],
    ];
    for (const [action, name, answer, title] of cases) {
      expect(action.outcome(answer), name).toEqual({ title });
    }
    expect(force.id).toBe("force-update");
    expect(force.success).toEqual({ title: "mac-mini-1 installs 0.4.0 now" });
    expect([update.timeoutMs, force.timeoutMs]).toEqual([100_000, 100_000]);
    expect([update.failure, force.failure]).toEqual(Array(2).fill("Couldn't update mac-mini-1"));
  });
});

describe("the actions each kind of item offers", () => {
  it("offers exactly the table's actions: dangerous ones last and marked, worker actions only on a gateway, and the Inbox's one fix", () => {
    checksLease();
    checksRequest();
    checksWorker();
    checksNoWorkerActionOffHost();
    checksInbox();
  });
});
