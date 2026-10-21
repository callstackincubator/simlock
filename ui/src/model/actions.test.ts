import { describe, expect, it } from "vitest";

import { inboxActions, leaseActions, requestActions, workerActions } from "./actions";
import { inboxItems } from "./inbox";
import type { LeaseRecord } from "./leases";
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
  expect(shape(of("wrk_old_drained/incompatible").menu)).toEqual(["undrain"]);
  expect(shape(of("wrk_old/incompatible").menu)).toEqual(["drain"]);
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

describe("the actions each kind of item offers", () => {
  it("offers exactly the table's actions: dangerous ones last and marked, worker actions only on a gateway, and the Inbox's one fix", () => {
    checksLease();
    checksRequest();
    checksWorker();
    checksNoWorkerActionOffHost();
    checksInbox();
  });
});
