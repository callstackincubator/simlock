import { describe, expect, it } from "vitest";

import { leaseRows, type LeaseRecord } from "./leases";
import { buildResults, groupStatuses, searchGroups } from "./search";
import { type WaitingRequest, waitingTable } from "./waiting";
import type { WorkerView } from "./workers";

const NOW = Date.parse("2026-10-02T12:00:00Z");

const PAGES = [
  { label: "Overview", path: "/" },
  { label: "Inbox", path: "/inbox" },
  { label: "Fleet", path: "/fleet" },
  { label: "Leases", path: "/leases" },
  { label: "Queue", path: "/queue" },
  { label: "Activity", path: "/activity" },
  { label: "Usage", path: "/usage" },
] as const;

function worker(id: string, label: string, overrides: Partial<WorkerView> = {}): WorkerView {
  return {
    catalog: [],
    connection: "connected",
    devices: [],
    drained: false,
    id,
    label,
    lastSeenAt: NOW,
    leases: [],
    ...overrides,
  };
}

const PHONE = {
  id: "dev_1",
  mode: "full",
  physical: false,
  servesDefaultMode: true,
  spec: { model: "iPhone 17 Pro", osVersion: "26.0", physical: false, platform: "ios" },
  state: "leased",
} as const;

const LEASE = {
  deviceId: "dev_1",
  grantedAt: NOW - 600_000,
  id: "lse_1",
  requesterId: "agent-1",
  ttlDeadline: NOW + 600_000,
  ttlMs: 900_000,
  workerId: "wrk_2",
} as unknown as LeaseRecord;

const REQUEST = {
  createdAt: NOW - 60_000,
  id: "req_1",
  requesterId: "waiter",
  spec: { model: "iPhone 17 Pro", platform: "ios" },
  stage: "queued",
} as unknown as WaitingRequest;

function search(
  typed: string,
  options: {
    readonly workers?: readonly WorkerView[];
    readonly mode?: "gateway" | "worker";
  } = {},
): string[] {
  const workers = options.workers ?? [
    worker("wrk_2", "mac-studio-2", { devices: [PHONE] }),
    worker("wrk_3", "mac-mini-3", { drained: true }),
  ];
  const results = buildResults({
    leases: leaseRows({ leases: [LEASE], now: NOW, tokens: [], workers }),
    mode: options.mode ?? "gateway",
    pages: PAGES,
    requests: waitingTable([REQUEST], workers, NOW).rows,
    workers,
  });
  return searchGroups(results, typed).flatMap((group) =>
    group.results.map((result) => `${group.name}: ${result.label}`),
  );
}

// why: the filter and its order are pure logic with many cases.
describe("the search results", () => {
  it("gives, for every row of the table in the spec, the results it lists", () => {
    expect(search("")).toEqual(PAGES.map((page) => `Pages: ${page.label}`));
    expect(search("fleet")).toEqual(["Pages: Fleet"]);
    expect(search("mac-studio-2")).toEqual([
      "Workers: mac-studio-2",
      "Devices: iPhone 17 Pro · mac-studio-2",
      "Actions: Drain — mac-studio-2",
    ]);
    expect(search("agent-1")).toEqual([
      "Leases: agent-1 · iPhone 17 Pro",
      "Actions: Release lease — agent-1 · iPhone 17 Pro",
    ]);
    expect(search("DRAIN")).toEqual(["Actions: Drain — mac-studio-2"]);
    expect(search("zzz")).toEqual([]);
    expect(search("drain", { mode: "worker" })).toEqual([]);

    const both = [worker("wrk_20", "mac-studio-20"), worker("wrk_2", "mac-studio-2")];
    expect(search("drain mac-studio-2", { workers: both })).toEqual([
      "Actions: Drain — mac-studio-2",
      "Actions: Drain — mac-studio-20",
    ]);
  });
});

describe("a group that is still loading", () => {
  it("lists no results, so Actions and Leases appear only once every read has settled", () => {
    const workers = [worker("wrk_2", "mac-studio-2", { devices: [PHONE] })];
    const results = buildResults({
      leases: leaseRows({ leases: [LEASE], now: NOW, tokens: [], workers }),
      mode: "gateway",
      pages: PAGES,
      requests: waitingTable([REQUEST], workers, NOW).rows,
      workers,
    });
    const groups = searchGroups(
      results,
      "mac-studio-2",
      groupStatuses({
        leases: "ready",
        requests: "loading",
        tokens: "loading",
        workers: "ready",
      }),
    );
    expect(groups.map((group) => [group.name, group.note, group.results.length])).toEqual([
      ["Workers", undefined, 1],
      ["Devices", undefined, 1],
      ["Leases", "Loading…", 0],
      ["Requests", "Loading…", 0],
      ["Actions", "Loading…", 0],
    ]);
  });
});

describe("the order inside a group", () => {
  it("lists results whose typed words are whole label words first, then the rest, each by label", () => {
    const workers = [
      worker("wrk_a", "mac-zed"),
      worker("wrk_b", "zeta mac"),
      worker("wrk_c", "mac-b"),
      worker("wrk_d", "mac-a"),
    ];
    expect(search("mac", { workers }).filter((line) => line.startsWith("Workers:"))).toEqual([
      "Workers: zeta mac",
      "Workers: mac-a",
      "Workers: mac-b",
      "Workers: mac-zed",
    ]);
  });
});
