import { describe, expect, it } from "vitest";

import {
  eventsOfLease,
  filterLeaseRows,
  holderOf,
  type LeaseDetails,
  type LeaseRecord,
  leaseInspection,
  leasePath,
  leaseRows,
  leasesOnWorker,
  searchLeaseRows,
  streamOffer,
  type TokenRecord,
} from "./leases";
import type { ConsoleEvent } from "./events";
import { itemIdFrom } from "./paths";
import type { WorkerView } from "./workers";

const NOW = Date.parse("2026-10-02T12:00:00Z");

function lease(overrides: Partial<LeaseRecord> = {}): LeaseRecord {
  return {
    deviceId: "dev_1",
    grantedAt: NOW - 90_000,
    id: "lse_1",
    idChosenByRequester: false,
    lastRenewedAt: NOW - 30_000,
    ownerId: "tok_1",
    requesterId: "tok_1",
    ttlDeadline: NOW + 125_000,
    ttlMs: 250_000,
    ...overrides,
  };
}

const TOKEN: TokenRecord = {
  createdAt: NOW - 1_000_000,
  id: "tok_1",
  label: "ci-runner-3",
  role: "agent",
};

function host(overrides: Partial<WorkerView> = {}): WorkerView {
  return {
    capabilities: [{ name: "stream", state: "available" }],
    catalog: [],
    connection: "connected",
    devices: [
      {
        id: "dev_1",
        mode: "slim",
        physical: false,
        servesDefaultMode: false,
        spec: {
          imageTag: "base",
          model: "iPhone 16",
          osVersion: "18.4",
          physical: false,
          platform: "ios",
        },
        state: "leased",
      },
      {
        id: "dev_a",
        mode: "full",
        physical: false,
        servesDefaultMode: false,
        spec: { model: "Pixel 8", osVersion: "35", physical: false, platform: "android" },
        state: "leased",
      },
    ],
    drained: false,
    id: "wrk_host",
    label: "mac-mini-1",
    lastSeenAt: NOW,
    leases: [],
    ...overrides,
  } as unknown as WorkerView;
}

function details(overrides: Partial<LeaseDetails> = {}): LeaseDetails {
  return {
    createdAt: new Date(NOW - 90_000).toISOString(),
    device: "iPhone 16",
    deviceId: "dev_1",
    expiresAt: new Date(NOW + 125_000).toISOString(),
    id: "lse_1",
    imageTag: "base",
    mode: "slim",
    requestId: "req_7d1a",
    udid: "ABCD-1234",
    ...overrides,
  };
}

describe("the lease list rows", () => {
  it("names a lease by its token's label, else by its requester's id", () => {
    const rows = leaseRows({
      leases: [lease(), lease({ id: "lse_2", requesterId: "agent-7" })],
      now: NOW,
      tokens: [TOKEN],
      workers: [host()],
    });

    expect(rows.map((row) => row.holder)).toEqual(["ci-runner-3", "agent-7"]);
  });

  it("puts the time left, then the device model and the worker, on a row", () => {
    const [row] = leaseRows({ leases: [lease()], now: NOW, tokens: [], workers: [host()] });

    expect(row).toMatchObject({
      id: "lse_1",
      remaining: "2 min 5 s",
      sub: "iPhone 16 · mac-mini-1",
      to: "/leases/lse_1/",
    });
    expect(row?.percent).toBeCloseTo(50);
  });

  it("falls back to the device id when no worker view has the device", () => {
    const [row] = leaseRows({ leases: [lease()], now: NOW, tokens: [], workers: [] });

    expect(row?.sub).toBe("dev_1");
    expect(row?.platform).toBeUndefined();
  });

  it("lists leases oldest granted first, whatever order the daemon sends", () => {
    const sent = [
      lease({ grantedAt: NOW - 1_000, id: "lse_newest", workerId: "wrk_a" }),
      lease({ grantedAt: NOW - 9_000, id: "lse_b", workerId: "wrk_b" }),
      lease({ grantedAt: NOW - 9_000, id: "lse_a", workerId: "wrk_b" }),
      lease({ grantedAt: NOW - 9_000, id: "lse_z", workerId: "wrk_a" }),
    ];
    const ids = (leases: readonly LeaseRecord[]) =>
      leaseRows({ leases, now: NOW, tokens: [], workers: [] }).map((row) => row.id);

    expect(ids(sent)).toEqual(["lse_z", "lse_a", "lse_b", "lse_newest"]);
    expect(ids(sent.toReversed())).toEqual(ids(sent));
  });

  it("marks a lease expiring only when under 15 minutes are left", () => {
    const left = (ms: number) =>
      leaseRows({
        leases: [lease({ ttlDeadline: NOW + ms })],
        now: NOW,
        tokens: [],
        workers: [],
      })[0]?.expiring;

    expect(left(15 * 60_000 - 1)).toBe(true);
    expect(left(15 * 60_000)).toBe(false);
    expect(left(-5_000)).toBe(true);
  });

  it("filters to the expiring leases or to one platform, and keeps all of them for All", () => {
    const rows = leaseRows({
      leases: [
        lease({ grantedAt: 1, id: "ios_soon", ttlDeadline: NOW + 60_000 }),
        lease({
          deviceId: "dev_a",
          grantedAt: 2,
          id: "android_late",
          ttlDeadline: NOW + 3_600_000,
        }),
        lease({
          deviceId: "dev_x",
          grantedAt: 3,
          id: "unknown_late",
          ttlDeadline: NOW + 3_600_000,
        }),
      ],
      now: NOW,
      tokens: [],
      workers: [host()],
    });
    const ids = (filter: Parameters<typeof filterLeaseRows>[1]) =>
      filterLeaseRows(rows, filter).map((row) => row.id);

    expect(ids("all")).toEqual(["ios_soon", "android_late", "unknown_late"]);
    expect(ids("expiring")).toEqual(["ios_soon"]);
    expect(ids("ios")).toEqual(["ios_soon"]);
    expect(ids("android")).toEqual(["android_late"]);
  });
});

describe("a lease's page path", () => {
  it("has no `.` in its last segment for a gateway lease id, and names the lease again", () => {
    const id = "3f81a2c4-9b7d-4e21-8a55-1c0e6f2d7b93.lse_9f2c";
    const path = leasePath(id);

    expect(path.slice(path.lastIndexOf("/") + 1)).not.toContain(".");
    expect(itemIdFrom("/leases", path)).toBe(id);
  });
});

describe("a worker's leases", () => {
  it("are the ones that name it, or every one on a single host", () => {
    const onA = lease({ id: "a", workerId: "wrk_a" });
    const onB = lease({ id: "b", workerId: "wrk_b" });
    const local = lease({ id: "local" });
    const a = host({ id: "wrk_a" });
    const b = host({ id: "wrk_b" });

    expect(leasesOnWorker([onA, onB], "wrk_a", [a, b])).toEqual([onA]);
    expect(leasesOnWorker([local], "wrk_host", [host()])).toEqual([local]);
    expect(leasesOnWorker([local], "wrk_a", [a, b])).toEqual([]);
  });
});

describe("whether a worker offers the live screen", () => {
  it("offers it when the worker's stream capability is available", () => {
    expect(streamOffer(host())).toEqual({ offered: true });
  });

  it("says streaming is off on the worker when the capability is off or not reported", () => {
    const off = host({ capabilities: [{ name: "stream", state: "off" }] });
    const silent = host({ capabilities: [] });
    const unreported = host({ capabilities: undefined });

    expect(streamOffer(off)).toEqual({ offered: false, reason: "Streaming is off on mac-mini-1." });
    expect(streamOffer(silent).offered).toBe(false);
    expect(streamOffer(unreported).offered).toBe(false);
  });

  it("gives the worker's reason when the capability is unavailable", () => {
    const worker = host({
      capabilities: [{ name: "stream", reason: "ffmpeg is missing", state: "unavailable" }],
    });

    expect(streamOffer(worker)).toEqual({
      offered: false,
      reason: "Streaming is unavailable on mac-mini-1. ffmpeg is missing",
    });
  });

  it("leaves it to the daemon's answer when the lease's worker is not known", () => {
    expect(streamOffer(undefined)).toEqual({ offered: true });
  });
});

describe("a lease's inspection", () => {
  const inspect = (
    overrides: {
      lease?: LeaseDetails;
      record?: LeaseRecord | undefined;
      workers?: readonly WorkerView[];
    } = {},
  ) =>
    leaseInspection({
      lease: overrides.lease ?? details(),
      now: NOW,
      record: "record" in overrides ? overrides.record : lease(),
      tokens: [TOKEN],
      workers: overrides.workers ?? [host()],
    });

  it("shows the holder as the title, and every fact the daemon holds about the lease", () => {
    const shown = inspect();

    expect(shown).toMatchObject({
      device: {
        deviceId: "dev_1",
        imageTag: "base",
        kind: "Virtual",
        mode: "slim",
        udid: "ABCD-1234",
      },
      expiring: true,
      heldFor: "1 min 30 s",
      holder: { id: "tok_1", label: "ci-runner-3" },
      id: "lse_1",
      model: "iPhone 16",
      remaining: "2 min 5 s",
      renewed: "30 s ago",
      requestId: "req_7d1a",
      runtime: "18.4",
      title: "ci-runner-3",
      worker: { name: "mac-mini-1", to: "/fleet/wrk_host" },
    });
    expect(shown.percent).toBeCloseTo(50);
  });

  it("shows the grant time as a local HH:MM", () => {
    const at = new Date(2026, 9, 2, 7, 5, 59).getTime();

    const shown = inspect({ lease: details({ createdAt: new Date(at).toISOString() }) });

    expect(shown.granted).toBe("07:05");
  });

  it("warns once under 15 minutes are left", () => {
    const soon = details({ expiresAt: new Date(NOW + 14 * 60_000).toISOString() });
    const later = details({ expiresAt: new Date(NOW + 16 * 60_000).toISOString() });

    expect(inspect({ lease: soon }).expiring).toBe(true);
    expect(inspect({ lease: later }).expiring).toBe(false);
  });

  it("names the owner only where it is not the holder, and the request only when there is one", () => {
    const { requestId: _dropped, ...noRequest } = details();

    expect(inspect().ownerId).toBeUndefined();
    expect(inspect({ record: lease({ ownerId: "tok_9" }) }).ownerId).toBe("tok_9");
    expect(inspect({ lease: noRequest }).requestId).toBeUndefined();
  });

  it("shows a physical device without a mode", () => {
    const physical = host({
      devices: [
        {
          class: "phone",
          id: "dev_p",
          physical: true,
          servesDefaultMode: false,
          spec: { model: "iPhone 15 Pro", osVersion: "18.4", physical: true, platform: "ios" },
          state: "leased",
        },
      ],
    } as unknown as Partial<WorkerView>);
    const { imageTag: _tag, mode: _mode, ...bare } = details({ deviceId: "dev_p" });

    const shown = inspect({ lease: bare, workers: [physical] });

    expect(shown.device.kind).toBe("Physical");
    expect(shown.device.mode).toBeUndefined();
    expect(shown.device.imageTag).toBeUndefined();
  });

  it("titles the lease by its id and shows the missing facts as missing while the list has not answered", () => {
    const shown = inspect({ record: undefined });

    expect(shown.title).toBe("lse_1");
    expect(shown.holder).toBeUndefined();
    expect(shown.renewed).toBe("—");
    expect(shown.percent).toBeUndefined();
  });

  it("names the worker from the lease itself when no worker view has it", () => {
    const gone = details({
      id: "wrk_gone.lse_1",
      worker: { id: "wrk_gone", label: "mac-studio-2" },
    });

    expect(inspect({ lease: gone, record: undefined, workers: [] }).worker).toEqual({
      name: "mac-studio-2",
    });
    expect(
      inspect({ lease: details({ workerId: "wrk_gone" }), record: undefined, workers: [] }).worker,
    ).toEqual({ name: "wrk_gone" });
  });

  it("carries whether the lease's worker offers the live screen", () => {
    const off = host({ capabilities: [{ name: "stream", state: "off" }] });

    expect(inspect({ workers: [off] }).stream).toEqual({
      offered: false,
      reason: "Streaming is off on mac-mini-1.",
    });
    expect(inspect().stream.offered).toBe(true);
  });
});

describe("a lease's holder on a worker a gateway feeds", () => {
  it("is the agent behind the gateway's prefix, matched to its token's label", () => {
    const tokens = [
      { createdAt: 0, id: "tok_9f2c", label: "ci-runner-3", role: "agent" },
    ] as unknown as TokenRecord[];

    expect(holderOf("gw:03787a13-4eac:tok_9f2c", tokens)).toEqual({
      id: "tok_9f2c",
      label: "ci-runner-3",
    });
    expect(holderOf("gw:03787a13-4eac:claude-ios-3", tokens)).toEqual({ id: "claude-ios-3" });
    expect(holderOf("claude-ios-3", tokens)).toEqual({ id: "claude-ios-3" });
  });
});

function heldEvent(seq: number, event: string, payload: unknown): ConsoleEvent {
  return { event, id: `evt_${seq}`, payload, seq, timestamp: NOW + seq * 1_000 };
}

describe("a lease's events", () => {
  it("lists the held events whose payload.leaseId is the lease's id, newest first", () => {
    const events = [
      heldEvent(1, "lease.granted", { leaseId: "lse_1" }),
      heldEvent(2, "lease.granted", { leaseId: "lse_2" }),
      heldEvent(3, "lease.renewed", { leaseId: "lse_1" }),
      heldEvent(4, "worker.connected", { workerId: "wrk_1" }),
      heldEvent(5, "lease.expired", "lse_1"),
    ];

    expect(eventsOfLease(events, "lse_1").map((event) => event.id)).toEqual(["evt_3", "evt_1"]);
    expect(eventsOfLease(events, "lse_9")).toEqual([]);
  });
});

describe("a lease's events on a gateway", () => {
  it("lists a worker's relayed event by the gateway's spelling and the gateway's own event by its id", () => {
    const events = [
      heldEvent(1, "lease.granted", { leaseId: "lse_1", workerId: "wrk_a" }),
      heldEvent(2, "lease.granted", { leaseId: "lse_1", workerId: "wrk_b" }),
      heldEvent(3, "lease.released", { leaseId: "wrk_a.lse_1" }),
    ];

    expect(eventsOfLease(events, "wrk_a.lse_1").map((event) => event.id)).toEqual([
      "evt_3",
      "evt_1",
    ]);
  });
});

describe("the lease search", () => {
  const rows = leaseRows({
    leases: [
      lease({ id: "lse_alpha" }),
      lease({ deviceId: "dev_a", id: "lse_beta", requesterId: "agent-7" }),
    ],
    now: NOW,
    tokens: [TOKEN],
    workers: [host()],
  });

  it("matches any part of the holder, the device model, the worker's name or the lease id, ignoring case", () => {
    const found = (query: string) => searchLeaseRows(rows, query).map((row) => row.id);

    expect(found("RUNNER")).toEqual(["lse_alpha"]);
    expect(found("agent")).toEqual(["lse_beta"]);
    expect(found("pixel")).toEqual(["lse_beta"]);
    expect(found("iphone 1")).toEqual(["lse_alpha"]);
    expect(found("Mini")).toEqual(["lse_alpha", "lse_beta"]);
    expect(found("SE_BE")).toEqual(["lse_beta"]);
    expect(found("")).toEqual(["lse_alpha", "lse_beta"]);
    expect(found("nothing like it")).toEqual([]);
  });
});
