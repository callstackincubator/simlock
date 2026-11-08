import { describe, expect, it } from "vitest";

import type { BaselineEntry } from "../../../src/contract/index";
import {
  baselineRows,
  diskUse,
  filterBaselineRows,
  groupLabels,
  searchBaselineRows,
} from "./baselines";
import type { WorkerView } from "./workers";

const NOW = Date.parse("2026-11-03T12:00:00Z");

function entry(overrides: Partial<BaselineEntry> = {}): BaselineEntry {
  return {
    mode: "full",
    model: "Pixel 9",
    name: "checkout",
    osVersion: "36",
    platform: "android",
    savedAt: "2026-11-03T10:00:00Z",
    version: 2,
    ...overrides,
  };
}

function worker(id: string, label?: string): WorkerView {
  return {
    catalog: [],
    connection: "connected",
    devices: [],
    drained: false,
    id,
    lastSeenAt: NOW,
    leases: [],
    ...(label === undefined ? {} : { label }),
  };
}

describe("baselineRows", () => {
  it("orders iOS before Android, then by name and worker, and words each row in the console's formats", () => {
    const rows = baselineRows(
      [
        entry({ imageTag: "google_apis", sizeBytes: 4.5 * 2 ** 30, workerId: "w2" }),
        entry({
          name: "login",
          platform: "ios",
          model: "iPhone 17",
          osVersion: "27.0",
          workerId: "w1",
        }),
        entry({ name: "checkout", workerId: "w1", sizeBytes: 300 * 2 ** 20 }),
        entry({ name: "alpha", workerId: "w9" }),
      ],
      [worker("w1", "mac-mini-2"), worker("w2", "mac-studio-1")],
      NOW,
    );
    expect(rows.map((row) => [row.name, row.worker])).toEqual([
      ["login", "mac-mini-2"],
      ["alpha", "w9"],
      ["checkout", "mac-mini-2"],
      ["checkout", "mac-studio-1"],
    ]);
    expect(rows[3]).toMatchObject({
      built: "2 h ago",
      detail: "Pixel 9 / google_apis · Android 36",
      size: "4.5 GiB",
      state: "ready",
    });
    expect(rows[0]).toMatchObject({ detail: "iPhone 17 · iOS 27.0", size: "—" });
    expect(rows[2]?.size).toBe("300 MiB");
  });

  it("marks an entry with a stale reason stale, word for word, and filters and searches before grouping", () => {
    const reason = "runtime com.apple.CoreSimulator.SimRuntime.iOS-27-0 is not installed";
    const rows = baselineRows(
      [entry({ name: "old", platform: "ios", staleReason: reason }), entry({ name: "fresh" })],
      [],
      NOW,
    );
    expect(rows.map((row) => row.staleReason)).toEqual([reason, undefined]);
    expect(filterBaselineRows(rows, "stale").map((row) => row.name)).toEqual(["old"]);
    expect(filterBaselineRows(rows, "ready").map((row) => row.name)).toEqual(["fresh"]);
    expect(filterBaselineRows(rows, "all")).toHaveLength(2);
    expect(searchBaselineRows(filterBaselineRows(rows, "all"), "CORESIMULATOR")).toHaveLength(1);
    expect(searchBaselineRows(rows, "nothing")).toHaveLength(0);
  });

  it("counts a group's matching rows and names the platform and the count, with no size", () => {
    const rows = baselineRows(
      [
        entry({ name: "a", sizeBytes: 2 ** 30 }),
        entry({ name: "b" }),
        entry({ name: "c", platform: "ios", sizeBytes: 2 ** 30 }),
        entry({ name: "d", platform: "ios", sizeBytes: 2 ** 30 }),
      ],
      [],
      NOW,
    );
    expect(groupLabels(rows).get("android")).toBe("Android · 2 baselines");
    expect(groupLabels(rows).get("ios")).toBe("iOS · 2 baselines");
    expect(groupLabels(rows.filter((row) => row.name === "b")).get("android")).toBe(
      "Android · 1 baseline",
    );
  });

  it("measures each worker's baselines against its own disk, never against the fleet's", () => {
    const withDisk = (id: string, label: string, total?: number): WorkerView => ({
      ...worker(id, label),
      ...(total === undefined
        ? {}
        : { load: { disk: { freeBytes: 0, totalBytes: total } } as WorkerView["load"] }),
    });
    const workers = [
      withDisk("w1", "big", 100 * 2 ** 30),
      withDisk("w2", "small", 20 * 2 ** 30),
      withDisk("w3", "none"),
    ];
    const rows = baselineRows(
      [
        entry({ name: "a", sizeBytes: 10 * 2 ** 30, workerId: "w1" }),
        entry({ name: "b", sizeBytes: 10 * 2 ** 30, workerId: "w2" }),
        entry({ name: "c", workerId: "w3" }),
      ],
      workers,
      NOW,
    );
    const use = diskUse(rows, workers);
    expect(use.shares.map((share) => [share.name, share.percent, share.text])).toEqual([
      ["big", 10, "10.0 GiB of 100.0 GiB"],
      ["none", undefined, "size unknown · disk unknown"],
      ["small", 50, "10.0 GiB of 20.0 GiB"],
    ]);
  });
});
